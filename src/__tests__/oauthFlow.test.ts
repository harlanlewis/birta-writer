/**
 * The OAuth callback's checks (MAR-198).
 *
 * The callback arrives on `vscode://birtalabs.birta-writer/auth/<connector>`,
 * a URL anything on the machine can ask VS Code to open, so every assertion
 * here is about refusing a callback rather than accepting one. The accepting
 * path is one test; the rest are the ways in.
 *
 * These run the real flow against a stubbed token endpoint rather than
 * asserting on its internals, because the properties worth pinning (a state
 * that must match, an attempt that is spent once) are only observable through
 * a delivered callback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { takeUriHandler, env } from "vscode";
import { _setDnsLookupForTests } from "../utils/urlGuard";
import { OAuthFlow } from "../connectors/oauthFlow";
import { CONNECTORS } from "../../shared/connectors";

const SPEC = CONNECTORS.linear;

/**
 * The `state` the flow put in the authorize URL it just opened.
 *
 * Read through `toString(true)`. A plain `String(uri)` percent-encodes `=` and
 * `&` INSIDE the query, so the whole thing collapses into one unparseable
 * parameter and every `searchParams.get` answers null. That is a property of
 * `Uri`, not of this flow, and it is worth a comment because the resulting
 * failure looks exactly like a state mismatch.
 */
function openedState(): string {
    const calls = (env.openExternal as ReturnType<typeof vi.fn>).mock.calls;
    const opened = (calls[calls.length - 1][0] as vscode.Uri).toString(true);
    return new URL(opened).searchParams.get("state")!;
}

/** Deliver a callback the way VS Code would. */
function callback(handler: { handleUri: (uri: unknown) => void }, query: string): void {
    handler.handleUri(vscode.Uri.parse(`vscode://birtalabs.birta-writer/auth/linear?${query}`));
}

/** A token endpoint that answers once, so a second exchange is visible. */
function stubToken(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: status === 200,
        status,
        headers: { get: (h: string) => (h === "content-type" ? "application/json" : null) },
        text: async () => JSON.stringify(payload),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return fetchMock;
}

describe("the OAuth callback", () => {
    let flow: OAuthFlow;
    let handler: { handleUri: (uri: unknown) => void };

    beforeEach(() => {
        vi.clearAllMocks();
        // The token endpoint goes through the same guarded fetch a card does,
        // SSRF check included, so the lookup is pinned to a routable address
        // rather than left to resolve api.linear.app for real.
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        (env.openExternal as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        flow = new OAuthFlow();
        flow.register();
        handler = takeUriHandler()!;
        expect(handler).toBeTruthy();
    });

    it("should exchange a code when the state matches", async () => {
        stubToken({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        callback(handler, `code=the-code&state=${openedState()}`);

        const outcome = await pending;
        expect(outcome).toEqual({
            ok: true,
            tokens: { accessToken: "at", refreshToken: "rt", expiresAt: expect.any(Number) },
        });
    });

    it("should refuse a callback whose state is not the one it sent", async () => {
        const fetchMock = stubToken({ access_token: "at" });
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        callback(handler, "code=injected&state=not-the-state");

        expect(await pending).toEqual({ ok: false, reason: "refused" });
        // The load-bearing half: refusing must mean the code is never spent.
        // Without this, a flow that returned `refused` after exchanging would
        // pass the assertion above while still connecting the attacker's
        // account.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should refuse a second callback carrying the state that already arrived", async () => {
        stubToken({ access_token: "at" });
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        const state = openedState();
        callback(handler, `code=first&state=${state}`);
        await pending;

        // The attempt was consumed by the first callback, so a replay finds
        // nothing in flight. Nothing to await here: a refused replay settles
        // no promise, and the assertion is that it does not throw or resolve
        // a stale one.
        expect(() => callback(handler, `code=replay&state=${state}`)).not.toThrow();
    });

    it("should ignore a URI on a path that is not a connector's", async () => {
        stubToken({ access_token: "at" });
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        const state = openedState();

        // An unknown connector, and the extension's own non-auth paths. None
        // may settle a pending attempt.
        for (const path of ["auth/nosuch", "auth", "other/linear", "auth/linear/extra"]) {
            handler.handleUri(
                vscode.Uri.parse(`vscode://birtalabs.birta-writer/${path}?code=x&state=${state}`),
            );
        }
        // Still waiting: the real callback still works afterwards, which proves
        // the attempt survived rather than the promise merely not resolving.
        callback(handler, `code=real&state=${state}`);
        expect((await pending).ok).toBe(true);
    });

    it("should treat a declined consent as a cancellation and anything else as a refusal", async () => {
        for (const [error, reason] of [["access_denied", "cancelled"], ["server_error", "refused"]]) {
            stubToken({ access_token: "at" });
            const pending = flow.authorize(SPEC, ["read"]);
            await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
            callback(handler, `error=${error}`);
            expect(await pending).toEqual({ ok: false, reason });
        }
    });

    it("should call a 400 from the token endpoint a refusal, not a network failure", async () => {
        // RFC 6749 section 5.2: a refused grant is a 400 `invalid_grant`, which
        // is what an authorization code that sat too long in a browser gets.
        // Reported as `network` it becomes "could not reach Linear", which
        // sends the user to check their connection over a refusal.
        stubToken({ error: "invalid_grant" }, 400);
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        callback(handler, `code=stale&state=${openedState()}`);
        expect(await pending).toEqual({ ok: false, reason: "refused" });
    });

    it("should call a 500 from the token endpoint a network failure", async () => {
        // The other side of the same branch, so the mapping is discriminating
        // rather than a constant: a provider fault is not the user's refusal.
        stubToken({}, 503);
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        callback(handler, `code=c&state=${openedState()}`);
        expect(await pending).toEqual({ ok: false, reason: "network" });
    });

    it("should give up when the browser could not be opened", async () => {
        (env.openExternal as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        expect(await flow.authorize(SPEC, ["read"])).toEqual({ ok: false, reason: "cancelled" });
    });

    it("should send the verifier to the token endpoint and never a client secret", async () => {
        const fetchMock = stubToken({ access_token: "at" });
        const pending = flow.authorize(SPEC, ["read"]);
        await vi.waitFor(() => expect(env.openExternal).toHaveBeenCalled());
        callback(handler, `code=the-code&state=${openedState()}`);
        await pending;

        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe(SPEC.oauth!.tokenUrl);
        expect(init.method).toBe("POST");
        // RFC 6749 requires the token endpoint to take form encoding; JSON here
        // would be refused by a compliant provider and the flow would fail only
        // against a real one.
        expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
        const body = new URLSearchParams(String(init.body));
        expect(body.get("code_verifier")).toBeTruthy();
        expect(body.has("client_secret")).toBe(false);
        // No bearer either: there is no credential yet, and attaching one would
        // mean sending a token to get a token.
        expect(init.headers.authorization).toBeUndefined();
    });
});

/**
 * The refresh grant.
 *
 * This code had no test of any kind until now, and it had never run in
 * production either: `readRecord` dropped the `refreshToken` and `expiresAt`
 * that `connectViaOAuth` stored, so `oauthCredential` could never reach it.
 * Carrying those fields back switches the path on, which is why it is pinned
 * here first rather than trusted.
 *
 * The refresh token is a credential, so the assertions are mostly about where
 * it does NOT go: off the pinned host, into an authorization header, or into a
 * request for a spec whose strategy is not OAuth at all.
 */
describe("the refresh grant", () => {
    let flow: OAuthFlow;

    beforeEach(() => {
        vi.clearAllMocks();
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        flow = new OAuthFlow();
    });

    it("should post a refresh_token grant to the pinned token host", async () => {
        const fetchMock = stubToken({ access_token: "fresh", expires_in: 3600 });
        const before = Date.now();
        const outcome = await flow.refresh(SPEC, "the-refresh-token");

        // The verdict is read only after the call is proven to have happened.
        // This path has never run, so "no fetch" is the failure mode to rule
        // out before believing anything about what was sent.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe(SPEC.oauth!.tokenUrl);
        expect(SPEC.apiHosts).toContain(new URL(String(url)).hostname);
        expect(init.method).toBe("POST");
        expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");

        const body = new URLSearchParams(String(init.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("the-refresh-token");
        expect(body.get("client_id")).toBe(SPEC.oauth!.clientId);
        // A public client has none, on this grant as on the other.
        expect(body.has("client_secret")).toBe(false);
        // The refresh token travels in the body, which is what RFC 6749 says.
        // An authorization header here would be a second place a credential
        // lives, and this one is not a bearer.
        expect(init.headers.authorization).toBeUndefined();

        expect(outcome.ok).toBe(true);
        const tokens = (outcome as { ok: true; tokens: { accessToken: string; expiresAt?: number } }).tokens;
        expect(tokens.accessToken).toBe("fresh");
        expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    });

    it("should carry a rotated refresh token back, and omit one that did not come", async () => {
        stubToken({ access_token: "fresh", refresh_token: "rotated", expires_in: 60 });
        const rotated = await flow.refresh(SPEC, "old");
        expect(rotated).toMatchObject({ ok: true, tokens: { refreshToken: "rotated" } });

        stubToken({ access_token: "fresh" });
        const kept = await flow.refresh(SPEC, "old");
        expect(kept.ok).toBe(true);
        // Absent rather than undefined-valued: the caller decides what to keep,
        // and it can only do that if it can tell "none came back" apart from
        // "one came back empty".
        expect((kept as { tokens: object }).tokens).not.toHaveProperty("refreshToken");
        expect((kept as { tokens: object }).tokens).not.toHaveProperty("expiresAt");
    });

    it("should call a 400 a refusal and a 500 a network failure", async () => {
        // Same reading as the exchange: RFC 6749 answers 400 for a refresh
        // token the provider will not honour, which is the user reconnecting,
        // and anything else is a request that did not complete.
        stubToken({ error: "invalid_grant" }, 400);
        expect(await flow.refresh(SPEC, "old")).toEqual({ ok: false, reason: "refused" });
        stubToken({}, 500);
        expect(await flow.refresh(SPEC, "old")).toEqual({ ok: false, reason: "network" });
        stubToken({}, 401);
        expect(await flow.refresh(SPEC, "old")).toEqual({ ok: false, reason: "refused" });
    });

    it("should refuse a response with no usable access token rather than returning one", async () => {
        // The failure this rules out is a TokenSet carrying `undefined`, which
        // reaches the fetch path as `Bearer undefined` and comes back 401,
        // reading as an expired grant rather than as the malformed response it
        // was.
        for (const payload of [{}, { access_token: "" }, { access_token: 7 }, "not json at all"]) {
            const fetchMock = stubToken(payload);
            const outcome = await flow.refresh(SPEC, "old");
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(outcome).toEqual({ ok: false, reason: "refused" });
        }
    });

    it("should send the refresh token NOWHERE when the token host is not pinned", async () => {
        // The guarded fetch is the one site a credential goes on the wire, and
        // it refuses before connecting rather than after. Doctoring the spec
        // is the only way to reach that branch, because the shipped rows are
        // held to their own pinned hosts by oauthHosts.test.ts.
        const offHost = {
            ...SPEC,
            oauth: { ...SPEC.oauth!, tokenUrl: "https://tokens.evil.example/oauth/token" },
        };
        const fetchMock = stubToken({ access_token: "fresh" });
        const outcome = await flow.refresh(offHost, "the-refresh-token");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(outcome).toEqual({ ok: false, reason: "network" });
    });

    it("should refuse to refresh a connector that is not on the OAuth rung", async () => {
        // Asana holds a pasted token with no refresh grant behind it, and
        // GitHub's credential is VS Code's. Asking either to refresh is a
        // programming error, and it must cost no request.
        //
        // The third case is the one that makes this a test of the STRATEGY
        // rather than of the oauth field: a spec carrying OAuth endpoints
        // while declaring another rung. Without it, deleting the
        // `auth !== "oauth-pkce"` clause changed nothing here, because the two
        // shipped rows above have no `oauth` for the second clause to miss.
        const mislabelled = { ...CONNECTORS.asana, oauth: CONNECTORS.linear.oauth };
        const fetchMock = stubToken({ access_token: "fresh" });
        for (const spec of [CONNECTORS.asana, CONNECTORS.github, mislabelled]) {
            expect(await flow.refresh(spec, "old"), spec.id).toEqual({ ok: false, reason: "refused" });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
