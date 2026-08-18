/**
 * src/htmlExport.ts tests (MAR-32): the host half of Export as HTML against
 * the central vscode mock: the save dialog, the write, the open offer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { exportFileName, saveHtmlExport } from "../htmlExport";

const window = vscode.window as unknown as {
    showSaveDialog: ReturnType<typeof vi.fn>;
    showInformationMessage: ReturnType<typeof vi.fn>;
    showErrorMessage: ReturnType<typeof vi.fn>;
};
const fs = vscode.workspace.fs as unknown as { writeFile: ReturnType<typeof vi.fn> };
const env = vscode.env as unknown as { openExternal: ReturnType<typeof vi.fn> };

function docAt(uriString: string): vscode.TextDocument {
    return { uri: vscode.Uri.parse(uriString) } as unknown as vscode.TextDocument;
}

describe("exportFileName", () => {
    it("a document name should swap its extension for .html", () => {
        expect(exportFileName("/a/b/My Note.md")).toBe("My Note.html");
        expect(exportFileName("README.markdown")).toBe("README.html");
    });

    it("a name with no stem should fall back to document.html", () => {
        expect(exportFileName(".md")).toBe("document.html");
        expect(exportFileName("")).toBe("document.html");
    });
});

describe("saveHtmlExport", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fs.writeFile.mockResolvedValue(undefined);
        window.showInformationMessage.mockResolvedValue(undefined);
    });

    it("a file document should default the dialog to a sibling .html", async () => {
        window.showSaveDialog.mockResolvedValue(undefined);
        await saveHtmlExport(docAt("file:///work/docs/note.md"), "<p>x</p>", "note.html");
        const opts = window.showSaveDialog.mock.calls[0][0] as { defaultUri: vscode.Uri; filters: Record<string, string[]> };
        expect(opts.defaultUri.path).toBe("/work/docs/note.html");
        expect(opts.filters.HTML).toContain("html");
    });

    it("an untitled document should leave the dialog location to VS Code", async () => {
        window.showSaveDialog.mockResolvedValue(undefined);
        await saveHtmlExport(docAt("untitled:Untitled-1"), "<p>x</p>", "Untitled-1.html");
        const opts = window.showSaveDialog.mock.calls[0][0] as { defaultUri?: vscode.Uri };
        expect(opts.defaultUri).toBeUndefined();
    });

    it("a cancelled dialog should write nothing and offer nothing", async () => {
        window.showSaveDialog.mockResolvedValue(undefined);
        const out = await saveHtmlExport(docAt("file:///work/note.md"), "<p>x</p>", "note.html");
        expect(out).toBeUndefined();
        expect(fs.writeFile).not.toHaveBeenCalled();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("a chosen target should receive the bytes and the open offer should open it", async () => {
        const target = vscode.Uri.file("/work/out/note.html");
        window.showSaveDialog.mockResolvedValue(target);
        window.showInformationMessage.mockResolvedValue("Open in Browser");
        const out = await saveHtmlExport(docAt("file:///work/note.md"), "<p>héllo</p>", "note.html");
        expect(out).toBe(target);
        const [writtenUri, bytes] = fs.writeFile.mock.calls[0] as [vscode.Uri, Uint8Array];
        expect(writtenUri).toBe(target);
        expect(new TextDecoder().decode(bytes)).toBe("<p>héllo</p>");
        expect(window.showInformationMessage).toHaveBeenCalledWith("Exported note.html", "Open in Browser");
        await Promise.resolve();
        expect(env.openExternal).toHaveBeenCalledWith(target);
    });

    it("dismissing the offer should not open anything", async () => {
        window.showSaveDialog.mockResolvedValue(vscode.Uri.file("/work/note.html"));
        window.showInformationMessage.mockResolvedValue(undefined);
        await saveHtmlExport(docAt("file:///work/note.md"), "<p>x</p>", "note.html");
        await Promise.resolve();
        expect(env.openExternal).not.toHaveBeenCalled();
    });

    it("a failed write should report an error and offer nothing", async () => {
        window.showSaveDialog.mockResolvedValue(vscode.Uri.file("/ro/note.html"));
        fs.writeFile.mockRejectedValue(new Error("EACCES"));
        const out = await saveHtmlExport(docAt("file:///work/note.md"), "<p>x</p>", "note.html");
        expect(out).toBeUndefined();
        expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });
});
