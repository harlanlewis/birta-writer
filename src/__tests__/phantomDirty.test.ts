/**
 * settlePhantomDirty (src/phantomDirty.ts): clearing the unsaved-changes flag
 * of a document whose buffer is byte-identical to the file on disk.
 *
 * The mechanism is `workbench.action.files.revert`, which discards the ACTIVE
 * editor's unsaved work and ignores its URI argument — so most of what is
 * asserted here is the refusals. A settle that fires when the buffer differs
 * from disk, or when it cannot prove the revert lands on a document with
 * nothing to lose, is the data-loss shape (MAR-138) rather than a cosmetic
 * miss.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { settlePhantomDirty } from "../phantomDirty";

const REVERT = "workbench.action.files.revert";
const VIEW_TYPE = "birta.editor";
const FILE = "/project/note.md";
const SAVED = "on disk\n";

/** Tabs the fake window reports, and the one it reports as focused. */
function setTabs(tabs: Array<{ input?: unknown; isDirty?: boolean }>, activeIndex = 0): void {
    const built = tabs.map((tab) => ({ input: tab.input, isDirty: tab.isDirty ?? false }));
    vscode.window.tabGroups.all = [{ tabs: built }] as unknown as typeof vscode.window.tabGroups.all;
    vscode.window.tabGroups.activeTabGroup.activeTab = built[activeIndex];
}

/** A tab input for our own custom editor over `path`. */
const ourTab = (path = FILE) =>
    new vscode.TabInputCustom(vscode.Uri.file(path), VIEW_TYPE);

describe("settlePhantomDirty", () => {
    /** The simulated on-disk content served by fs.readFile. */
    let diskContent: string;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        diskContent = SAVED;
        (vscode.workspace.fs.readFile as Mock).mockImplementation(
            async () => Buffer.from(diskContent, "utf8"),
        );
        (vscode.commands.executeCommand as Mock).mockResolvedValue(undefined);
        setTabs([{ input: ourTab(), isDirty: true }]);
    });

    /** A dirty document over `text`, plus the focused panel showing it. */
    async function setup(text = SAVED) {
        const document = makeFakeTextDocument(SAVED, vscode.Uri.file(FILE));
        // Dirty it the way the provider does — a WorkspaceEdit — then land on
        // `text`, so the flag is set independently of the content.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            vscode.Uri.file(FILE),
            new vscode.Range(document.positionAt(0), document.positionAt(SAVED.length)),
            text,
        );
        await vscode.workspace.applyEdit(edit);
        const panel = { active: true } as unknown as vscode.WebviewPanel;
        return { document: document as unknown as vscode.TextDocument, panel };
    }

    const settle = (document: vscode.TextDocument, panel: vscode.WebviewPanel) =>
        settlePhantomDirty(document, panel, vscode.Uri.file(FILE).toString(), VIEW_TYPE);

    describe("the settle", () => {
        it("a dirty buffer identical to the file on disk should be reverted clean", async () => {
            // Arrange
            const { document, panel } = await setup(SAVED);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(true);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(REVERT);
        });

        it("a buffer that differs from the file on disk should be left dirty", async () => {
            // Arrange — the ordinary unsaved edit, and the one a revert destroys.
            const { document, panel } = await setup("edited\n");

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a buffer differing from disk by only a trailing newline should be left dirty", async () => {
            // Arrange — the boundary: equality is byte equality, not "looks the same".
            const { document, panel } = await setup(SAVED + "\n");

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a document with no unsaved changes should be left alone", async () => {
            // Arrange
            const document = makeFakeTextDocument(SAVED, vscode.Uri.file(FILE));
            const panel = { active: true } as unknown as vscode.WebviewPanel;

            // Act
            const settled = await settle(document as unknown as vscode.TextDocument, panel);

            // Assert — nothing to clear, and nothing to read the file for.
            expect(settled).toBe(false);
            expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
        });

        it("an unreadable (deleted) file should be left dirty rather than throw", async () => {
            // Arrange
            const { document, panel } = await setup(SAVED);
            (vscode.workspace.fs.readFile as Mock).mockRejectedValue(new Error("ENOENT"));

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });
    });

    describe("targeting — the revert must be unable to reach anyone else's work", () => {
        it("a panel that is not the active editor should be left dirty", async () => {
            // Arrange
            const { document } = await setup(SAVED);
            const panel = { active: false } as unknown as vscode.WebviewPanel;

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a focused tab holding another document should be left dirty", async () => {
            // Arrange
            const { document, panel } = await setup(SAVED);
            setTabs([{ input: ourTab("/project/other.md"), isDirty: true }]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a focused tab of another view type over the same file should be left dirty", async () => {
            // Arrange — a tab input naming no viewType at all.
            const { document, panel } = await setup(SAVED);
            setTabs([{ input: { uri: vscode.Uri.file(FILE) }, isDirty: true }]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a focused custom editor of another view type over the same file should be left dirty", async () => {
            // Arrange — the viewType arm of the active-tab gate, which a bare
            // `{ uri }` input never reaches: it fails the instanceof first.
            const { document, panel } = await setup(SAVED);
            setTabs([
                { input: new vscode.TabInputCustom(vscode.Uri.file(FILE), "other.editor"), isDirty: true },
            ]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("another editor holding unsaved bytes of the same file should be left dirty", async () => {
            // Arrange — `Open With > Hex Editor` on our own `.md`. It names our
            // uri, so a gate that asks only "which file" calls it ours; its
            // unsaved bytes are its own, and the revert discards them.
            const { document, panel } = await setup(SAVED);
            setTabs([
                { input: ourTab(), isDirty: true },
                { input: new vscode.TabInputCustom(vscode.Uri.file(FILE), "hexEditor.hexedit"), isDirty: true },
            ]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a dirty tab naming no resource at all should be left dirty", async () => {
            // Arrange — a webview or terminal cannot be proven to be ours.
            const { document, panel } = await setup(SAVED);
            setTabs([{ input: ourTab(), isDirty: true }, { input: undefined, isDirty: true }]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("an untitled document should be left alone, having no file to be clean against", async () => {
            // Arrange
            const { document, panel } = await setup(SAVED);
            (document as { isUntitled: boolean }).isUntitled = true;

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
        });

        it("a closed document should be left alone", async () => {
            // Arrange
            const { document, panel } = await setup(SAVED);
            (document as { isClosed: boolean }).isClosed = true;

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
        });

        it("the same file open in a raw text tab should not block the settle", async () => {
            // Arrange — a raw text editor over our uri is backed by the SAME
            // TextDocument, so its dirty flag is the one being cleared and its
            // unsaved bytes are the ones already proven equal to disk. The
            // raw/WYSIWYG switch leaves exactly this pair open.
            const { document, panel } = await setup(SAVED);
            setTabs([
                { input: ourTab(), isDirty: true },
                { input: new vscode.TabInputText(vscode.Uri.file(FILE)), isDirty: true },
            ]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(true);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(REVERT);
        });

        it("another tab holding unsaved work should be left dirty", async () => {
            // Arrange — a mis-target here would discard that tab's edits.
            const { document, panel } = await setup(SAVED);
            setTabs([
                { input: ourTab(), isDirty: true },
                { input: { uri: vscode.Uri.file("/project/other.md") }, isDirty: true },
            ]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("a dirty tab naming no resource should count as someone else's work", async () => {
            // Arrange — another extension's webview editor: nothing proves it is ours.
            const { document, panel } = await setup(SAVED);
            setTabs([
                { input: ourTab(), isDirty: true },
                { input: { viewType: "someone.else" }, isDirty: true },
            ]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it("clean tabs holding other documents should not block the settle", async () => {
            // Arrange — reverting a clean editor re-reads a file it already matches.
            const { document, panel } = await setup(SAVED);
            setTabs([
                { input: ourTab(), isDirty: true },
                { input: { uri: vscode.Uri.file("/project/other.md") }, isDirty: false },
            ]);

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(true);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(REVERT);
        });

        it("focus moving away DURING the disk read should abandon the settle", async () => {
            // Arrange — the gates are re-read after the await for exactly this.
            const { document, panel } = await setup(SAVED);
            (vscode.workspace.fs.readFile as Mock).mockImplementation(async () => {
                setTabs([{ input: ourTab("/project/other.md"), isDirty: true }]);
                return Buffer.from(diskContent, "utf8");
            });

            // Act
            const settled = await settle(document, panel);

            // Assert
            expect(settled).toBe(false);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });
    });
});
