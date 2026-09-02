/**
 * Every `lintBlocks` request gets a `lintResults` reply, a failed one an empty
 * one. The webview keeps a slot per request in flight, and its review pass
 * (MAR-426) holds one slot for the whole document, so a request that is never
 * answered keeps that slot for the session and the review never completes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";

vi.mock("../utils/harperService", () => ({
    lintBlocks: vi.fn(),
}));
import { lintBlocks } from "../utils/harperService";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

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

async function resolvedHandler(): Promise<{ post: ReturnType<typeof vi.fn>; send: (msg: unknown) => unknown }> {
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        inspect: vi.fn((key: string) => ({ key })),
        update: vi.fn(),
    });
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (msg: unknown) => unknown;
    expect(handler, "the provider registered no message handler").toBeTypeOf("function");
    return { post: panel.webview.postMessage, send: handler };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("lintBlocks replies", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a successful lint should reply with its results under the request's id", async () => {
        vi.mocked(lintBlocks).mockResolvedValue([{ key: 3, lints: [] }]);
        const { post, send } = await resolvedHandler();
        send({ type: "lintBlocks", id: 7, blocks: [{ key: 3, text: "Some prose." }] });
        await settle();
        expect(post).toHaveBeenCalledWith({ type: "lintResults", id: 7, results: [{ key: 3, lints: [] }] });
    });

    it("a lint that throws should still answer every block asked, with nothing to underline, so the slot is released and nothing is re-asked", async () => {
        vi.mocked(lintBlocks).mockRejectedValue(new Error("harper down"));
        const { post, send } = await resolvedHandler();
        send({ type: "lintBlocks", id: 8, blocks: [{ key: 3, text: "Some prose." }, { key: 9, text: "More." }] });
        await settle();
        await settle();
        // One result per block, never an empty array: an empty reply teaches
        // the webview's cache nothing, and its review pass would ask again.
        expect(post).toHaveBeenCalledWith({
            type: "lintResults",
            id: 8,
            results: [{ key: 3, lints: [] }, { key: 9, lints: [] }],
        });
    });
});
