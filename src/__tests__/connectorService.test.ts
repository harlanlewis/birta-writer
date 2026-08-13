/**
 * The connector service (MAR-198): consent gates, credential custody, the
 * locked/expired/error state machine, and the two invariants that matter most
 * if a guard is ever reverted —
 *
 *  - a document's URL must never cause a credential-bearing request to an
 *    arbitrary host (the confused-deputy invariant, NETWORK_POSTURE 6);
 *  - nothing that crosses back to the webview may carry a credential
 *    (NETWORK_POSTURE 7).
 *
 * `fetch`, SecretStorage, and `vscode.authentication` are all stubbed. What is
 * under test is what the service ASKS for, what it attaches, and what it hands
 * back — never a live endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { _resetErrorSinkForTests } from "../errorSink";
import { _setDnsLookupForTests } from "../utils/urlGuard";
import { ConnectorService } from "../connectors/connectorService";

const REPO = "https://github.com/birtalabs/birta-writer";
const PR = "https://github.com/birtalabs/birta-writer/pull/316";
const TOKEN = "gho_secret_token_value";

/** An in-memory SecretStorage, with the real one's async surface. */
function fakeSecrets(seed: Record<string, string> = {}) {
    const store = new Map(Object.entries(seed));
    return {
        store,
        api: {
            get: vi.fn(async (key: string) => store.get(key)),
            store: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
            delete: vi.fn(async (key: string) => { store.delete(key); }),
            onDidChange: vi.fn(),
        } as unknown as vscode.SecretStorage,
    };
}

/** A record shaped like the one `connect` writes for a builtin connector. */
const CONNECTED = JSON.stringify({ auth: "builtin" });

function mockGates(opts: { network?: boolean; embeds?: boolean; providers?: Record<string, boolean> } = {}): void {
    (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) => {
            if (key === "network.enabled") { return opts.network ?? true; }
            if (key === "embeds.enabled") { return opts.embeds ?? true; }
            if (key === "embeds.providers") { return opts.providers ?? {}; }
            return defaultValue;
        }),
        inspect: vi.fn(() => undefined),
    });
}

/** VS Code hands back a live GitHub session carrying `accessToken`. */
function mockSession(accessToken: string | null): void {
    (vscode.authentication.getSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        accessToken === null ? undefined : { accessToken },
    );
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });

describe("ConnectorService", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        _resetErrorSinkForTests();
        mockGates();
        mockSession(TOKEN);
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        _setDnsLookupForTests(undefined);
        errorSpy.mockRestore();
    });

    describe("the consent ladder", () => {
        it("the master network switch OFF should resolve null with ZERO fetches", async () => {
            mockGates({ network: false });
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("the embeds feature switch OFF should resolve null with ZERO fetches", async () => {
            mockGates({ embeds: false });
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("the github provider switched off in the roster should resolve null with ZERO fetches", async () => {
            mockGates({ providers: { github: false } });
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a service the user never connected should read a public card ANONYMOUSLY", async () => {
            // Connecting is an upgrade, not an entry fee: a public repository's
            // title is world-readable, so demanding a grant to show it would
            // ask for more than the card uses. The layers that governed whether
            // to contact GitHub at all are network + embeds + this provider,
            // and the user already set those.
            const fetchSpy = vi.fn(async () => jsonResponse({ full_name: "birtalabs/birta-writer" }));
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets().api);
            expect(await service.resolveCard(REPO)).toMatchObject({ state: "ready" });
            const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect((init.headers as Record<string, string>).authorization).toBeUndefined();
        });

        it("a VS Code session with no connection record must not put its token on the wire", async () => {
            // The invariant that survives anonymous reads, and the one that
            // matters: a GitHub session signed in for some other extension's
            // sake is NOT Birta's consent to spend it. The request may happen;
            // the credential may not be attached to it.
            mockSession(TOKEN);
            const fetchSpy = vi.fn(async () => jsonResponse({ full_name: "birtalabs/birta-writer" }));
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets().api);
            await service.resolveCard(REPO);
            const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(JSON.stringify(init.headers)).not.toContain(TOKEN);
        });

        it("a private repository read anonymously should offer the connection", async () => {
            // GitHub answers 404 rather than 403 for a private repository, so
            // an anonymous caller cannot probe for existence. That is exactly
            // the case a connection would fix, so it is the offer, not an error.
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
            const service = new ConnectorService(fakeSecrets().api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
        });

        it("a public-only connection hitting a private repo should offer the broader grant", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
        });

        it("a private-access connection still not seeing it should be an error, not another offer", async () => {
            // The user already holds the broadest grant this connector has, so
            // offering to connect again would be a loop with nothing behind it.
            const record = JSON.stringify({ auth: "builtin", privateAccess: true });
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": record }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "error", connector: "github" });
        });
    });

    describe("no confused-deputy fetches", () => {
        it("an unrecognized URL should fetch nothing", async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard("https://evil.example/steal")).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a lookalike host should fetch nothing", async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard("https://github.com.evil.example/a/b")).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a recognized URL should send the credential ONLY to the pinned API host", async () => {
            const fetchSpy = vi.fn(async () => jsonResponse({ full_name: "birtalabs/birta-writer" }));
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            await service.resolveCard(REPO);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [asked, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(new URL(asked).hostname).toBe("api.github.com");
            expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
        });

        it("a redirect should end the request instead of carrying the credential onward", async () => {
            // `redirect: "manual"` is asked for, and any 3xx is a failure —
            // the second request is never made rather than made unauthorized.
            const fetchSpy = vi.fn(async () =>
                new Response("", { status: 302, headers: { location: "https://evil.example/" } }),
            );
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "error", connector: "github" });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(init.redirect).toBe("manual");
        });

        it("a pinned host resolving to a private address should fetch nothing", async () => {
            _setDnsLookupForTests(async () => [{ address: "127.0.0.1" }]);
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "error", connector: "github" });
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe("the credential never reaches the webview", () => {
        it("no reply for any card state should contain the token anywhere in it", async () => {
            // The reply is what crosses the messaging boundary verbatim, so
            // serializing the whole thing and searching it is the honest check:
            // it holds however the payload shape grows.
            const responses: Array<() => Response> = [
                () => jsonResponse({ full_name: "birtalabs/birta-writer", description: "x", private: true }),
                () => new Response("{}", { status: 401 }),
                () => new Response("{}", { status: 500 }),
                () => new Response("", { status: 302, headers: { location: "https://evil.example/" } }),
            ];
            for (const make of responses) {
                vi.stubGlobal("fetch", vi.fn(async () => make()));
                const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
                const result = await service.resolveCard(REPO);
                expect(JSON.stringify(result)).not.toContain(TOKEN);
                expect(JSON.stringify(result)).not.toContain("Bearer");
            }
        });

        it("a provider echoing the token back in its JSON should not put it on the card", async () => {
            // Card fields are read by name from the response, never copied
            // wholesale, so a hostile or confused endpoint cannot smuggle a
            // field through to the least-trusted surface.
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
                full_name: "birtalabs/birta-writer",
                access_token: TOKEN,
                authorization: `Bearer ${TOKEN}`,
            })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            const result = await service.resolveCard(REPO);
            expect(JSON.stringify(result)).not.toContain(TOKEN);
        });
    });

    describe("the locked / expired / error state machine", () => {
        it("a connection whose session is gone should answer expired, not locked", async () => {
            mockSession(null);
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "expired", connector: "github" });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a credential the provider rejects should answer expired", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "expired", connector: "github" });
        });

        it("a failing request should answer error, never a blank card", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "error", connector: "github" });
        });

        it("a non-JSON response should answer error", async () => {
            vi.stubGlobal("fetch", vi.fn(async () =>
                new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
            ));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "error", connector: "github" });
        });

        it("a body missing the fields the card needs should answer error", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ nothing: "useful" })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(PR)).toEqual({ state: "error", connector: "github" });
        });
    });

    describe("card building", () => {
        it("a repository should show its full name, description, and private state", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
                full_name: "birtalabs/birta-writer",
                description: "A WYSIWYG markdown editor",
                private: true,
            })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.resolveCard(REPO)).toEqual({
                state: "ready",
                connector: "github",
                card: {
                    title: "birtalabs/birta-writer",
                    subtitle: "A WYSIWYG markdown editor",
                    status: "Private",
                },
            });
        });

        it("a merged pull request should read Merged, not Closed", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
                title: "Keep the top visible line stable",
                state: "closed",
                merged: true,
                user: { login: "harlanlewis" },
            })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            const result = await service.resolveCard(PR);
            expect(result).toMatchObject({ state: "ready", card: { status: "Merged" } });
        });

        it("a title carrying control characters should arrive sanitized", async () => {
            // The webview renders this as third-party content; every string
            // that crosses is normalized first.
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
                title: "Line one\nand\ttwo",
                state: "open",
                user: { login: "someone" },
            })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            const result = await service.resolveCard(PR);
            expect(result).toMatchObject({ state: "ready", card: { title: "Line one and two" } });
        });
    });

    describe("the session cache", () => {
        it("two resolves of one URL should make ONE request", async () => {
            const fetchSpy = vi.fn(async () => jsonResponse({ full_name: "birtalabs/birta-writer" }));
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            await Promise.all([service.resolveCard(REPO), service.resolveCard(REPO)]);
            await service.resolveCard(REPO);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it("disconnecting should drop the cache and stop attaching the credential", async () => {
            const fetchSpy = vi.fn(async () => jsonResponse({ full_name: "birtalabs/birta-writer" }));
            vi.stubGlobal("fetch", fetchSpy);
            const secrets = fakeSecrets({ "birta.connector.github": CONNECTED });
            const service = new ConnectorService(secrets.api);
            expect(await service.resolveCard(REPO)).toMatchObject({ state: "ready" });
            await service.disconnect("github");
            // The card still resolves, because it is public — what must stop
            // is the credential. Asserting the state alone would no longer
            // discriminate, since both sides of the disconnect answer `ready`.
            expect(await service.resolveCard(REPO)).toMatchObject({ state: "ready" });
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            const [, before] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            const [, after] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
            expect((before.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
            expect((after.headers as Record<string, string>).authorization).toBeUndefined();
        });
    });

    describe("connect and disconnect", () => {
        it("connecting should verify the credential before recording the connection", async () => {
            const fetchSpy = vi.fn(async () => jsonResponse({ login: "someone" }));
            vi.stubGlobal("fetch", fetchSpy);
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            expect(await service.connect("github")).toEqual({ ok: true });
            expect(new URL((fetchSpy.mock.calls[0] as unknown as [string])[0]).href)
                .toBe("https://api.github.com/user");
            expect(secrets.store.get("birta.connector.github")).toBe(CONNECTED);
        });

        it("an ordinary connect should ask for NO scopes at all", async () => {
            // The whole point of the default tier. GitHub documents a scopeless
            // token as read-only access to public information, which is every
            // card this connector builds unless the user asks for private ones,
            // and it lifts the rate limit off the anonymous 60/hour-per-IP.
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "someone" })));
            const service = new ConnectorService(fakeSecrets().api);
            await service.connect("github");
            const [, scopes] = (vscode.authentication.getSession as unknown as ReturnType<typeof vi.fn>)
                .mock.calls[0] as unknown as [string, string[]];
            expect(scopes).toEqual([]);
        });

        it("an opt-in private connect should ask for repo, and record that it did", async () => {
            // `repo` is the only OAuth scope that reads a private repository
            // and GitHub offers no read-only form of it, so it must never be
            // the default — and the record has to remember which grant was
            // taken, or the silent session lookup asks for the wrong one.
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "someone" })));
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            await service.connect("github", { includePrivate: true });
            const [, scopes] = (vscode.authentication.getSession as unknown as ReturnType<typeof vi.fn>)
                .mock.calls[0] as unknown as [string, string[]];
            expect(scopes).toEqual(["repo"]);
            expect(JSON.parse(secrets.store.get("birta.connector.github")!)).toEqual({
                auth: "builtin",
                privateAccess: true,
            });
        });

        it("a credential the provider rejects should NOT be recorded as a connection", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            const result = await service.connect("github");
            expect(result?.ok).toBe(false);
            expect(secrets.store.has("birta.connector.github")).toBe(false);
            expect(await service.isConnected("github")).toBe(false);
        });

        it("cancelling at the consent screen should record nothing and report nothing", async () => {
            (vscode.authentication.getSession as unknown as ReturnType<typeof vi.fn>)
                .mockRejectedValue(new Error("User did not consent"));
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            expect(await service.connect("github")).toBeNull();
            expect(secrets.store.size).toBe(0);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("connecting with the master network switch OFF should refuse before any consent screen", async () => {
            mockGates({ network: false });
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets().api);
            const result = await service.connect("github");
            expect(result?.ok).toBe(false);
            expect(vscode.authentication.getSession).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("disconnecting should delete the secret", async () => {
            const secrets = fakeSecrets({ "birta.connector.github": CONNECTED });
            const service = new ConnectorService(secrets.api);
            await service.disconnect("github");
            expect(secrets.store.has("birta.connector.github")).toBe(false);
            expect(await service.isConnected("github")).toBe(false);
        });

        it("the connection map should report every known connector", async () => {
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.connectionStates()).toEqual({ github: true });
        });

        it("an unreadable keychain should degrade to locked, never to a throw", async () => {
            const secrets = fakeSecrets();
            (secrets.api.get as unknown as ReturnType<typeof vi.fn>)
                .mockRejectedValue(new Error("keychain locked"));
            const service = new ConnectorService(secrets.api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
        });
    });
});
