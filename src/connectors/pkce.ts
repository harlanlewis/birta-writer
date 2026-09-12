/**
 * src/connectors/pkce.ts
 *
 * OAuth 2.0 Authorization Code with PKCE (RFC 7636), for connectors whose
 * `auth` is `oauth-pkce`. Extension side only: this module mints and holds
 * secrets, so the webview must never import it.
 *
 * PKCE is what makes a public client shippable. The extension is distributed
 * to everyone, so it can hold no client secret; the verifier takes the secret's
 * place and is minted fresh per attempt, never stored, and never leaves this
 * process except as its own SHA-256 hash. That is the whole reason MAR-198's
 * hard constraint against a hosted auth broker is satisfiable: there is no
 * secret that would need a server to hold it.
 *
 * What is deliberately NOT here: `plain` as a challenge method. RFC 7636
 * permits it for clients that cannot hash, and every client this runs in can
 * hash, so offering it would only add a downgrade an attacker could ask for.
 * `S256` is the only value this module will emit or accept.
 *
 * Reached by tests and by no shipped provider yet. `CONNECTORS` has no
 * `oauth-pkce` row until a client id is registered, which is the maintainer's
 * act and not something a session can do. That is a known and temporary state,
 * not an oversight: the flow is held by `pkce.test.ts` against a fake
 * authorization server, and the first real row makes it reachable by a user.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { ConnectorSpec } from "../../shared/connectors";

/** How long an unfinished authorization stays acceptable. */
export const PKCE_ATTEMPT_TTL_MS = 5 * 60 * 1000;

/**
 * The verifier's length in bytes before base64url encoding. RFC 7636 requires
 * the encoded verifier to be 43 to 128 characters; 32 bytes encodes to 43,
 * which is the floor, and the floor is 256 bits of entropy. Going higher buys
 * nothing a 256-bit secret does not already have.
 */
const VERIFIER_BYTES = 32;

/** One authorization attempt's secrets. Never persisted, never logged. */
export interface PkceAttempt {
    /** The one-time secret proving the token request is the same client. */
    readonly verifier: string;
    /** `BASE64URL(SHA256(verifier))`, the only thing that leaves the process. */
    readonly challenge: string;
    /** CSRF nonce echoed by the provider, checked on the way back. */
    readonly state: string;
    /** When this attempt stops being acceptable. */
    readonly expiresAt: number;
}

/** RFC 4648 §5 base64url, unpadded, which is what RFC 7636 requires. */
function base64url(bytes: Buffer): string {
    return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint one attempt.
 *
 * `now` and `random` are injected so a test can pin both without reaching for
 * fake timers or module mocks, which is the same seam `saveFlushController`
 * uses for its timeout.
 */
export function createAttempt(
    now: () => number = Date.now,
    random: (n: number) => Buffer = randomBytes,
): PkceAttempt {
    const verifier = base64url(random(VERIFIER_BYTES));
    return {
        verifier,
        challenge: base64url(createHash("sha256").update(verifier).digest()),
        state: base64url(random(VERIFIER_BYTES)),
        expiresAt: now() + PKCE_ATTEMPT_TTL_MS,
    };
}

/**
 * The provider's consent page, for `vscode.env.openExternal`.
 *
 * Built with `URL` rather than string concatenation so every value is encoded
 * once and correctly, and so a spec whose `authorizeUrl` already carried a
 * query cannot have it silently dropped.
 */
export function authorizeUrl(
    spec: ConnectorSpec,
    redirectUri: string,
    attempt: PkceAttempt,
    scopes: readonly string[],
): string {
    const oauth = requireOAuth(spec);
    const url = new URL(oauth.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", attempt.state);
    url.searchParams.set("code_challenge", attempt.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "));
    }
    return url.href;
}

function requireOAuth(spec: ConnectorSpec): NonNullable<ConnectorSpec["oauth"]> {
    if (spec.auth !== "oauth-pkce" || !spec.oauth) {
        // A programming error rather than a runtime condition: the caller
        // picked a spec whose strategy is not this one.
        throw new Error(`connector ${spec.id} is not an oauth-pkce connector`);
    }
    return spec.oauth;
}

/**
 * Whether a callback's `state` is the one this attempt sent.
 *
 * Compared in constant time. The comparison is not a password check, but it is
 * a secret-versus-attacker-supplied comparison on a path an attacker can call
 * repeatedly, and `===` on strings leaks a prefix through timing. The length
 * check before it is not a leak: both values are fixed-length by construction,
 * so a length mismatch is not an oracle for anything.
 */
export function stateMatches(expected: string, received: string): boolean {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(received, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

/** What a provider returns from the token endpoint, once validated. */
export interface TokenSet {
    readonly accessToken: string;
    readonly refreshToken?: string;
    /** Absolute epoch ms, or undefined when the provider names no expiry. */
    readonly expiresAt?: number;
}

export type TokenOutcome =
    | { readonly ok: true; readonly tokens: TokenSet }
    | { readonly ok: false; readonly reason: "network" | "refused" | "malformed" };

/**
 * The body every exchange posts, with the client secret deliberately absent.
 *
 * Separated from the request so a test can assert what is sent without a
 * server. Its most important property is a negative one, which is why it is
 * worth asserting directly: no `client_secret` key, on either grant.
 */
export function tokenRequestBody(
    spec: ConnectorSpec,
    grant: { kind: "code"; code: string; verifier: string; redirectUri: string }
        | { kind: "refresh"; refreshToken: string },
): URLSearchParams {
    const oauth = requireOAuth(spec);
    const body = new URLSearchParams();
    body.set("client_id", oauth.clientId);
    if (grant.kind === "code") {
        body.set("grant_type", "authorization_code");
        body.set("code", grant.code);
        body.set("code_verifier", grant.verifier);
        body.set("redirect_uri", grant.redirectUri);
    } else {
        body.set("grant_type", "refresh_token");
        body.set("refresh_token", grant.refreshToken);
    }
    return body;
}

/**
 * Read a provider's token response into a `TokenSet`.
 *
 * Deliberately strict. A response missing `access_token`, or carrying one that
 * is not a string, is `malformed` rather than a token-shaped object with an
 * `undefined` in it, because the latter reaches the fetch path and becomes an
 * `Authorization: Bearer undefined` that a provider answers 401 to, which
 * would then read as an expired grant.
 */
export function readTokenResponse(payload: unknown, now: number): TokenOutcome {
    if (typeof payload !== "object" || payload === null) {
        return { ok: false, reason: "malformed" };
    }
    const body = payload as Record<string, unknown>;
    const accessToken = body["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        return { ok: false, reason: "malformed" };
    }
    const refreshToken = body["refresh_token"];
    const expiresIn = body["expires_in"];
    return {
        ok: true,
        tokens: {
            accessToken,
            ...(typeof refreshToken === "string" && refreshToken.length > 0
                ? { refreshToken }
                : {}),
            ...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
                ? { expiresAt: now + expiresIn * 1000 }
                : {}),
        },
    };
}
