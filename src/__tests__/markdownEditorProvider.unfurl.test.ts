/**
 * Paste-unfurl route (MAR-178): the provider handles an `unfurlUrl` message by
 * fetching the page, parsing its title, and replying with `unfurlResult`. This
 * drives the real message handler with `fetch` stubbed, asserting:
 *   - success → posts the parsed title,
 *   - non-200 / network throw / abort-timeout → posts { title: null } and logs
 *     via the console-only error sink (never a toast),
 *   - a non-http(s) URL → posts null WITHOUT calling fetch,
 * and that every reply goes out through the mocked webview.postMessage (the
 * postToWebview funnel).
 *
 * Offline by default (MAR-179): the fetch is gated on the master switch
 * `birta.network.enabled`. These tests enable it (the feature-on case); a
 * dedicated test flips it off and asserts the provider no-ops WITHOUT fetching
 * — the extension-side defense in depth against a stale/rogue webview message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
} from "../../__mocks__/vscode";
import { _resetErrorSinkForTests } from "../errorSink";
import { _setDnsLookupForTests } from "../utils/urlGuard";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

const makePanel = () => ({
    viewColumn: 1,
    active: true,
    visible: true,
    webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview-resource:",
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
});

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

/**
 * Point the `birta` config mock's master network switch at `enabled`, leaving
 * every other key on its passed default. `readBirtaSetting("networkEnabled")`
 * reads `network.enabled`; the fetch is gated on it.
 */
function mockNetworkEnabled(enabled: boolean): void {
    (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key === "network.enabled" ? enabled : defaultValue,
        ),
        inspect: vi.fn(() => undefined),
    });
}

async function setup() {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    // Ignore the init/lineMap posts; tests assert against the unfurlResult reply.
    panel.webview.postMessage.mockClear();
    return { handler, panel };
}

type UnfurlReply = { type: "unfurlResult"; id: string; url: string; title: string | null };

/** The last unfurlResult message posted to the webview, or undefined. */
function lastUnfurlResult(panel: ReturnType<typeof makePanel>): UnfurlReply | undefined {
    const calls = panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string })
        .filter((m) => m.type === "unfurlResult");
    return calls[calls.length - 1] as UnfurlReply | undefined;
}

/**
 * The `unfurlUrl` case is fire-and-forget (`_handleUnfurl(...).catch(...)`), so
 * the reply is posted after the fetch promise chain settles — past the
 * `await handler(...)`. Poll until it lands.
 */
async function waitForUnfurlReply(panel: ReturnType<typeof makePanel>): Promise<UnfurlReply> {
    return vi.waitFor(() => {
        const reply = lastUnfurlResult(panel);
        if (!reply) { throw new Error("no unfurlResult posted yet"); }
        return reply;
    });
}

describe("MarkdownEditorProvider paste-unfurl", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        _resetErrorSinkForTests();
        // Master network switch ON for the feature-on tests; the off case
        // overrides this. Set before setup() so resolve/ready read it too.
        mockNetworkEnabled(true);
        // Fake DNS: unit tests never resolve real hostnames. Default answer is
        // a public address; SSRF tests override per-case.
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        // Silence + observe the console-only error sink.
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        _setDnsLookupForTests(undefined);
        errorSpy.mockRestore();
    });

    it("a successful fetch should post the parsed page title", async () => {
        // Arrange
        const { handler, panel } = await setup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                new Response("<head><title>Example Domain</title></head>", { status: 200 }),
            ),
        );

        // Act
        await handler({ type: "unfurlUrl", id: "u1", url: "https://example.com" });

        // Assert
        const reply = await waitForUnfurlReply(panel);
        expect(reply.id).toBe("u1");
        expect(reply.url).toBe("https://example.com");
        expect(reply.title).toBe("Example Domain");
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it("an og:title should win over the <title> tag", async () => {
        // Arrange
        const { handler, panel } = await setup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                new Response(
                    `<meta property="og:title" content="OG Wins"><title>tag</title>`,
                    { status: 200 },
                ),
            ),
        );

        // Act
        await handler({ type: "unfurlUrl", id: "u2", url: "https://example.com" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBe("OG Wins");
    });

    it("a non-200 response should post a null title and not toast", async () => {
        // Arrange
        const { handler, panel } = await setup();
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

        // Act
        await handler({ type: "unfurlUrl", id: "u3", url: "https://example.com/missing" });

        // Assert
        const reply = await waitForUnfurlReply(panel);
        expect(reply.title).toBeNull();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it("a network throw should post a null title and log via the error sink", async () => {
        // Arrange
        const { handler, panel } = await setup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("getaddrinfo ENOTFOUND example.com");
            }),
        );

        // Act
        await handler({ type: "unfurlUrl", id: "u4", url: "https://example.com" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(console.error).toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it("an aborted (timed-out) fetch should post a null title", async () => {
        // Arrange
        const { handler, panel } = await setup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
                // Simulate the AbortController firing: reject like a real abort.
                const err = new Error("The operation was aborted");
                (err as Error & { name: string }).name = "AbortError";
                void init;
                throw err;
            }),
        );

        // Act
        await handler({ type: "unfurlUrl", id: "u5", url: "https://slow.example.com" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
    });

    it("a non-http(s) URL should post null WITHOUT calling fetch", async () => {
        // Arrange
        const { handler, panel } = await setup();
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u6", url: "file:///etc/passwd" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("with the master network switch OFF it should post null WITHOUT calling fetch (defense in depth)", async () => {
        // Arrange: a valid http(s) URL that WOULD fetch if the master were on —
        // but a stale/rogue webview posted it while the editor is offline.
        const { handler, panel } = await setup();
        mockNetworkEnabled(false);
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u7", url: "https://example.com" });

        // Assert: the provider refuses to touch the wire and still replies null.
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("with birta.pasteUnfurl.enabled OFF it should post null WITHOUT calling fetch", async () => {
        // Arrange: master ON but the per-feature key OFF — the extension gate
        // must mirror the webview's, not just the master switch.
        const { handler, panel } = await setup();
        (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            get: vi.fn((key: string, defaultValue?: unknown) => {
                if (key === "network.enabled") { return true; }
                if (key === "pasteUnfurl.enabled") { return false; }
                return defaultValue;
            }),
            inspect: vi.fn(() => undefined),
        });
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u8", url: "https://example.com" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a URL resolving to a private address should post null WITHOUT calling fetch (SSRF)", async () => {
        // Arrange: DNS says the pasted hostname lives at 10.0.0.5 — an internal
        // service. The guard must refuse before any bytes leave the machine.
        const { handler, panel } = await setup();
        _setDnsLookupForTests(async () => [{ address: "10.0.0.5" }]);
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u9", url: "https://intranet.corp.example" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a localhost / private-IP-literal URL should post null WITHOUT calling fetch (SSRF)", async () => {
        // Arrange
        const { handler, panel } = await setup();
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        // Act: loopback name, RFC1918 literal, and the cloud metadata endpoint.
        await handler({ type: "unfurlUrl", id: "u10", url: "http://localhost:8080/admin" });
        await handler({ type: "unfurlUrl", id: "u11", url: "http://192.168.1.1/" });
        await handler({ type: "unfurlUrl", id: "u12", url: "http://169.254.169.254/latest/meta-data/" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a redirect to a private address should be refused mid-chain (SSRF)", async () => {
        // Arrange: the pasted URL is public, but its 302 Location points at the
        // cloud metadata endpoint. The per-hop re-check must stop the chain —
        // exactly one fetch (the public hop), no second request.
        const { handler, panel } = await setup();
        const fetchSpy = vi.fn(async () =>
            new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } }),
        );
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u13", url: "https://example.com/redirect" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("a public-to-public redirect should be followed and titled", async () => {
        // Arrange: one hop to a sibling public URL, then a titled page.
        const { handler, panel } = await setup();
        const fetchSpy = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, { status: 301, headers: { location: "https://example.com/final" } }),
            )
            .mockResolvedValueOnce(
                new Response("<title>Landed</title>", { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u14", url: "https://example.com/start" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBe("Landed");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[1][0]).toBe("https://example.com/final");
    });

    it("a redirect chain longer than the hop budget should post null", async () => {
        // Arrange: an endless 302 loop; the loop must terminate at the budget.
        const { handler, panel } = await setup();
        const fetchSpy = vi.fn(async () =>
            new Response(null, { status: 302, headers: { location: "https://example.com/again" } }),
        );
        vi.stubGlobal("fetch", fetchSpy);

        // Act
        await handler({ type: "unfurlUrl", id: "u15", url: "https://example.com/loop" });

        // Assert: 1 initial hop + 5 redirect budget = 6 fetches, then give up.
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(6);
    });

    it("the JIT opt-in's own link should unfurl even while the settings write is in flight", async () => {
        // Arrange: the accept flow posts setNetworkEnabled then unfurlUrl
        // back-to-back. The config write is async and here NEVER lands (the
        // mock still reads network.enabled=false) — the in-flight bridge must
        // carry the fetch, or the very link that prompted the opt-in stays
        // bare.
        const { handler, panel } = await setup();
        (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            get: vi.fn((key: string, defaultValue?: unknown) =>
                key === "network.enabled" ? false : defaultValue,
            ),
            inspect: vi.fn(() => undefined),
            update: vi.fn(() => new Promise(() => {})), // write never resolves
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<title>Enabled Now</title>", { status: 200 })),
        );

        // Act: exactly the message order the webview's accept flow produces.
        await handler({ type: "setNetworkEnabled", enabled: true });
        await handler({ type: "unfurlUrl", id: "u17", url: "https://example.com" });

        // Assert: the triggering link got its title despite the stale read.
        expect((await waitForUnfurlReply(panel)).title).toBe("Enabled Now");
    });

    it("a title buried past 512 KB of head preamble should still be found (the YouTube shape)", async () => {
        // youtube.com puts <title> at byte ~660 K; the old 512 KB cap read a
        // titleless preamble and silently kept the bare link.
        const { handler, panel } = await setup();
        const preamble = "<head>" + "<link rel=\"preload\" href=\"x\">".padEnd(1024, " ").repeat(640);
        const page = preamble + "<title>Deep Title</title></head><body></body>";
        vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { status: 200 })));

        // Act
        await handler({ type: "unfurlUrl", id: "u18", url: "https://example.com/heavy" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBe("Deep Title");
    });

    it("the body stream should stop pulling once </head> has been read", async () => {
        // Arrange: a chunked stream — head closes in chunk 2 of 5; the body
        // chunks must never be pulled.
        const { handler, panel } = await setup();
        const enc = new TextEncoder();
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls++;
                if (pulls === 1) { controller.enqueue(enc.encode("<head><title>Early</title>")); }
                else if (pulls === 2) { controller.enqueue(enc.encode("</head><body>")); }
                else if (pulls <= 5) { controller.enqueue(enc.encode("x".repeat(65536))); }
                else { controller.close(); }
            },
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/html" } })),
        );

        // Act
        await handler({ type: "unfurlUrl", id: "u19", url: "https://example.com/streamy" });

        // Assert: title parsed, and reading stopped at the head boundary —
        // ≤3, not exactly 2, because ReadableStream speculatively pulls one
        // chunk ahead of the reader; a full read would have taken all 6.
        expect((await waitForUnfurlReply(panel)).title).toBe("Early");
        expect(pulls).toBeLessThanOrEqual(3);
    });

    it("a non-text content-type should post null without parsing", async () => {
        // Arrange: a 200 PDF — nothing to title, don't stream 512 KB of it.
        const { handler, panel } = await setup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
            ),
        );

        // Act
        await handler({ type: "unfurlUrl", id: "u16", url: "https://example.com/doc.pdf" });

        // Assert
        expect((await waitForUnfurlReply(panel)).title).toBeNull();
    });
});
