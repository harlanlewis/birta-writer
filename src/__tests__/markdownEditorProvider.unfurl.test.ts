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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
} from "../../__mocks__/vscode";
import { _resetErrorSinkForTests } from "../errorSink";
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
        // Silence + observe the console-only error sink.
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
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
});
