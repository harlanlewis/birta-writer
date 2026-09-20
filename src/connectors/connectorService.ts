/**
 * src/connectors/connectorService.ts
 *
 * The extension-side connector service (MAR-198): credential custody, the
 * per-provider auth strategy seam, and the resolve round-trip that turns a
 * recognized embed URL into sanitized card JSON.
 *
 * This is rung 2 of docs/NETWORK_POSTURE.md, and every invariant it names is
 * enforced here rather than described:
 *
 *  - Credentials live in `SecretStorage` and nowhere else. Nothing in this
 *    module writes a setting, and the only value that crosses to the webview
 *    is an EmbedCardResult, which has no field a token could occupy.
 *  - The webview posts a URL, never a request. The URL only SELECTS a
 *    connector: it is re-recognized here, and the outgoing request is rebuilt
 *    by `connectorApiRequest` from parts the recognizer validated. An
 *    unrecognized URL, a provider with no connector, and a shape with no API
 *    card all fetch nothing.
 *  - The credential goes to that connector's pinned `apiHosts` and nowhere
 *    else, checked at the fetch site as well as at the build site, and never
 *    across a redirect (`redirect: "manual"`, any 3xx is a failure).
 *  - Connecting is a deliberate act, recorded here. A `builtin` connector must
 *    NOT inherit consent from a VS Code session the user signed in for some
 *    other extension's sake: without our own record, resolve answers `locked`
 *    and makes no request. That record is what "per-service connect", the
 *    innermost layer of the consent ladder, actually is.
 *
 * Caching (invariant 10): in-memory, per extension-host session, promises
 * cached so concurrent identical resolves dedupe. Failures are cached too, on
 * the same reasoning as the oEmbed cache: a card that could not be built is
 * asked about once per session, not once per reopen. Connecting or
 * disconnecting drops the whole cache, so a fresh grant takes effect at once.
 */
import * as vscode from "vscode";
import { readBirtaSetting } from "../config";
import { reportError } from "../errorSink";
import { embedProviderEnabled, recognizeEmbed, type EmbedMatch } from "../../shared/embedProviders";
import {
    connectorApiRequest,
    CONNECTORS,
    type ConnectorId,
    type ConnectorSpec,
    type EmbedCardData,
    type EmbedCardResult,
} from "../../shared/connectors";
import { fetchConnectorCard } from "./fetchCard";
import { asanaCard } from "./asana";
import { githubCard } from "./github";
import { linearCard } from "./linear";
import { OAuthFlow } from "./oauthFlow";

/**
 * Refresh this far ahead of a known expiry.
 *
 * A token that expires while a request is in flight reads as a revoked grant,
 * so the window is wide enough to cover a slow round trip rather than tuned to
 * anything. It is not a guess about clock skew: the expiry is computed from our
 * own clock at the moment the token arrived, so the two clocks are the same one.
 */
const OAUTH_REFRESH_SKEW_MS = 60_000;

/** Secret key for one connector's record. Namespaced so nothing else collides. */
function secretKey(id: ConnectorId): string {
    return `birta.connector.${id}`;
}

/**
 * What SecretStorage holds for a connected service.
 *
 * For a `builtin` connector the record carries no token at all: VS Code owns
 * the session and refreshes it, so storing a copy would be a second, staler
 * credential to leak. The record's only job there is to say the user connected
 * THIS service to Birta, which is a fact VS Code's session store cannot answer.
 */
interface ConnectorRecord {
    auth: ConnectorSpec["auth"];
    /** Present only for `token` and `oauth-pkce` strategies. */
    token?: string;
    /**
     * The refresh token, for `oauth-pkce` and only when the provider issued
     * one. Absent means the access token is all there is, and its expiry is
     * the end of the connection rather than a thing to recover from.
     */
    refreshToken?: string;
    /**
     * When the access token stops being usable, in epoch ms.
     *
     * Absent means the provider named no expiry, which is not the same as "it
     * never expires": it means we were told nothing, so the only way to learn
     * the grant is gone is a 401, which `fetchConnectorCard` already turns into
     * `expired`. Refresh is attempted ahead of a KNOWN expiry and never
     * speculatively.
     */
    expiresAt?: number;
    /**
     * The user opted into the broader grant that reads private resources.
     * Absent or false means the connection is the public, read-only one, which
     * is the default and is all most links need.
     */
    privateAccess?: boolean;
}

/** Per-card-shape response mappers, keyed by connector. */
const CARD_BUILDERS: Record<ConnectorId, (match: EmbedMatch, body: unknown) => EmbedCardData | null> = {
    github: githubCard,
    linear: linearCard,
    asana: asanaCard,
};

export class ConnectorService {
    private cache = new Map<string, Promise<EmbedCardResult | null>>();
    /** Connected-state mirror, so the hot path avoids a keychain read per card. */
    private connected = new Map<ConnectorId, boolean>();
    /**
     * Token renewals in flight, one per connector, so concurrent resolves of
     * different cards share a renewal instead of racing each other into
     * spending the same refresh token twice. Holds promises, never credentials.
     */
    private renewing = new Map<ConnectorId, Promise<string | null>>();

    /**
     * The browser round trip, injectable so a test drives connect and refresh
     * without a network or a real VS Code URI handler.
     */
    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly flow: OAuthFlow = new OAuthFlow(),
    ) {}

    /** Has the user connected this service to Birta? */
    async isConnected(id: ConnectorId): Promise<boolean> {
        const cached = this.connected.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const record = await this.readRecord(id);
        const live = record !== null;
        this.connected.set(id, live);
        return live;
    }

    /**
     * Does this connection already hold the broader, private-reading grant?
     * False for a service connected on the default public tier, which is what
     * makes an upgrade a thing the connect flow can still offer.
     */
    async hasPrivateAccess(id: ConnectorId): Promise<boolean> {
        return (await this.readRecord(id))?.privateAccess === true;
    }

    /** The connected-state map the webview needs to render locked cards. */
    async connectionStates(): Promise<Record<string, boolean>> {
        const entries = await Promise.all(
            (Object.keys(CONNECTORS) as ConnectorId[]).map(
                async (id) => [id, await this.isConnected(id)] as const,
            ),
        );
        return Object.fromEntries(entries);
    }

    /**
     * Run the connect flow for one service: acquire consent through its
     * strategy, verify the credential with one real call, and only then record
     * the connection. Verifying before recording is what keeps the connected
     * state honest — a grant the provider will not honour must never present
     * itself as a working connection.
     *
     * Returns null when the user cancelled (no error, no toast, no record).
     */
    async connect(
        id: ConnectorId,
        opts: { includePrivate?: boolean } = {},
    ): Promise<{ ok: boolean; message?: string } | null> {
        const spec = CONNECTORS[id];
        // The broader grant is requested only when the user asked for it. For
        // GitHub the difference is not cosmetic: the default is a scopeless,
        // read-only, public-information token, and the opt-in is `repo`, which
        // GitHub does not offer in a read-only form at all.
        const includePrivate = opts.includePrivate === true && spec.privateScopes !== undefined;
        const scopes = includePrivate ? spec.privateScopes! : spec.scopes;
        // Connecting ends in a verify call, so it is a network act and the
        // master switch governs it like any other. Refusing here rather than
        // in the command keeps the guarantee at the site that would break it.
        if (!readBirtaSetting("networkEnabled")) {
            return {
                ok: false,
                message: vscode.l10n.t("Turn on birta.network.enabled first: Birta is offline by default."),
            };
        }
        if (spec.auth === "oauth-pkce") {
            return this.connectViaOAuth(spec, scopes);
        }
        if (spec.auth === "token") {
            return this.connectViaToken(spec);
        }
        let session: vscode.AuthenticationSession | undefined;
        try {
            session = await vscode.authentication.getSession(
                spec.builtinProviderId ?? spec.id,
                [...scopes],
                { createIfNone: true },
            );
        } catch {
            // The user dismissed the consent dialog, or the provider refused.
            return null;
        }
        if (!session) {
            return null;
        }
        // One real call before the connection is recorded. A grant the
        // provider will not honour must never present itself as a working
        // connection, and this is the only moment the user is waiting on us
        // and can be told plainly that it did not work.
        const check = await fetchConnectorCard(spec, spec.verifyUrl, session.accessToken);
        if (check.state !== "ok") {
            return {
                ok: false,
                message: check.state === "expired"
                    ? vscode.l10n.t("{0} rejected that sign-in.", spec.label)
                    : vscode.l10n.t("Could not reach {0} to confirm the connection.", spec.label),
            };
        }
        await this.writeRecord(id, { auth: spec.auth, ...(includePrivate ? { privateAccess: true } : {}) });
        return { ok: true };
    }

    /** Forget a connection: delete the record, drop every cached card. */
    async disconnect(id: ConnectorId): Promise<void> {
        await this.secrets.delete(secretKey(id));
        this.connected.set(id, false);
        this.cache.clear();
    }

    /**
     * Resolve one embed URL to a card, or null when this URL has no
     * authenticated rung at all (unrecognized, no connector, a shape the API
     * cannot improve, or a closed consent gate). Null means "leave the rung-0
     * card exactly as it is" — the webview renders no connector chrome for it.
     *
     * Never throws: a resolve is decoration, and a failure is a named state.
     */
    resolveCard(url: string): Promise<EmbedCardResult | null> {
        // Defense in depth (MAR-179): the webview does not post when a gate is
        // closed; both are re-checked so a stale or rogue message cannot fetch.
        // Checked BEFORE the cache so a disabled feature costs nothing and a
        // later enable is not poisoned by cached "gate closed" nulls.
        if (!readBirtaSetting("networkEnabled") || !readBirtaSetting("embedsEnabled")) {
            return Promise.resolve(null);
        }
        const match = recognizeEmbed(url);
        if (!match) {
            return Promise.resolve(null);
        }
        if (!embedProviderEnabled(match.kind, readBirtaSetting("embedProviders"))) {
            return Promise.resolve(null);
        }
        const request = connectorApiRequest(match);
        if (!request) {
            return Promise.resolve(null);
        }
        const key = `${request.connector}:${match.kind}:${match.id}`;
        const hit = this.cache.get(key);
        if (hit) {
            return hit;
        }
        const pending = this.resolveUncached(match, request.connector, request.url, request.body).catch((e) => {
            reportError("resolveEmbedCard", e);
            return { state: "error", connector: request.connector } as EmbedCardResult;
        });
        this.cache.set(key, pending);
        return pending;
    }

    private async resolveUncached(
        match: EmbedMatch,
        id: ConnectorId,
        requestUrl: string,
        requestBody?: unknown,
    ): Promise<EmbedCardResult> {
        const spec = CONNECTORS[id];
        const record = await this.readRecord(id);
        this.connected.set(id, record !== null);

        // A card for a PUBLIC resource needs no credential, and most links are
        // public. Reading anonymously when there is no connection is what makes
        // connecting an upgrade rather than an entry fee: the consent layers
        // above (network, embeds, this provider) already governed whether to
        // ask GitHub anything at all, and they are the layers the user set.
        let token: string | null = null;
        if (record) {
            token = await this.credential(spec, record);
            if (!token) {
                return { state: "expired", connector: id };
            }
        } else if (!spec.anonymousReads) {
            // Nothing to ask and nobody to ask it of. Returning `locked` here
            // rather than letting the request fail is the difference between a
            // card that says "connect" and one that says "reconnect" to
            // somebody who never connected, and it keeps the document's ids
            // off the wire for a request that could only 401.
            return { state: "locked", connector: id };
        }

        const outcome = await fetchConnectorCard(
            spec,
            requestUrl,
            token,
            requestBody === undefined ? undefined : { kind: "json", value: requestBody },
        );
        if (outcome.state === "notFound") {
            // Not visible to whoever just asked. A broader grant may fix it —
            // GitHub answers 404 for a private repository precisely so an
            // anonymous caller learns nothing — so offer the connection when
            // one is still available, and call it an error when the user
            // already holds the broadest grant this connector has.
            const canUpgrade = !record || (spec.privateScopes !== undefined && record.privateAccess !== true);
            return { state: canUpgrade ? "locked" : "error", connector: id };
        }
        if (outcome.state !== "ok") {
            return { state: outcome.state, connector: id };
        }
        const card = CARD_BUILDERS[id](match, outcome.body);
        return card ? { state: "ready", connector: id, card } : { state: "error", connector: id };
    }

    /**
     * Connect by paste: open the provider's own instructions, take a token,
     * verify it, record it.
     *
     * The browser is opened BEFORE the box is shown, not after and not
     * instead. Opening it afterwards would steal focus from a box the user is
     * standing in, and not opening it at all would ask for a credential
     * without saying where one comes from. It is the same gesture the OAuth
     * rung makes one rung up, and it carries nothing: the page is the
     * provider's public documentation, reached on the user's own browser,
     * which is rung 0b of the posture rather than rung 2.
     *
     * `ignoreFocusOut` is load-bearing rather than a nicety. Minting a token
     * means leaving VS Code, and the default box closes the moment focus does,
     * so without it the flow cannot be completed by anyone who did not already
     * have a token on the clipboard.
     *
     * Nothing is written before the verify passes, so a refused token leaves
     * no record behind, and the paste never reaches a setting or a log.
     */
    private async connectViaToken(
        spec: ConnectorSpec,
    ): Promise<{ ok: boolean; message?: string } | null> {
        if (spec.tokenHelpUrl) {
            await vscode.env.openExternal(vscode.Uri.parse(spec.tokenHelpUrl));
        }
        const pasted = await vscode.window.showInputBox({
            title: vscode.l10n.t("Connect {0}", spec.label),
            // The full cost of the credential, at the moment the user is
            // deciding to hand it over. This is the token rung's equivalent of
            // the tier picker's disclosure, and it is the only place it can go:
            // there is no consent screen of ours after this, and the
            // provider's own page does not know what Birta will do.
            prompt: vscode.l10n.t(
                "Paste a personal access token. Birta keeps it in your keychain, never in settings.",
            ) + (spec.scopeNote ? ` ${spec.scopeNote}` : ""),
            placeHolder: vscode.l10n.t("Personal access token"),
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) =>
                value.trim().length > 0
                    ? null
                    : vscode.l10n.t("Paste a token, or press Escape to cancel."),
        });
        // Dismissed, or submitted empty against the validator. Either way the
        // user did not offer a credential, and a deliberate no gets silence.
        const token = pasted?.trim();
        if (!token) {
            return null;
        }
        // One real call before the connection is recorded, the same as the
        // other two rungs: a token the provider will not honour must never
        // present itself as a working connection, and this is the one moment
        // the user is waiting on us and can be told plainly that it did not
        // work.
        const check = await fetchConnectorCard(spec, spec.verifyUrl, token);
        if (check.state !== "ok") {
            return {
                ok: false,
                message: check.state === "expired"
                    // Named for what the user can act on. The token was pasted
                    // a moment ago, so "expired" would send them to renew
                    // something that was never accepted; what happened is that
                    // the provider does not honour this string.
                    ? vscode.l10n.t("{0} rejected that token.", spec.label)
                    : vscode.l10n.t("Could not reach {0} to confirm the connection.", spec.label),
            };
        }
        await this.writeRecord(spec.id, { auth: spec.auth, token });
        return { ok: true };
    }

    /**
     * Connect through the browser: consent, callback, exchange, verify, record.
     *
     * The verify is the same one `builtin` does and for the same reason: a
     * grant the provider will not honour must never present itself as a working
     * connection. It is the one moment the user is waiting and can be told
     * plainly that it did not work.
     *
     * Nothing is written before the verify passes, so a failed connect leaves
     * no record and no token behind.
     */
    private async connectViaOAuth(
        spec: ConnectorSpec,
        scopes: readonly string[],
    ): Promise<{ ok: boolean; message?: string } | null> {
        const authorized = await this.flow.authorize(spec, scopes);
        if (!authorized.ok) {
            // A cancellation is silent by design: the user closed the browser
            // or declined, and neither is news.
            if (authorized.reason === "cancelled") {
                return null;
            }
            return {
                ok: false,
                message: authorized.reason === "refused"
                    ? vscode.l10n.t("{0} refused that sign-in.", spec.label)
                    : vscode.l10n.t("Could not reach {0} to complete the sign-in.", spec.label),
            };
        }

        const check = await fetchConnectorCard(
            spec,
            spec.verifyUrl,
            authorized.tokens.accessToken,
            // Linear's verify endpoint is its GraphQL one, which answers POST
            // only, so the cheapest authenticated call is a query rather than a
            // GET. `viewer` is that call: it names no document and reads one id.
            { kind: "json", value: { query: "{ viewer { id } }" } },
        );
        if (check.state !== "ok") {
            return {
                ok: false,
                message: check.state === "expired"
                    ? vscode.l10n.t("{0} rejected that sign-in.", spec.label)
                    : vscode.l10n.t("Could not reach {0} to confirm the connection.", spec.label),
            };
        }

        await this.writeRecord(spec.id, {
            auth: spec.auth,
            token: authorized.tokens.accessToken,
            ...(authorized.tokens.refreshToken !== undefined
                ? { refreshToken: authorized.tokens.refreshToken }
                : {}),
            ...(authorized.tokens.expiresAt !== undefined
                ? { expiresAt: authorized.tokens.expiresAt }
                : {}),
        });
        return { ok: true };
    }

    /**
     * The bearer token for a live connection, or null when the grant is gone.
     * Null is the `expired` state: the user connected once, and the provider
     * will not honour that connection now.
     */
    private async credential(spec: ConnectorSpec, record: ConnectorRecord): Promise<string | null> {
        if (spec.auth === "oauth-pkce") {
            return this.oauthCredential(spec, record);
        }
        if (spec.auth !== "builtin") {
            return record.token ?? null;
        }
        // `silent` matters: a resolve is decoration that runs on idle without
        // the user asking for it, so it must never raise a sign-in prompt or
        // an account badge. A gone session simply answers `expired`, and the
        // card's reconnect affordance is where the user chooses to act.
        const session = await vscode.authentication.getSession(
            spec.builtinProviderId ?? spec.id,
            // The scopes the connection was actually made with. Asking for the
            // broader set here would silently fail to match a public-only
            // connection's session and read as `expired`.
            [...(record.privateAccess === true && spec.privateScopes ? spec.privateScopes : spec.scopes)],
            { silent: true },
        );
        return session?.accessToken ?? null;
    }

    /**
     * The access token for an `oauth-pkce` connection, refreshed if it is known
     * to have lapsed and a refresh token exists.
     *
     * Refresh happens only against a KNOWN expiry, never speculatively: a
     * provider that named no `expires_in` gets its token used until something
     * answers 401, which is already the `expired` state. Refreshing on a guess
     * would spend a refresh token to solve a problem nobody reported.
     *
     * A refresh that fails is `expired` rather than an error, because from the
     * user's side those are the same fact and only one of them is actionable:
     * reconnect.
     */
    private async oauthCredential(
        spec: ConnectorSpec,
        record: ConnectorRecord,
    ): Promise<string | null> {
        const stillGood = record.expiresAt === undefined
            || Date.now() < record.expiresAt - OAUTH_REFRESH_SKEW_MS;
        if (stillGood) {
            return record.token ?? null;
        }
        if (!record.refreshToken) {
            return null;
        }
        // One renewal per connector at a time, and every concurrent resolve
        // waits on the same one.
        //
        // The resolve cache dedupes by CARD, so two different issue links in a
        // document are two independent resolves that read the same lapsed
        // record in the same turn. Renewing once each is not merely wasteful:
        // against a provider that rotates its refresh token, the second spends
        // one the first already invalidated, so a card reads `expired` while
        // the connection is fine, and the two writes race over which record
        // survives. Measured at two calls before this existed.
        //
        // Keyed by connector rather than by the refresh token, which would be
        // a second place a credential lives. The renewal writes its record
        // before it settles, so a resolve arriving after the entry is dropped
        // reads the fresh record and asks for nothing.
        const inFlight = this.renewing.get(spec.id);
        if (inFlight) {
            return inFlight;
        }
        const pending = this.renew(spec, record.refreshToken);
        this.renewing.set(spec.id, pending);
        try {
            return await pending;
        } finally {
            this.renewing.delete(spec.id);
        }
    }

    /**
     * Spend a refresh token and record what came back, or null when the
     * provider would not renew.
     *
     * Nothing is written on a failure. A record carrying a fresh access token
     * beside a spent refresh token, or one whose refresh token was cleared, is
     * unrecoverable without reconnecting and would not say so, which is worse
     * than the `expired` card a null produces.
     */
    private async renew(spec: ConnectorSpec, refreshToken: string): Promise<string | null> {
        const refreshed = await this.flow.refresh(spec, refreshToken);
        if (!refreshed.ok) {
            return null;
        }
        // A disconnect may have landed while the provider was answering.
        // Writing now would resurrect a credential the user just deleted, and
        // "disconnecting deletes it" is a promise rather than a tendency.
        if (await this.readRecord(spec.id) === null) {
            return null;
        }
        await this.writeRecord(spec.id, {
            auth: spec.auth,
            token: refreshed.tokens.accessToken,
            // The provider may or may not rotate. Keeping the one just spent
            // when none comes back is what makes a non-rotating provider work;
            // overwriting with undefined would end the connection at the next
            // expiry for no reason. One of the two always exists, because a
            // renewal is only attempted while holding a refresh token.
            refreshToken: refreshed.tokens.refreshToken ?? refreshToken,
            ...(refreshed.tokens.expiresAt !== undefined
                ? { expiresAt: refreshed.tokens.expiresAt }
                : {}),
        });
        return refreshed.tokens.accessToken;
    }

    private async readRecord(id: ConnectorId): Promise<ConnectorRecord | null> {
        let raw: string | undefined;
        try {
            raw = await this.secrets.get(secretKey(id));
        } catch (e) {
            // A locked or unavailable keychain reads as "not connected", which
            // degrades to a locked card rather than to an unhandled rejection.
            reportError("connectorRecord", e);
            return null;
        }
        if (!raw) {
            return null;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            const auth = (parsed as { auth?: unknown } | null)?.auth;
            if (auth !== "builtin" && auth !== "oauth-pkce" && auth !== "token") {
                return null;
            }
            const token = (parsed as { token?: unknown }).token;
            const refreshToken = (parsed as { refreshToken?: unknown }).refreshToken;
            const expiresAt = (parsed as { expiresAt?: unknown }).expiresAt;
            const privateAccess = (parsed as { privateAccess?: unknown }).privateAccess;
            // Every field `writeRecord` stores is read back here. A field
            // written and not read is not a smaller record, it is a silently
            // disabled feature: `refreshToken` and `expiresAt` were stored by
            // the OAuth connect and dropped here, which left `expiresAt`
            // permanently undefined, so `oauthCredential` always took its
            // still-good branch and no refresh could ever run.
            //
            // `expiresAt` is typed rather than taken on trust: a keychain value
            // is JSON somebody else could have written, and a non-number there
            // would make the comparison against `Date.now()` answer false and
            // refresh on every single resolve.
            return {
                auth,
                ...(typeof token === "string" ? { token } : {}),
                ...(typeof refreshToken === "string" ? { refreshToken } : {}),
                ...(typeof expiresAt === "number" && Number.isFinite(expiresAt)
                    ? { expiresAt }
                    : {}),
                ...(privateAccess === true ? { privateAccess: true } : {}),
            };
        } catch {
            return null;
        }
    }

    private async writeRecord(id: ConnectorId, record: ConnectorRecord): Promise<void> {
        await this.secrets.store(secretKey(id), JSON.stringify(record));
        this.connected.set(id, true);
        this.cache.clear();
    }
}
