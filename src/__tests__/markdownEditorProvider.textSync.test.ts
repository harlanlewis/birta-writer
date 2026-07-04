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

/** All revert (external content push) messages posted to the panel so far. */
function revertMessages(panel: FakePanel): Array<{ type: string; content?: string }> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; content?: string })
        .filter((msg) => msg.type === "revert");
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
            const reverts = revertMessages(panel);
            expect(reverts).toHaveLength(1);
            expect(reverts[0].content).toBe("changed externally\n");
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
            const reverts = revertMessages(panel);
            expect(reverts).toHaveLength(1);
            expect(reverts[0].content).toBe("old abc\n");
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
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("a change event for a different document should be ignored", async () => {
            // Arrange
            const { panel } = await setup("content\n", "/project/note.md");
            const other = makeFakeTextDocument("sibling\n", vscode.Uri.file("/project/other.md"));

            // Act
            other.setTextExternally("sibling changed\n");
            await vi.advanceTimersByTimeAsync(500);

            // Assert
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("an external change reverted back to the synced text within the debounce should not push", async () => {
            // Arrange
            const { document, panel } = await setup("stable\n");

            // Act — change and immediately undo before the debounce fires
            document.setTextExternally("transient\n");
            document.setTextExternally("stable\n");
            await vi.advanceTimersByTimeAsync(500);

            // Assert — the webview already shows this exact text
            expect(revertMessages(panel)).toHaveLength(0);
        });
    });

    describe("webview edit echo suppression", () => {
        it("the change event caused by a webview update's own applyEdit should not push back", async () => {
            // Arrange
            const { handler, document, panel } = await setup("original\n");

            // Act — the webview edit flows through applyEdit, which fires
            // onDidChangeTextDocument with the exact text the webview sent
            await handler({ type: "update", content: "edited by webview\n" });
            await vi.advanceTimersByTimeAsync(500);

            // Assert — the edit landed but no revert bounced back
            expect(document.getText()).toBe("edited by webview\n");
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("an external change AFTER a webview edit should still be pushed", async () => {
            // Arrange — a webview edit first (baseline moves with it)
            const { handler, document, panel } = await setup("original\n");
            await handler({ type: "update", content: "webview text\n" });
            await vi.advanceTimersByTimeAsync(500);

            // Act
            document.setTextExternally("external after webview\n");
            await vi.advanceTimersByTimeAsync(200);

            // Assert
            const reverts = revertMessages(panel);
            expect(reverts).toHaveLength(1);
            expect(reverts[0].content).toBe("external after webview\n");
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
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("a pending debounced push should not fire after the panel is disposed", async () => {
            // Arrange
            const { document, panel } = await setup("content\n");

            // Act — dispose inside the debounce window
            document.setTextExternally("changed\n");
            panel.dispose();
            await vi.advanceTimersByTimeAsync(500);

            // Assert
            expect(revertMessages(panel)).toHaveLength(0);
        });
    });
});
