/**
 * Extension-side message round-trip tests: real MarkdownEditorProvider (now a
 * CustomTextEditorProvider) + the central vscode mock's fake TextDocument,
 * standing in ONLY at the VS Code API boundary (WorkspaceEdit/applyEdit,
 * configuration, workspace.save).
 *
 * Covered seam: webview "ready" → init reply (frontmatter split, lineMap),
 * webview "update" → minimal WorkspaceEdit via applyEdit → the exact document
 * text (frontmatter re-attached) → debounced workspace.save → lineMapUpdate
 * reply, and "frontmatterUpdate" → a range replace of just the frontmatter
 * block, body untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    type RecordedReplacement,
} from "../../__mocks__/vscode";

const mockApplyEdit = vscode.workspace.applyEdit as unknown as ReturnType<typeof vi.fn>;
const mockSave = vscode.workspace.save as unknown as ReturnType<typeof vi.fn>;

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

/** All messages of the given type posted to the panel so far. */
function posted(panel: FakePanel, type: string): Array<Record<string, unknown>> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((msg) => msg.type === type);
}

/** Every range replacement recorded across all applyEdit calls, in order. */
function appliedReplacements(): RecordedReplacement[] {
    return mockApplyEdit.mock.calls.flatMap(
        ([edit]) => (edit as { replacements: RecordedReplacement[] }).replacements,
    );
}

const FM = "---\ntitle: Test\ntags: [a, b]\n---\n";
const BODY = "# Heading\n\ntext here\n";

describe("MarkdownEditorProvider webview message round trip", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function setup(content: string, filePath = "/project/note.md") {
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument(content, vscode.Uri.file(filePath));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        // The registered message handler IS the production routing switch.
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        return { provider, document, panel, handler };
    }

    describe("ready → init", () => {
        it("should reply with the body only, the frontmatter split off, and a full-file line map", async () => {
            // Arrange
            const { handler, panel } = await setup(FM + BODY);

            // Act
            await handler({ type: "ready" });

            // Assert — the editor receives the BODY; the frontmatter travels
            // separately (for the fm panel); the lineMap covers the full file
            const inits = posted(panel, "init");
            expect(inits).toHaveLength(1);
            expect(inits[0].content).toBe(BODY);
            expect(inits[0].frontmatter).toBe(FM);
            expect(Array.isArray(inits[0].lineMap)).toBe(true);
        });

        it("a file without frontmatter should init with the whole content and no frontmatter", async () => {
            // Arrange
            const { handler, panel } = await setup(BODY);

            // Act
            await handler({ type: "ready" });

            // Assert
            const inits = posted(panel, "init");
            expect(inits[0].content).toBe(BODY);
            expect(inits[0].frontmatter).toBeUndefined();
        });
    });

    describe("update → WorkspaceEdit → autosave", () => {
        it("should re-attach the frontmatter, apply a minimal edit, and save after the debounce", async () => {
            // Arrange
            const { handler, panel, document } = await setup(FM + BODY);
            await handler({ type: "ready" });
            const newBody = "# Heading\n\nedited text here\n";

            // Act — webview posts the edited BODY
            await handler({ type: "update", content: newBody, baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(0); // flush the edit queue

            // Assert — the document is frontmatter + edited body, via a
            // range replace that never touched the frontmatter block
            expect(document.getText()).toBe(FM + newBody);
            const replacements = appliedReplacements();
            expect(replacements).toHaveLength(1);
            expect(replacements[0].range.start.line).toBeGreaterThanOrEqual(4); // past the fm block
            // ...and the webview got a fresh lineMap for the new content
            expect(posted(panel, "lineMapUpdate")).toHaveLength(1);

            // Autosave: nothing saved before the debounce, one save after it
            expect(mockSave).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1100);
            expect(mockSave).toHaveBeenCalledTimes(1);
            expect((mockSave.mock.calls[0][0] as vscode.Uri).fsPath).toBe(
                vscode.Uri.file("/project/note.md").fsPath,
            );
            expect(document.isDirty).toBe(false);
        });

        it("an update identical to the current content should not apply any edit", async () => {
            // Arrange
            const { handler } = await setup(FM + BODY);
            await handler({ type: "ready" });

            // Act — echo of the current body (e.g. serializer no-op)
            await handler({ type: "update", content: BODY, baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(2000);

            // Assert
            expect(mockApplyEdit).not.toHaveBeenCalled();
            expect(mockSave).not.toHaveBeenCalled();
        });

        it("rapid successive updates should each apply an edit but debounce into a single save of the LAST content", async () => {
            // Arrange
            const { handler, document } = await setup(BODY);
            await handler({ type: "ready" });

            // Act — three updates inside one autosave debounce window
            await handler({ type: "update", content: "one\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(300);
            await handler({ type: "update", content: "two\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(300);
            await handler({ type: "update", content: "three\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(1100);

            // Assert
            expect(mockApplyEdit).toHaveBeenCalledTimes(3);
            expect(mockSave).toHaveBeenCalledTimes(1);
            expect(document.getText()).toBe("three\n");
        });

        it("a webview image URI in the update should be restored to its relative path in the document", async () => {
            // Arrange — resolveImagePath registers webviewUri → relPath
            const { handler, document } = await setup("start\n");
            await handler({ type: "ready" });
            await handler({ type: "resolveImagePath", id: "r1", relPath: "./images/pic.png" });
            const webviewUri = vscode.Uri.file("/project/images/pic.png").toString();

            // Act — the webview serializes the display-space URI
            await handler({ type: "update", content: `start\n\n![alt](${webviewUri})\n`, baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(0);

            // Assert — the file-space document never contains the webview URI
            expect(document.getText()).toBe("start\n\n![alt](./images/pic.png)\n");
            expect(document.getText()).not.toContain("vscode");
        });
    });

    describe("frontmatterUpdate → WorkspaceEdit", () => {
        it("should replace only the frontmatter block and keep the body", async () => {
            // Arrange
            const { handler, document } = await setup(FM + BODY);
            await handler({ type: "ready" });
            const newFm = "---\ntitle: Renamed\ntags: [a, b]\n---\n";

            // Act
            await handler({ type: "frontmatterUpdate", frontmatter: newFm, baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(0);

            // Assert — the replace range starts at the top of the file and
            // covers exactly the old frontmatter block
            expect(document.getText()).toBe(newFm + BODY);
            const replacements = appliedReplacements();
            expect(replacements).toHaveLength(1);
            expect(replacements[0].range.start.line).toBe(0);
            expect(replacements[0].range.start.character).toBe(0);
            expect(replacements[0].newText).toBe(newFm);

            // Autosave fires for frontmatter edits too
            await vi.advanceTimersByTimeAsync(1100);
            expect(mockSave).toHaveBeenCalledTimes(1);
        });

        it("an unchanged frontmatter should not apply any edit", async () => {
            // Arrange
            const { handler } = await setup(FM + BODY);
            await handler({ type: "ready" });

            // Act
            await handler({ type: "frontmatterUpdate", frontmatter: FM, baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(2000);

            // Assert
            expect(mockApplyEdit).not.toHaveBeenCalled();
            expect(mockSave).not.toHaveBeenCalled();
        });
    });
});
