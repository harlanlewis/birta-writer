/**
 * onWillSaveTextDocument flush: a save asks the webview to serialize the live
 * document NOW and applies the freshest content as part of the save, so a fast
 * Cmd+S can never persist content older than the editor state. A monotonic
 * `seq` totally orders content messages so a stale in-flight `update` can't
 * revert a fresher flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    fireWillSaveTextDocument,
    type FakeTextDocument,
} from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

const makePanel = () => {
    const disposeHandlers: Array<() => void> = [];
    return {
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
        onDidDispose: vi.fn((cb: () => void) => { disposeHandlers.push(cb); return { dispose: vi.fn() }; }),
        onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(() => { disposeHandlers.forEach((cb) => cb()); }),
    };
};
type FakePanel = ReturnType<typeof makePanel>;
const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** Reconstruct the text a returned TextEdit[] would produce over the document. */
function applyEdits(document: FakeTextDocument, edits: vscode.TextEdit[]): string {
    let text = document.getText();
    // Single-edit path (the flush only ever returns one range replacement).
    for (const e of edits) {
        const s = document.offsetAt(e.range.start);
        const en = document.offsetAt(e.range.end);
        text = text.slice(0, s) + e.newText + text.slice(en);
    }
    return text;
}

/** Post the flushSave the extension sent, and return its correlation id. */
function pendingFlushId(panel: FakePanel): string | undefined {
    const msg = panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string; id?: string })
        .find((m) => m.type === "flushSave");
    return msg?.id;
}

describe("MarkdownEditorProvider save flush", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
    });
    afterEach(() => { vi.useRealTimers(); });

    async function setup(content = "hello\n", filePath = "/project/note.md") {
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument(content, vscode.Uri.file(filePath));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });
        panel.webview.postMessage.mockClear();
        return { provider, document, panel, handler };
    }

    it("a save should flush the webview's freshest serialized content into the write", async () => {
        const { document, panel, handler } = await setup("hello\n");
        // A throttled update landed (document now dirty with slightly-stale text).
        await handler({ type: "update", content: "hello wor\n", baseSyncVersion: 0, seq: 1 });
        await vi.advanceTimersByTimeAsync(1);
        expect(document.getText()).toBe("hello wor\n");

        // Save fires: the webview replies with the ACTUAL latest content.
        const willSave = fireWillSaveTextDocument(document as unknown as FakeTextDocument);
        const id = pendingFlushId(panel);
        expect(id).toBeTruthy();
        await handler({ type: "flushResult", id, content: "hello world!!!\n", baseSyncVersion: 0, seq: 2 });
        const [edits] = (await willSave) as vscode.TextEdit[][];

        expect(edits).toHaveLength(1);
        expect(applyEdits(document as unknown as FakeTextDocument, edits)).toBe("hello world!!!\n");
    });

    it("a flush whose content already matches the document should return no edits", async () => {
        const { document, panel, handler } = await setup("hello\n");
        await handler({ type: "update", content: "hello there\n", baseSyncVersion: 0, seq: 1 });
        await vi.advanceTimersByTimeAsync(1);

        const willSave = fireWillSaveTextDocument(document as unknown as FakeTextDocument);
        const id = pendingFlushId(panel);
        await handler({ type: "flushResult", id, content: "hello there\n", baseSyncVersion: 0, seq: 2 });
        const [edits] = (await willSave) as vscode.TextEdit[][];

        expect(edits).toHaveLength(0);
    });

    it("a stale update (lower seq) arriving after a flush should not revert the saved content", async () => {
        const { document, panel, handler } = await setup("hello\n");
        // Flush commits seq 5.
        const willSave = fireWillSaveTextDocument(document as unknown as FakeTextDocument);
        const id = pendingFlushId(panel);
        await handler({ type: "flushResult", id, content: "fresh\n", baseSyncVersion: 0, seq: 5 });
        await willSave;

        // A stale, still-in-flight update with an older seq must be dropped.
        await handler({ type: "update", content: "stale-old\n", baseSyncVersion: 0, seq: 3 });
        await vi.advanceTimersByTimeAsync(1);
        expect(document.getText()).not.toBe("stale-old\n");
    });

    it("a save should not hang when the webview never replies (times out to no edits)", async () => {
        const { document } = await setup("hello\n");
        const willSave = fireWillSaveTextDocument(document as unknown as FakeTextDocument);
        // No flushResult delivered; the 1s safety timeout resolves it to [].
        await vi.advanceTimersByTimeAsync(1000);
        const [edits] = (await willSave) as vscode.TextEdit[][];
        expect(edits).toHaveLength(0);
    });

    it("a flush serialized against replaced content (stale baseSyncVersion) should return no edits", async () => {
        const { document, panel, handler } = await setup("hello\n");
        // An external change bumps the sync version to 1.
        document.setTextExternally("external\n");
        await vi.advanceTimersByTimeAsync(200);

        const willSave = fireWillSaveTextDocument(document as unknown as FakeTextDocument);
        const id = pendingFlushId(panel);
        // Webview echoes the OLD base version 0 → dropped.
        await handler({ type: "flushResult", id, content: "webview-stale\n", baseSyncVersion: 0, seq: 9 });
        const [edits] = (await willSave) as vscode.TextEdit[][];
        expect(edits).toHaveLength(0);
    });
});
