/**
 * The resolveEmbedMeta route: the provider handles the message by resolving an
 * oEmbed title (fetch stubbed) and ALWAYS replying with `embedMetaResult` —
 * a null title on any failure — through the postToWebview funnel. The fetch
 * hardening itself is pinned in embedMetaFetcher.test.ts; this file pins the
 * message plumbing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
} from "../../__mocks__/vscode";
import { _resetErrorSinkForTests } from "../errorSink";
import { _setDnsLookupForTests } from "../utils/urlGuard";
import { _resetEmbedMetaCacheForTests } from "../utils/embedMetaFetcher";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
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
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    panel.webview.postMessage.mockClear();
    return { handler, panel };
}

type MetaReply = { type: "embedMetaResult"; id: string; url: string; title: string | null };

async function waitForMetaReply(panel: ReturnType<typeof makePanel>): Promise<MetaReply> {
    return vi.waitFor(() => {
        const replies = panel.webview.postMessage.mock.calls
            .map((c) => c[0] as { type: string })
            .filter((m) => m.type === "embedMetaResult");
        const reply = replies[replies.length - 1] as MetaReply | undefined;
        if (!reply) { throw new Error("no embedMetaResult posted yet"); }
        return reply;
    });
}

describe("MarkdownEditorProvider resolveEmbedMeta", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        _resetErrorSinkForTests();
        _resetEmbedMetaCacheForTests();
        mockNetworkEnabled(true);
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        _setDnsLookupForTests(undefined);
        errorSpy.mockRestore();
    });

    it("a successful resolve should post the title, correlated by id", async () => {
        const { handler, panel } = await setup();
        vi.stubGlobal("fetch", vi.fn(async () =>
            new Response(JSON.stringify({ title: "A Video" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            })));

        await handler({ type: "resolveEmbedMeta", id: "m1", url: YT });

        const reply = await waitForMetaReply(panel);
        expect(reply).toEqual({ type: "embedMetaResult", id: "m1", url: YT, title: "A Video" });
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it("a failure should STILL reply, with a null title", async () => {
        const { handler, panel } = await setup();
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

        await handler({ type: "resolveEmbedMeta", id: "m2", url: YT });

        const reply = await waitForMetaReply(panel);
        expect(reply.id).toBe("m2");
        expect(reply.title).toBeNull();
    });

    it("the network switch OFF should reply null without fetching", async () => {
        mockNetworkEnabled(false);
        const { handler, panel } = await setup();
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        await handler({ type: "resolveEmbedMeta", id: "m3", url: YT });

        const reply = await waitForMetaReply(panel);
        expect(reply.title).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
