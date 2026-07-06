/**
 * onDidChangeTextDocument syncing: the CustomTextEditorProvider listens to
 * document changes (external text-editor edits, undo/redo, git operations)
 * and pushes the new content to the webview, while recognizing echoes of its
 * own webview-originated WorkspaceEdits via the last-synced-text baseline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    fireDidChangeTextDocument,
} from "../../__mocks__/vscode";

import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

/** Minimal WebviewPanel fake covering everything resolveCustomTextEditor touches */
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
        onDidDispose: vi.fn((cb: () => void) => {
            disposeHandlers.push(cb);
            return { dispose: vi.fn() };
        }),
        onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(() => {
            disposeHandlers.forEach((cb) => cb());
        }),
    };
};
type FakePanel = ReturnType<typeof makePanel>;

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** All externalUpdate (external content push) messages posted to the panel so far. */
function externalUpdates(panel: FakePanel): Array<{ type: string; content?: string; syncVersion?: number }> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; content?: string; syncVersion?: number })
        .filter((msg) => msg.type === "externalUpdate");
}

describe("MarkdownEditorProvider text document sync", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function setup(content = "initial content\n", filePath = "/project/note.md") {
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

    describe("external changes", () => {
        it("an external document change should push the new content to the webview after the debounce", async () => {
            // Arrange
            const { document, panel } = await setup("old content\n");

            // Act — e.g. an edit in a side-by-side text editor
            document.setTextExternally("changed externally\n");
            await vi.advanceTimersByTimeAsync(200);

            // Assert
            const pushes = externalUpdates(panel);
            expect(pushes).toHaveLength(1);
            expect(pushes[0].content).toBe("changed externally\n");
        });

        it("multiple rapid external changes should be debounced into a single push of the LAST content", async () => {
            // Arrange
            const { document, panel } = await setup("old\n");

            // Act — three keystrokes in quick succession
            document.setTextExternally("old a\n");
            document.setTextExternally("old ab\n");
            document.setTextExternally("old abc\n");
            await vi.advanceTimersByTimeAsync(200);

            // Assert
            const pushes = externalUpdates(panel);
            expect(pushes).toHaveLength(1);
            expect(pushes[0].content).toBe("old abc\n");
        });

        it("a change event with empty contentChanges should be ignored", async () => {
            // Arrange
            const { document, panel } = await setup("content\n");

            // Act — e.g. a language-mode change fires with no content changes
            fireDidChangeTextDocument({
                document: document as never,
                contentChanges: [],
                reason: undefined,
            });
            await vi.advanceTimersByTimeAsync(500);

            // Assert
            expect(externalUpdates(panel)).toHaveLength(0);
        });

        it("a change event for a different document should be ignored", async () => {
            // Arrange
            const { panel } = await setup("content\n", "/project/note.md");
            const other = makeFakeTextDocument("sibling\n", vscode.Uri.file("/project/other.md"));

            // Act
            other.setTextExternally("sibling changed\n");
            await vi.advanceTimersByTimeAsync(500);

            // Assert
            expect(externalUpdates(panel)).toHaveLength(0);
        });

        it("an external change reverted back to the synced text within the debounce should not push", async () => {
            // Arrange
            const { document, panel } = await setup("stable\n");

            // Act — change and immediately undo before the debounce fires
            document.setTextExternally("transient\n");
            document.setTextExternally("stable\n");
            await vi.advanceTimersByTimeAsync(500);

            // Assert — the webview already shows this exact text
            expect(externalUpdates(panel)).toHaveLength(0);
        });
    });

    describe("webview edit echo suppression", () => {
        it("the change event caused by a webview update's own applyEdit should not push back", async () => {
            // Arrange
            const { handler, document, panel } = await setup("original\n");

            // Act — the webview edit flows through applyEdit, which fires
            // onDidChangeTextDocument with the exact text the webview sent
            await handler({ type: "update", content: "edited by webview\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(500);

            // Assert — the edit landed but no revert bounced back
            expect(document.getText()).toBe("edited by webview\n");
            expect(externalUpdates(panel)).toHaveLength(0);
        });

        it("an external change AFTER a webview edit should still be pushed", async () => {
            // Arrange — a webview edit first (baseline moves with it)
            const { handler, document, panel } = await setup("original\n");
            await handler({ type: "update", content: "webview text\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(500);

            // Act
            document.setTextExternally("external after webview\n");
            await vi.advanceTimersByTimeAsync(200);

            // Assert
            const pushes = externalUpdates(panel);
            expect(pushes).toHaveLength(1);
            expect(pushes[0].content).toBe("external after webview\n");
        });
    });

    describe("stale-update rejection", () => {
        it("an update whose baseSyncVersion is behind the current version should be dropped and the current state re-pushed", async () => {
            // Arrange — an external change bumps the sync version to 1
            const { handler, document, panel } = await setup("original\n");
            document.setTextExternally("external edit\n");
            await vi.advanceTimersByTimeAsync(200);
            const afterExternal = externalUpdates(panel);
            expect(afterExternal).toHaveLength(1);
            expect(afterExternal[0].syncVersion).toBe(1);
            panel.webview.postMessage.mockClear();

            // Act — the webview posts an edit serialized against the STALE base (0)
            await handler({ type: "update", content: "stale webview text\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(500);

            // Assert — the stale edit was NOT applied, and the current document
            // state was re-pushed so the webview re-bases. The version is a count
            // of distinct external changes (one here), so the re-push carries 1.
            expect(document.getText()).toBe("external edit\n");
            const rePush = externalUpdates(panel);
            expect(rePush).toHaveLength(1);
            expect(rePush[0].content).toBe("external edit\n");
            expect(rePush[0].syncVersion).toBe(1);
        });

        it("a webview update racing an external change INSIDE the debounce window should not clobber the external edit", async () => {
            // Regression for the ~200ms stale-version hole: the sync version must
            // bump the moment an external change is observed, not when the
            // debounced push fires — otherwise an in-flight webview update slips
            // through the stale check and silently overwrites the external edit.
            const { handler, document, panel } = await setup("original\n");

            // Arrange — an external process edits the file. The change is OBSERVED
            // now, but the debounced push has NOT fired yet.
            document.setTextExternally("external edit\n");

            // Act — before the 200ms debounce elapses, the webview posts an edit it
            // serialized against the pre-change text (stale base 0).
            await handler({ type: "update", content: "webview text\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(500);

            // Assert — the external edit survived; the racing webview update was
            // rejected as stale and the external state pushed for the webview to
            // re-base on (not silently lost).
            expect(document.getText()).toBe("external edit\n");
            const pushes = externalUpdates(panel);
            expect(pushes.length).toBeGreaterThanOrEqual(1);
            expect(pushes[pushes.length - 1].content).toBe("external edit\n");
        });

        it("an update whose baseSyncVersion matches the current version should be applied", async () => {
            // Arrange — an external change moves the version to 1
            const { handler, document, panel } = await setup("original\n");
            document.setTextExternally("external edit\n");
            await vi.advanceTimersByTimeAsync(200);
            panel.webview.postMessage.mockClear();

            // Act — the webview posts an edit on the CURRENT base (1)
            await handler({ type: "update", content: "fresh webview text\n", baseSyncVersion: 1 });
            await vi.advanceTimersByTimeAsync(500);

            // Assert — applied to the document, and its own applyEdit echo is
            // suppressed (no re-push)
            expect(document.getText()).toBe("fresh webview text\n");
            expect(externalUpdates(panel)).toHaveLength(0);
        });
    });

    describe("disposal", () => {
        it("disposing the panel should unsubscribe from document changes", async () => {
            // Arrange
            const { document, panel } = await setup("content\n");

            // Act
            panel.dispose();
            document.setTextExternally("changed after dispose\n");
            await vi.advanceTimersByTimeAsync(500);

            // Assert
            expect(externalUpdates(panel)).toHaveLength(0);
        });

        it("a pending debounced push should not fire after the panel is disposed", async () => {
            // Arrange
            const { document, panel } = await setup("content\n");

            // Act — dispose inside the debounce window
            document.setTextExternally("changed\n");
            panel.dispose();
            await vi.advanceTimersByTimeAsync(500);

            // Assert
            expect(externalUpdates(panel)).toHaveLength(0);
        });
    });
});
