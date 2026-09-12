/**
 * The PKCE core (MAR-198), held against RFC 7636 and against the two
 * properties that make a public client shippable at all.
 *
 * What this file is FOR, stated because the subject is unusual: no shipped
 * connector uses `oauth-pkce` yet, so these are the only thing that runs this
 * code. That makes the assertions the specification rather than a regression
 * net, and it makes one class of mistake especially easy: a test that agrees
 * with the implementation because both were written in the same hour. Where a
 * value is fixed by the RFC rather than by us, it is asserted against the RFC's
 * own number, and where a property is security-relevant it is asserted as an
 * absence that would be invisible in a passing shape check.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
    createAttempt,
    authorizeUrl,
    stateMatches,
    tokenRequestBody,
    readTokenResponse,
    PKCE_ATTEMPT_TTL_MS,
} from "../connectors/pkce";
import type { ConnectorSpec } from "../../shared/connectors";

/**
 * A spec standing in for a registered public client.
 *
 * Local rather than taken from `CONNECTORS` on purpose: there is no
 * `oauth-pkce` row yet, and a test that waited for one would be a test that
 * does not exist. The fields it carries are the ones the flow reads, and the
 * `authorizeUrl` deliberately already has a query string, because a builder
 * that concatenated instead of using `URL` would drop it.
 */
const SPEC: ConnectorSpec = {
    id: "github",
    label: "Fake",
    auth: "oauth-pkce",
    oauth: {
        clientId: "client-123",
        authorizeUrl: "https://provider.example/oauth/authorize?actor=user",
        tokenUrl: "https://api.provider.example/oauth/token",
    },
    scopes: ["read"],
    apiHosts: ["api.provider.example"],
    verifyUrl: "https://api.provider.example/me",
};

const REDIRECT = "vscode://birtalabs.birta-writer/auth/fake";

describe("createAttempt", () => {
    it("the verifier should satisfy RFC 7636's length and alphabet", () => {
        const { verifier } = createAttempt();
        // 43 is the RFC's floor and 128 its ceiling, asserted against the
        // RFC's numbers rather than against what our byte count happens to
        // produce, so a change to VERIFIER_BYTES that broke the rule fails.
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier.length).toBeLessThanOrEqual(128);
        // unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
        expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    it("the challenge should be the S256 hash of the verifier, recomputed independently", () => {
        const { verifier, challenge } = createAttempt();
        // Recomputed here rather than compared to a stored string: a fixture
        // would agree with whatever the implementation produced, including a
        // wrong hash.
        const expected = createHash("sha256").update(verifier).digest("base64")
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        expect(challenge).toBe(expected);
        expect(challenge).not.toBe(verifier);
    });

    it("two attempts should share no secret, so one authorization cannot replay another", () => {
        const a = createAttempt();
        const b = createAttempt();
        expect(a.verifier).not.toBe(b.verifier);
        expect(a.state).not.toBe(b.state);
    });

    it("an attempt should expire, and its window should be the declared one", () => {
        const attempt = createAttempt(() => 1_000);
        expect(attempt.expiresAt).toBe(1_000 + PKCE_ATTEMPT_TTL_MS);
    });

    it("the verifier should be drawn from the injected randomness, so the source is the one under test", () => {
        // The instrument before the verdict: proves the seam is actually used,
        // which a test that only inspected the output could not tell from a
        // hardcoded constant.
        const fixed = Buffer.alloc(32, 7);
        const first = createAttempt(Date.now, () => fixed);
        const second = createAttempt(Date.now, () => fixed);
        expect(first.verifier).toBe(second.verifier);
    });
});

describe("authorizeUrl", () => {
    it("should carry the challenge and never the verifier", () => {
        const attempt = createAttempt();
        const url = new URL(authorizeUrl(SPEC, REDIRECT, attempt, ["read"]));

        expect(url.searchParams.get("code_challenge")).toBe(attempt.challenge);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        // The one assertion that matters most in this file. The verifier is the
        // secret; putting it in the URL that opens in a browser would hand it to
        // the provider, the address bar and any referrer, and the flow would
        // still work, so nothing else here would catch it.
        expect(url.href).not.toContain(attempt.verifier);
    });

    it("should never offer the plain challenge method", () => {
        const url = new URL(authorizeUrl(SPEC, REDIRECT, createAttempt(), ["read"]));
        expect(url.searchParams.get("code_challenge_method")).not.toBe("plain");
    });

    it("should preserve a query the provider's own authorize URL already carried", () => {
        const url = new URL(authorizeUrl(SPEC, REDIRECT, createAttempt(), ["read"]));
        expect(url.searchParams.get("actor")).toBe("user");
        expect(url.origin + url.pathname).toBe("https://provider.example/oauth/authorize");
    });

    it("should send the state and the redirect exactly as given", () => {
        const attempt = createAttempt();
        const url = new URL(authorizeUrl(SPEC, REDIRECT, attempt, ["read"]));
        expect(url.searchParams.get("state")).toBe(attempt.state);
        expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
        expect(url.searchParams.get("client_id")).toBe("client-123");
        expect(url.searchParams.get("response_type")).toBe("code");
    });

    it("should omit scope entirely when none are requested, rather than sending an empty one", () => {
        const url = new URL(authorizeUrl(SPEC, REDIRECT, createAttempt(), []));
        expect(url.searchParams.has("scope")).toBe(false);
    });

    it("should refuse a spec that is not an oauth-pkce connector", () => {
        const builtin: ConnectorSpec = { ...SPEC, auth: "builtin", oauth: undefined };
        expect(() => authorizeUrl(builtin, REDIRECT, createAttempt(), [])).toThrow(/not an oauth-pkce/);
    });
});

describe("stateMatches", () => {
    it("should accept the state it sent and refuse anything else", () => {
        expect(stateMatches("abc123", "abc123")).toBe(true);
        expect(stateMatches("abc123", "abc124")).toBe(false);
        expect(stateMatches("abc123", "")).toBe(false);
        expect(stateMatches("abc123", "abc123 ")).toBe(false);
        // A prefix must not pass. This is the shape a length check alone would
        // let through if the comparison were written the obvious wrong way.
        expect(stateMatches("abc123", "abc")).toBe(false);
    });
});

describe("tokenRequestBody", () => {
    it("should send no client secret on either grant, which is what makes this shippable", () => {
        const code = tokenRequestBody(SPEC, {
            kind: "code", code: "c", verifier: "v", redirectUri: REDIRECT,
        });
        const refresh = tokenRequestBody(SPEC, { kind: "refresh", refreshToken: "r" });
        // Asserted as an absence on both, because a secret added to one grant
        // later would be invisible to a test that only read the other.
        expect(code.has("client_secret")).toBe(false);
        expect(refresh.has("client_secret")).toBe(false);
    });

    it("should send the verifier on the code grant, where it replaces the secret", () => {
        const body = tokenRequestBody(SPEC, {
            kind: "code", code: "the-code", verifier: "the-verifier", redirectUri: REDIRECT,
        });
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("the-code");
        expect(body.get("code_verifier")).toBe("the-verifier");
        expect(body.get("redirect_uri")).toBe(REDIRECT);
        expect(body.get("client_id")).toBe("client-123");
    });

    it("should send no verifier and no code on the refresh grant", () => {
        const body = tokenRequestBody(SPEC, { kind: "refresh", refreshToken: "r" });
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("r");
        expect(body.has("code_verifier")).toBe(false);
        expect(body.has("code")).toBe(false);
    });
});

describe("readTokenResponse", () => {
    it("should read a well-formed response and turn expires_in into an absolute time", () => {
        const out = readTokenResponse(
            { access_token: "at", refresh_token: "rt", expires_in: 3600 },
            10_000,
        );
        expect(out).toEqual({
            ok: true,
            tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 10_000 + 3_600_000 },
        });
    });

    it("should omit what the provider did not send, rather than carrying undefined", () => {
        const out = readTokenResponse({ access_token: "at" }, 0);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect("refreshToken" in out.tokens).toBe(false);
        expect("expiresAt" in out.tokens).toBe(false);
    });

    it("should refuse a response with no usable access token", () => {
        // Each of these would otherwise become `Bearer undefined`, which a
        // provider answers 401 to, which the card layer would then show as an
        // expired grant: a wrong diagnosis the user cannot act on.
        for (const payload of [
            {},
            { access_token: "" },
            { access_token: 42 },
            { access_token: null },
            null,
            "a string",
        ]) {
            expect(readTokenResponse(payload, 0)).toEqual({ ok: false, reason: "malformed" });
        }
    });

    it("should ignore a non-numeric expires_in rather than producing a NaN expiry", () => {
        const out = readTokenResponse({ access_token: "at", expires_in: "3600" }, 0);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect("expiresAt" in out.tokens).toBe(false);
    });
});
