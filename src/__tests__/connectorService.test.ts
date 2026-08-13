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

        it("a service the user never connected should answer locked with ZERO fetches", async () => {
            // The innermost consent layer. It is also what stops a VS Code
            // GitHub session signed in for some other extension's sake from
            // silently becoming Birta's consent to make credentialed requests.
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets().api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a VS Code session with no connection record should still answer locked", async () => {
            // The same claim from the other side: the session exists, and it
            // is not consent.
            mockSession(TOKEN);
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets().api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
            expect(fetchSpy).not.toHaveBeenCalled();
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

        it("a rate-limited or failing request should answer error, never a blank card", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
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

        it("disconnecting should drop the cache so a stale card cannot survive it", async () => {
            const fetchSpy = vi.fn(async () => jsonResponse({ full_name: "birtalabs/birta-writer" }));
            vi.stubGlobal("fetch", fetchSpy);
            const secrets = fakeSecrets({ "birta.connector.github": CONNECTED });
            const service = new ConnectorService(secrets.api);
            expect(await service.resolveCard(REPO)).toMatchObject({ state: "ready" });
            await service.disconnect("github");
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
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
