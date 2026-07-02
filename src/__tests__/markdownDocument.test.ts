import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockFs = vscode.workspace.fs as {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
};

import { MarkdownDocument } from "../../src/MarkdownDocument";

const makeUri = (p: string) => vscode.Uri.file(p);
const makeCancellation = (cancelled = false) =>
    ({ isCancellationRequested: cancelled } as vscode.CancellationToken);

describe("MarkdownDocument", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("create()", () => {
        it("reads content from a file and returns a MarkdownDocument", async () => {
            const content = "# Hello\n\nWorld";
            mockFs.readFile.mockResolvedValue(Buffer.from(content, "utf-8"));
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            expect(doc.getText()).toBe(content);
        });

        it("correctly handles UTF-8 CJK content", async () => {
            const content = "# Title\n\nBody content containing CJK characters.";
            mockFs.readFile.mockResolvedValue(Buffer.from(content, "utf-8"));
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            expect(doc.getText()).toBe(content);
        });

        it("returns an empty string for an empty file", async () => {
            mockFs.readFile.mockResolvedValue(new Uint8Array());
            const doc = await MarkdownDocument.create(makeUri("/project/empty.md"));
            expect(doc.getText()).toBe("");
        });
    });

    describe("update()", () => {
        it("getText() returns the new content after update()", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("old content", "utf-8"));
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            doc.update("new content");
            expect(doc.getText()).toBe("new content");
        });
    });

    describe("save()", () => {
        it("writes the current content to disk", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("initial", "utf-8"));
            mockFs.writeFile.mockResolvedValue(undefined);
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            doc.update("updated content");
            await doc.save(makeCancellation());
            expect(mockFs.writeFile).toHaveBeenCalledOnce();
            const [, data] = mockFs.writeFile.mock.calls[0] as [unknown, Buffer];
            expect(data.toString("utf-8")).toBe("updated content");
        });

        it("skips writing to disk when the CancellationToken is already cancelled", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("initial", "utf-8"));
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            await doc.save(makeCancellation(true));
            expect(mockFs.writeFile).not.toHaveBeenCalled();
        });
    });

    describe("revert()", () => {
        it("getText() returns the latest content from disk after revert()", async () => {
            mockFs.readFile
                .mockResolvedValueOnce(Buffer.from("original", "utf-8"))
                .mockResolvedValueOnce(Buffer.from("reverted from disk", "utf-8"));
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            doc.update("in-memory edit");
            await doc.revert(makeCancellation());
            expect(doc.getText()).toBe("reverted from disk");
        });
    });

    describe("backup()", () => {
        it("writes the content to destination and returns a backup object", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("content", "utf-8"));
            mockFs.writeFile.mockResolvedValue(undefined);
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            const dest = makeUri("/tmp/backup.md");
            const backup = await doc.backup(dest, makeCancellation());
            expect(backup.id).toBe(dest.toString());
            expect(mockFs.writeFile).toHaveBeenCalledOnce();
        });

        it("backup.delete() deletes the backup file", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("content", "utf-8"));
            mockFs.writeFile.mockResolvedValue(undefined);
            mockFs.delete.mockResolvedValue(undefined);
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            const backup = await doc.backup(makeUri("/tmp/backup.md"), makeCancellation());
            await backup.delete();
            expect(mockFs.delete).toHaveBeenCalledOnce();
        });

        it("backup.delete() does not throw when the file does not exist", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("content", "utf-8"));
            mockFs.writeFile.mockResolvedValue(undefined);
            mockFs.delete.mockRejectedValue(new Error("ENOENT"));
            const doc = await MarkdownDocument.create(makeUri("/project/note.md"));
            const backup = await doc.backup(makeUri("/tmp/backup.md"), makeCancellation());
            await expect(backup.delete()).resolves.not.toThrow();
        });
    });

    describe("uri property", () => {
        it("uri matches the uri passed in at creation time", async () => {
            const uri = makeUri("/project/note.md");
            mockFs.readFile.mockResolvedValue(Buffer.from("", "utf-8"));
            const doc = await MarkdownDocument.create(uri);
            expect(doc.uri.fsPath).toBe(uri.fsPath);
        });
    });
});
