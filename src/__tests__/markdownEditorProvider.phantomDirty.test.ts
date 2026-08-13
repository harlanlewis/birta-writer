/**
 * The provider's wiring of the phantom-dirty settle (MAR-364): a webview
 * `update` that lands the document back on its save point asks
 * src/phantomDirty.ts to clear the unsaved-changes flag VS Code would otherwise
 * keep, because it tracks edit versions rather than bytes.
 *
 * The settle's own refusals are covered in phantomDirty.test.ts. What is
 * asserted here is which updates reach it at all — the save point has to move
 * with the file, or an undo to a state the user has since saved over would look
 * like a return to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    fireDidSaveTextDocument,
} from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const REVERT = "workbench.action.files.revert";
const FILE = "/project/note.md";
const SAVED = "# Note\n\nA line with a [label](target.md) in it.\n";
/** The same document with one character typed inside the link label. */
const TYPED = SAVED.replace("[label]", "[labZel]");

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
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

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

describe("MarkdownEditorProvider phantom-dirty settle (MAR-364)", () => {
    /** The simulated on-disk content served by fs.readFile. */
    let diskContent: string;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
        diskContent = SAVED;
        (vscode.workspace.fs.readFile as Mock).mockImplementation(
            async () => Buffer.from(diskContent, "utf8"),
        );
        (vscode.commands.executeCommand as Mock).mockResolvedValue(undefined);
        vscode.window.tabGroups.all = [] as unknown as typeof vscode.window.tabGroups.all;
    });

    afterEach(() => {
        vi.useRealTimers();
        vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
    });

    async function setup(content = SAVED) {
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument(content, vscode.Uri.file(FILE));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });
        // The editor holding the document is the focused tab.
        vscode.window.tabGroups.activeTabGroup.activeTab = {
            input: new vscode.TabInputCustom(document.uri, MarkdownEditorProvider.viewType),
        };
        return { provider, document, panel, handler };
    }

    /** Ship one webview serialization and let the edit queue drain. */
    async function update(
        handler: (msg: Record<string, unknown>) => Promise<void>,
        content: string,
        seq: number,
    ): Promise<void> {
        await handler({ type: "update", content, baseSyncVersion: 0, seq });
        await vi.advanceTimersByTimeAsync(1);
    }

    it("an update returning the document to its save point should clear the dirty state", async () => {
        // Arrange — type a character inside a link label, as the webview would.
        const { document, handler } = await setup();
        await update(handler, TYPED, 1);
        expect(document.getText()).toBe(TYPED);
        expect(document.isDirty).toBe(true);

        // Act — Cmd+Z in the editor: the webview re-serializes the saved bytes.
        await update(handler, SAVED, 2);

        // Assert
        expect(document.getText()).toBe(SAVED);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(REVERT);
    });

    it("an update carrying a real edit should leave the dirty state alone", async () => {
        // Arrange
        const { handler } = await setup();

        // Act
        await update(handler, TYPED, 1);

        // Assert — no revert, and no disk read to decide it.
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(REVERT);
        expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it("an update undoing past a save should be a real edit, not a return to the save point", async () => {
        // Arrange — the user typed, saved, then undid the typing.
        const { document, handler } = await setup();
        await update(handler, TYPED, 1);
        document.markSaved();
        diskContent = TYPED;
        fireDidSaveTextDocument(document);

        // Act
        await update(handler, SAVED, 2);

        // Assert — the buffer now differs from the file, so it stays dirty.
        expect(document.getText()).toBe(SAVED);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(REVERT);
    });

    it("an update returning to a save point the file no longer holds should leave it dirty", async () => {
        // Arrange — the file changed on disk under a dirty document (disk drift);
        // the settle's own disk read is what refuses, so nothing is discarded.
        const { handler } = await setup();
        await update(handler, TYPED, 1);
        diskContent = SAVED.replace("A line", "Another line");

        // Act
        await update(handler, SAVED, 2);

        // Assert
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(REVERT);
    });
});
