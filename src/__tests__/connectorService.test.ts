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
import { CONNECTORS } from "../../shared/connectors";

const REPO = "https://github.com/birtalabs/birta-writer";
const PR = "https://github.com/birtalabs/birta-writer/pull/316";
const TOKEN = "gho_secret_token_value";
const TASK = "https://app.asana.com/0/1201234567890123/1207654321098765";

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
            // Both keys, and only one of them connected. A map that reported
            // only what is connected would be indistinguishable from one that
            // forgot a connector, which is the thing this test is named for.
            const service = new ConnectorService(fakeSecrets({ "birta.connector.github": CONNECTED }).api);
            expect(await service.connectionStates()).toEqual({
                github: true,
                linear: false,
                asana: false,
            });
        });

        it("an unreadable keychain should degrade to locked, never to a throw", async () => {
            const secrets = fakeSecrets();
            (secrets.api.get as unknown as ReturnType<typeof vi.fn>)
                .mockRejectedValue(new Error("keychain locked"));
            // An unreadable keychain reads as "not connected", and a missing
            // connection falls through to the ANONYMOUS read (the upgrade
            // model), so the resolve reaches fetch. Stub it: unstubbed, this
            // test asked api.github.com for real, with the connector's abort
            // timeout equal to the test timeout, and went red whenever the
            // network was slow or absent. The 404 is what makes an anonymous
            // read of a private repo report "locked".
            const fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(secrets.api);
            expect(await service.resolveCard(REPO)).toEqual({ state: "locked", connector: "github" });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });

    /**
     * The `token` rung (MAR-186). Until Asana this strategy had no provider
     * behind it, so nothing here had ever run: `connect` refused it outright
     * and `credential` returned a stored token no path could ever have stored.
     * These are the cases that make it a live code path rather than a shape.
     */
    describe("the token rung", () => {
        const PAT = "1/1100000000000001:abcdefabcdefabcdefabcdefabcdef";
        const RECORDED = JSON.stringify({ auth: "token", token: PAT });

        /** What the box hands back, or undefined for a dismissal. */
        function mockPaste(value: string | undefined): void {
            (vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>)
                .mockResolvedValue(value);
        }

        const taskBody = (fields: Record<string, unknown> = {}) => jsonResponse({
            data: { gid: "1207654321098765", name: "Ship the token rung", completed: false, ...fields },
        });

        it("a provider that answers nothing anonymously should ask NOTHING until connected", async () => {
            // The other half of `anonymousReads: false`, and the half that is
            // about privacy rather than about the card: an unconnected Asana
            // read could only 401, so making it would put the document's task
            // ids on the wire in exchange for a failure.
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets().api);
            expect(await service.resolveCard(TASK)).toEqual({ state: "locked", connector: "asana" });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("connecting should open the provider's own instructions, not a page we wrote", async () => {
            mockPaste(PAT);
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { gid: "1" } })));
            await new ConnectorService(fakeSecrets().api).connect("asana");
            const [uri] = (vscode.env.openExternal as unknown as ReturnType<typeof vi.fn>)
                .mock.calls[0] as unknown as [{ toString(): string }];
            expect(uri.toString()).toBe(CONNECTORS.asana.tokenHelpUrl);
            // A browser destination, and deliberately not a host the
            // credential may be sent to.
            expect(CONNECTORS.asana.apiHosts).not.toContain(
                new URL(CONNECTORS.asana.tokenHelpUrl!).hostname,
            );
        });

        it("the paste box should be masked and should survive the user leaving VS Code", async () => {
            // Minting a token means going to the browser. A box that closes on
            // focus loss cannot be completed by anyone who did not already
            // have a token on the clipboard, which is nearly everyone.
            mockPaste(PAT);
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { gid: "1" } })));
            await new ConnectorService(fakeSecrets().api).connect("asana");
            const [options] = (vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>)
                .mock.calls[0] as unknown as [vscode.InputBoxOptions];
            expect(options.password).toBe(true);
            expect(options.ignoreFocusOut).toBe(true);
            // The full cost of the credential, where the user is deciding.
            // There is no consent screen of ours after this one, so a prompt
            // that omitted it would leave "read-only" as the last thing said
            // about a token that is nothing of the kind.
            expect(options.prompt).toContain(CONNECTORS.asana.scopeNote);
            // The validator refuses an empty submission rather than letting
            // the flow proceed to a verify that could only fail.
            expect(options.validateInput?.("   ", {} as never)).toBeTruthy();
            expect(options.validateInput?.(PAT, {} as never)).toBeNull();
        });

        it("connecting should verify the pasted token before recording it", async () => {
            const fetchSpy = vi.fn(async () => jsonResponse({ data: { gid: "1", name: "Me" } }));
            vi.stubGlobal("fetch", fetchSpy);
            mockPaste(PAT);
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            expect(await service.connect("asana")).toEqual({ ok: true });
            const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toBe("https://app.asana.com/api/1.0/users/me");
            expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PAT}`);
            expect(secrets.store.get("birta.connector.asana")).toBe(RECORDED);
        });

        it("a token the provider rejects should NOT be recorded as a connection", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
            mockPaste(PAT);
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            const result = await service.connect("asana");
            expect(result?.ok).toBe(false);
            expect(secrets.store.has("birta.connector.asana")).toBe(false);
            expect(await service.isConnected("asana")).toBe(false);
        });

        it("dismissing the box should record nothing and ask nothing", async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            mockPaste(undefined);
            const secrets = fakeSecrets();
            // Silence, not a warning: a deliberate no is not news.
            expect(await new ConnectorService(secrets.api).connect("asana")).toBeNull();
            expect(secrets.store.size).toBe(0);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a box that comes back empty should be a cancellation, never a stored blank", async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const secrets = fakeSecrets();
            const service = new ConnectorService(secrets.api);
            for (const blank of ["", "   ", "\n\t"]) {
                mockPaste(blank);
                expect(await service.connect("asana")).toBeNull();
            }
            expect(secrets.store.size).toBe(0);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a pasted token should be trimmed before it is sent OR stored", async () => {
            // Copying a token out of a web page routinely brings a newline
            // with it, and an untrimmed bearer header is refused by the
            // provider for a reason the user cannot see.
            const fetchSpy = vi.fn(async () => jsonResponse({ data: { gid: "1" } }));
            vi.stubGlobal("fetch", fetchSpy);
            mockPaste(`  ${PAT}\n`);
            const secrets = fakeSecrets();
            await new ConnectorService(secrets.api).connect("asana");
            const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PAT}`);
            expect(secrets.store.get("birta.connector.asana")).toBe(RECORDED);
        });

        it("connecting with the master network switch OFF should refuse before asking for a token", async () => {
            mockGates({ network: false });
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            const result = await new ConnectorService(fakeSecrets().api).connect("asana");
            expect(result?.ok).toBe(false);
            expect(vscode.window.showInputBox).not.toHaveBeenCalled();
            expect(vscode.env.openExternal).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("a recorded token should reach the pinned host and build the card", async () => {
            const fetchSpy = vi.fn(async () => taskBody({ assignee: { name: "Jane Doe" } }));
            vi.stubGlobal("fetch", fetchSpy);
            const service = new ConnectorService(fakeSecrets({ "birta.connector.asana": RECORDED }).api);
            expect(await service.resolveCard(TASK)).toEqual({
                state: "ready",
                connector: "asana",
                card: { title: "Ship the token rung", subtitle: "Jane Doe", status: "Open" },
            });
            const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(new URL(url).hostname).toBe("app.asana.com");
            expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PAT}`);
        });

        it("a recorded token the provider now rejects should answer expired, not locked", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.asana": RECORDED }).api);
            expect(await service.resolveCard(TASK)).toEqual({ state: "expired", connector: "asana" });
        });

        it("a task this grant cannot see should be an error, not an offer to connect again", async () => {
            // Asana has one grant and no broader tier to offer, so a 404 to a
            // connected caller has nothing for the reader to act on. Offering
            // a connection there would be a suggestion that cannot work.
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
            const service = new ConnectorService(fakeSecrets({ "birta.connector.asana": RECORDED }).api);
            expect(await service.resolveCard(TASK)).toEqual({ state: "error", connector: "asana" });
        });

        it("no reply should carry the token, in any state", async () => {
            // The webview renders third-party content, so nothing crossing to
            // it may contain a credential. Asserted over the states the token
            // rung can reach, with the token deliberately echoed back in the
            // body of the one that succeeds.
            const cases: Array<() => Response> = [
                () => taskBody({ name: PAT === "" ? "x" : "A task", notes: PAT }),
                () => new Response("{}", { status: 401 }),
                () => new Response("{}", { status: 500 }),
            ];
            let checked = 0;
            for (const respond of cases) {
                vi.stubGlobal("fetch", vi.fn(async () => respond()));
                const service = new ConnectorService(fakeSecrets({ "birta.connector.asana": RECORDED }).api);
                const result = await service.resolveCard(TASK);
                expect(result).not.toBeNull();
                expect(JSON.stringify(result)).not.toContain(PAT);
                checked += 1;
            }
            // A loop that reached nothing would pass while asserting nothing.
            expect(checked).toBe(cases.length);
        });
    });
});
