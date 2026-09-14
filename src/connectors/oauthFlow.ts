/**
 * src/connectors/oauthFlow.ts
 *
 * The browser round trip for `oauth-pkce` connectors (MAR-198): open the
 * provider's consent page, catch the callback on the extension's own URI
 * scheme, and exchange the code for tokens.
 *
 * The callback arrives on `vscode://birtalabs.birta-writer/auth/<connector>`,
 * which is a URL anything on the machine can ask VS Code to open. So this
 * module treats every callback as attacker-supplied and proves three things
 * before a code is spent:
 *
 *  - an attempt for that connector is actually in flight. A callback with no
 *    attempt behind it is noise at best and an injected code at worst.
 *  - the `state` matches, compared in constant time. This is the CSRF check:
 *    without it, somebody who can open a URL on this machine could hand us
 *    THEIR authorization code and quietly connect our editor to their account.
 *  - the attempt has not expired.
 *
 * The attempt is consumed before any of that is answered, so a code can be
 * offered once whatever the outcome. A second callback carrying the same state
 * finds nothing in flight and is refused, which is what stops a replay.
 *
 * The verifier never leaves this process. It is minted here, held in memory
 * only, spent once at the token endpoint and dropped. It is never written to
 * SecretStorage, never logged, and never included in the authorize URL.
 */
import * as vscode from "vscode";
import { fetchConnectorCard } from "./fetchCard";
import {
    createAttempt,
    authorizeUrl,
    stateMatches,
    tokenRequestBody,
    readTokenResponse,
    type PkceAttempt,
    type TokenSet,
} from "./pkce";
import { CONNECTORS, type ConnectorId, type ConnectorSpec } from "../../shared/connectors";

/** The publisher.name pair the callback URL is addressed to. */
const EXTENSION_ID = "birtalabs.birta-writer";

/** How the flow ended, in terms the connect command can put on screen. */
export type AuthorizeOutcome =
    | { ok: true; tokens: TokenSet }
    /** The user closed the browser or refused consent: no error, no toast. */
    | { ok: false; reason: "cancelled" }
    /** The provider said no, or the callback failed its checks. */
    | { ok: false; reason: "refused" }
    /** The exchange could not be completed. */
    | { ok: false; reason: "network" };

interface Pending {
    readonly attempt: PkceAttempt;
    readonly settle: (uri: vscode.Uri | null) => void;
}

export class OAuthFlow {
    private pending = new Map<ConnectorId, Pending>();

    /**
     * Start listening for callbacks. Returns the disposable the extension's
     * subscriptions own.
     *
     * One handler for every connector, dispatching on the path, because VS Code
     * permits a single URI handler per extension.
     */
    register(): vscode.Disposable {
        return vscode.window.registerUriHandler({
            handleUri: (uri: vscode.Uri): void => {
                const id = this.connectorForPath(uri.path);
                if (!id) {
                    return;
                }
                // Consumed here, before the state is even read: whatever this
                // callback turns out to be, the attempt it names is spent, so a
                // second one carrying the same state finds nothing.
                const waiting = this.pending.get(id);
                this.pending.delete(id);
                waiting?.settle(uri);
            },
        });
    }

    /**
     * `/auth/<connector>` and nothing else.
     *
     * An unknown path is ignored rather than treated as an error, because this
     * handler sees every `vscode://birtalabs.birta-writer/...` URL anything on
     * the machine opens, and most of them will not be ours.
     */
    private connectorForPath(path: string): ConnectorId | null {
        const parts = path.split("/").filter((p) => p.length > 0);
        if (parts.length !== 2 || parts[0] !== "auth") {
            return null;
        }
        const id = parts[1];
        return Object.prototype.hasOwnProperty.call(CONNECTORS, id)
            ? (id as ConnectorId)
            : null;
    }

    /** The callback URL this connector's consent page is told to return to. */
    static redirectUri(id: ConnectorId): string {
        return `vscode://${EXTENSION_ID}/auth/${id}`;
    }

    /**
     * Run the whole round trip and return tokens, or why not.
     *
     * The wait is bounded by the attempt's own TTL rather than by a separate
     * timer, so the deadline the callback is checked against and the deadline
     * the wait gives up on are the same number.
     */
    async authorize(spec: ConnectorSpec, scopes: readonly string[]): Promise<AuthorizeOutcome> {
        if (spec.auth !== "oauth-pkce" || !spec.oauth) {
            return { ok: false, reason: "refused" };
        }
        // One attempt per connector at a time. A second Connect while one is in
        // flight abandons the first rather than leaving two states that both
        // look valid.
        this.pending.get(spec.id)?.settle(null);

        const attempt = createAttempt();
        const redirectUri = OAuthFlow.redirectUri(spec.id);
        const callback = new Promise<vscode.Uri | null>((resolve) => {
            this.pending.set(spec.id, { attempt, settle: resolve });
        });

        const opened = await vscode.env.openExternal(
            vscode.Uri.parse(authorizeUrl(spec, redirectUri, attempt, scopes)),
        );
        if (!opened) {
            this.pending.delete(spec.id);
            return { ok: false, reason: "cancelled" };
        }

        const timer = new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), Math.max(0, attempt.expiresAt - Date.now()));
        });
        const uri = await Promise.race([callback, timer]);
        // Whichever won, nothing is left in flight for this connector.
        this.pending.delete(spec.id);
        if (!uri) {
            return { ok: false, reason: "cancelled" };
        }

        const query = new URLSearchParams(uri.query);
        // A provider that refuses says so in the callback rather than by not
        // arriving, and `access_denied` is the user declining consent, which is
        // a cancellation rather than a failure worth a message.
        const error = query.get("error");
        if (error) {
            return { ok: false, reason: error === "access_denied" ? "cancelled" : "refused" };
        }
        const code = query.get("code");
        const state = query.get("state");
        if (!code || !state || !stateMatches(attempt.state, state)) {
            return { ok: false, reason: "refused" };
        }
        if (Date.now() > attempt.expiresAt) {
            return { ok: false, reason: "cancelled" };
        }

        return this.exchange(spec, attempt, code, redirectUri);
    }

    /**
     * Trade a refresh token for a fresh access token.
     *
     * Same pinned path as the exchange, and the same absence of a client
     * secret. Never called speculatively: only when an expiry the provider
     * named has actually passed.
     */
    async refresh(spec: ConnectorSpec, refreshToken: string): Promise<AuthorizeOutcome> {
        if (spec.auth !== "oauth-pkce" || !spec.oauth) {
            return { ok: false, reason: "refused" };
        }
        const body = tokenRequestBody(spec, { kind: "refresh", refreshToken });
        const outcome = await fetchConnectorCard(
            spec, spec.oauth.tokenUrl, null, { kind: "form", value: body },
        );
        if (outcome.state !== "ok") {
            return { ok: false, reason: outcome.state === "expired" ? "refused" : "network" };
        }
        const tokens = readTokenResponse(outcome.body, Date.now());
        return tokens.ok ? { ok: true, tokens: tokens.tokens } : { ok: false, reason: "refused" };
    }

    /**
     * Spend the code at the token endpoint.
     *
     * Through `fetchConnectorCard`, which is the one site that puts a request on
     * a connector's pinned host: https only, host pinned, SSRF guarded, no
     * redirects followed. The token endpoint is a pinned `apiHost` like any
     * other, so an exchange cannot be redirected somewhere the pin never
     * approved.
     *
     * No credential is attached, because there is none to attach: the verifier
     * travels in the body and a public client has no secret.
     */
    private async exchange(
        spec: ConnectorSpec,
        attempt: PkceAttempt,
        code: string,
        redirectUri: string,
    ): Promise<AuthorizeOutcome> {
        const body = tokenRequestBody(spec, {
            kind: "code", code, verifier: attempt.verifier, redirectUri,
        });
        const outcome = await fetchConnectorCard(
            spec, spec.oauth!.tokenUrl, null, { kind: "form", value: body },
        );
        if (outcome.state !== "ok") {
            return { ok: false, reason: outcome.state === "expired" ? "refused" : "network" };
        }
        const tokens = readTokenResponse(outcome.body, Date.now());
        return tokens.ok ? { ok: true, tokens: tokens.tokens } : { ok: false, reason: "refused" };
    }
}
