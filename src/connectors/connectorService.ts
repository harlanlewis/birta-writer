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
import { githubCard } from "./github";

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
    /** Present only for `token` (and future `oauth-pkce`) strategies. */
    token?: string;
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
};

export class ConnectorService {
    private cache = new Map<string, Promise<EmbedCardResult | null>>();
    /** Connected-state mirror, so the hot path avoids a keychain read per card. */
    private connected = new Map<ConnectorId, boolean>();

    constructor(private readonly secrets: vscode.SecretStorage) {}

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
        if (spec.auth !== "builtin") {
            // The seam admits `oauth-pkce` and `token`, and no provider has
            // shipped on either yet. Refusing loudly beats a half-path.
            return { ok: false, message: vscode.l10n.t("{0} cannot be connected yet.", spec.label) };
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
        const pending = this.resolveUncached(match, request.connector, request.url).catch((e) => {
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
        }

        const outcome = await fetchConnectorCard(spec, requestUrl, token);
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
     * The bearer token for a live connection, or null when the grant is gone.
     * Null is the `expired` state: the user connected once, and the provider
     * will not honour that connection now.
     */
    private async credential(spec: ConnectorSpec, record: ConnectorRecord): Promise<string | null> {
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
            const privateAccess = (parsed as { privateAccess?: unknown }).privateAccess;
            return {
                auth,
                ...(typeof token === "string" ? { token } : {}),
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
