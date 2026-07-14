/**
 * Provider wiring for notify-only disk drift: when a document is already drifted
 * from disk at the moment its webview becomes ready (a hot-exit-restored dirty
 * doc, or one reopened after the webview was disposed on switch-away), the
 * `ready` handler must (re-)send the drift state — the controller's own early
 * postMessage happens before the webview is listening and is dropped.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
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
type FakePanel = ReturnType<typeof makePanel>;

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

function messagesOfType(panel: FakePanel, type: string): Array<Record<string, unknown>> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((msg) => msg["type"] === type);
}

describe("MarkdownEditorProvider disk-drift wiring", () => {
    let diskContent: string;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
        diskContent = "";
        (vscode.workspace.fs.readFile as Mock).mockImplementation(
            async () => Buffer.from(diskContent, "utf8"),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-sends drift state on `ready` when the document is already drifted", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        diskContent = "line1\nline2\n";
        const document = makeFakeTextDocument(diskContent, vscode.Uri.file("/project/note.md"));

        // Dirty it, then let the disk diverge — the reopened/restored-dirty shape.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(0)), "MINE ");
        await vscode.workspace.applyEdit(edit);
        diskContent = "line1 DISK\nline2\n";

        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        // Let track()'s initial evaluate settle (it sets drift; its own
        // postMessage would be dropped before the webview is ready).
        await vi.advanceTimersByTimeAsync(0);
        panel.webview.postMessage.mockClear();

        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });

        const flags = messagesOfType(panel, "syncConflict");
        expect(flags.map((f) => f["state"])).toEqual(["conflict"]);
    });

    it("does not send a drift badge on `ready` for a clean document", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        diskContent = "line1\nline2\n";
        const document = makeFakeTextDocument(diskContent, vscode.Uri.file("/project/clean.md"));

        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        await vi.advanceTimersByTimeAsync(0);
        panel.webview.postMessage.mockClear();

        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });

        expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
    });
});
