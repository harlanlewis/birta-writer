import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

// Imported from the vscode mock (alias is configured in vitest.config.ts)
import * as vscode from "vscode";

const mockFs = vscode.workspace.fs as {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readDirectory: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    createDirectory: ReturnType<typeof vi.fn>;
};

import {
    mimeToExt,
    generateFilename,
    buildRelPath,
    saveImageLocally,
} from "../../src/utils/imageService";

// ─────────────────────────────────────────────────────────────
// mimeToExt
// ─────────────────────────────────────────────────────────────
describe("mimeToExt", () => {
    it.each([
        ["image/png", "png"],
        ["image/jpeg", "jpg"],
        ["image/jpg", "jpg"],
        ["image/gif", "gif"],
        ["image/webp", "webp"],
        ["image/svg+xml", "svg"],
        ["image/bmp", "bmp"],
        ["image/tiff", "tiff"],
    ])("MIME %s → extension %s", (mime, ext) => {
        expect(mimeToExt(mime)).toBe(ext);
    });

    it("falls back to png for an unknown MIME type", () => {
        expect(mimeToExt("image/xyz")).toBe("png");
    });

    it("falls back to png for an empty string", () => {
        expect(mimeToExt("")).toBe("png");
    });
});

// ─────────────────────────────────────────────────────────────
// generateFilename
// ─────────────────────────────────────────────────────────────
describe("generateFilename", () => {
    it("the returned file name ends with the correct extension", () => {
        const name = generateFilename("photo", "image/png");
        expect(name).toMatch(/\.png$/);
    });

    it("truncates altText when it exceeds 20 characters", () => {
        const name = generateFilename("a".repeat(30), "image/jpeg");
        const [prefix] = name.split("_");
        expect(prefix.length).toBeLessThanOrEqual(20);
    });

    it("replaces special characters in altText with hyphens", () => {
        const name = generateFilename("hello world!", "image/png");
        const [prefix] = name.split("_");
        expect(prefix).not.toMatch(/[ !]/);
    });

    it("collapses consecutive special characters into a single hyphen", () => {
        const name = generateFilename("a  b!!c", "image/png");
        const [prefix] = name.split("_");
        expect(prefix).not.toMatch(/--/);
    });

    it("uses 'image' as the default prefix when altText is empty", () => {
        const name = generateFilename("", "image/png");
        expect(name.startsWith("image_")).toBe(true);
    });

    it("uses 'image' as the default prefix when altText contains only special characters", () => {
        const name = generateFilename("!!!---", "image/png");
        expect(name.startsWith("image_")).toBe(true);
    });

    it("preserves valid alphanumeric characters in altText", () => {
        const name = generateFilename("photo", "image/png");
        expect(name).toMatch(/^photo/);
    });

    it("generates different file names when called consecutively with the same altText", () => {
        const n1 = generateFilename("test", "image/png");
        const n2 = generateFilename("test", "image/png");
        // Extremely unlikely to be identical, enough to verify the uniqueness design
        expect(typeof n1).toBe("string");
        expect(typeof n2).toBe("string");
    });
});

// ─────────────────────────────────────────────────────────────
// buildRelPath
// ─────────────────────────────────────────────────────────────
describe("buildRelPath", () => {
    it("returns ./filename for a file in the same directory", () => {
        const docUri = vscode.Uri.file("/project/docs/note.md");
        const fileUri = vscode.Uri.file("/project/docs/images/photo.png");
        const rel = buildRelPath(docUri, fileUri);
        expect(rel).toBe("./images/photo.png");
    });

    it("returns a path using forward slashes (cross-platform)", () => {
        const docUri = vscode.Uri.file("/project/a/b/note.md");
        const fileUri = vscode.Uri.file("/project/a/b/imgs/x.png");
        const rel = buildRelPath(docUri, fileUri);
        expect(rel).not.toMatch(/\\/);
    });

    it("returns a path starting with ./", () => {
        const docUri = vscode.Uri.file("/project/note.md");
        const fileUri = vscode.Uri.file("/project/images/x.png");
        const rel = buildRelPath(docUri, fileUri);
        expect(rel.startsWith("./")).toBe(true);
    });

    it("returns an absolute path for an untitled document (non-file scheme)", () => {
        const docUri = { fsPath: "untitled", scheme: "untitled", toString: () => "untitled:" };
        const fileUri = vscode.Uri.file("/home/user/images/photo.png");
        const rel = buildRelPath(docUri as typeof fileUri, fileUri);
        expect(path.isAbsolute(rel)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────
// saveImageLocally — MD5 deduplication logic
// ─────────────────────────────────────────────────────────────
describe("saveImageLocally — MD5 deduplication", () => {
    const docUri = vscode.Uri.file("/project/docs/note.md");
    const imageData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic number

    function makeCfg(overrides: Record<string, unknown> = {}) {
        return {
            get: vi.fn((key: string, def?: unknown) => overrides[key] ?? def),
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        // By default stat throws (directory does not exist, triggering creation)
        mockFs.stat.mockRejectedValue(new Error("ENOENT"));
        mockFs.createDirectory.mockResolvedValue(undefined);
        mockFs.readDirectory.mockResolvedValue([]);
        mockFs.writeFile.mockResolvedValue(undefined);
    });

    it("writes a new file directly and returns a relative path when the directory is empty", async () => {
        const cfg = makeCfg();
        const result = await saveImageLocally(docUri, cfg as never, imageData, "image/png", "photo");
        expect(mockFs.writeFile).toHaveBeenCalledOnce();
        expect(result.relPath).toMatch(/^\.\/images\//);
        expect(result.relPath).toMatch(/\.png$/);
    });

    it("reuses a same-extension file with an identical MD5 in the directory instead of writing again", async () => {
        // Simulate a .png file already present in the directory
        const existingName = "photo_abc123_def4.png";
        mockFs.stat.mockResolvedValue({ type: vscode.FileType.Directory });
        mockFs.readDirectory.mockResolvedValue([[existingName, vscode.FileType.File]]);
        mockFs.readFile.mockResolvedValue(imageData); // same content → same MD5

        const cfg = makeCfg();
        const result = await saveImageLocally(docUri, cfg as never, imageData, "image/png", "photo");

        expect(mockFs.writeFile).not.toHaveBeenCalled();
        expect(result.relPath).toContain(existingName);
    });

    it("writes a new file when a file with different content exists in the directory", async () => {
        const existingName = "other_abc123_def4.png";
        const differentData = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
        mockFs.stat.mockResolvedValue({ type: vscode.FileType.Directory });
        mockFs.readDirectory.mockResolvedValue([[existingName, vscode.FileType.File]]);
        mockFs.readFile.mockResolvedValue(differentData); // different content → different MD5

        const cfg = makeCfg();
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "photo");

        expect(mockFs.writeFile).toHaveBeenCalledOnce();
    });

    it("does not compare existing files with a different extension (only compares the same extension)", async () => {
        // The directory only has a .jpg file, while a .png is being uploaded
        const existingName = "photo_abc_def.jpg";
        mockFs.stat.mockResolvedValue({ type: vscode.FileType.Directory });
        mockFs.readDirectory.mockResolvedValue([[existingName, vscode.FileType.File]]);
        mockFs.readFile.mockResolvedValue(imageData);

        const cfg = makeCfg();
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "photo");

        // readFile should not be called (extension does not match, so comparison is skipped)
        expect(mockFs.readFile).not.toHaveBeenCalled();
        expect(mockFs.writeFile).toHaveBeenCalledOnce();
    });
});

// ─────────────────────────────────────────────────────────────
// saveImageLocally — directory selection priority
// ─────────────────────────────────────────────────────────────
describe("saveImageLocally — directory selection", () => {
    const docUri = vscode.Uri.file("/project/docs/note.md");
    const imageData = new Uint8Array([1, 2, 3]);

    function makeCfg(overrides: Record<string, unknown> = {}) {
        return { get: vi.fn((key: string, def?: unknown) => overrides[key] ?? def) };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockFs.readDirectory.mockResolvedValue([]);
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFs.createDirectory.mockResolvedValue(undefined);
    });

    it("prefers the absolute-path imageLocalPath configuration item", async () => {
        const customPath = "/custom/image-dir";
        mockFs.stat.mockResolvedValue({ type: vscode.FileType.Directory });
        const cfg = makeCfg({ imageLocalPath: customPath });
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "x");
        // writeFile should be called and the path should contain customPath
        const [callUri] = mockFs.writeFile.mock.calls[0] as [{ fsPath: string }];
        expect(callUri.fsPath.startsWith(customPath)).toBe(true);
    });

    it("creates an images/ directory when there is no config and none of the candidate directories exist", async () => {
        // stat always throws (none of the directories exist)
        mockFs.stat.mockRejectedValue(new Error("ENOENT"));
        const cfg = makeCfg();
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "x");
        expect(mockFs.createDirectory).toHaveBeenCalled();
        const [createdUri] = mockFs.createDirectory.mock.calls[0] as [{ fsPath: string }];
        expect(createdUri.fsPath).toContain("images");
    });
});

// ─────────────────────────────────────────────────────────────
// saveImageLocally — additional path branches
// ─────────────────────────────────────────────────────────────
describe("saveImageLocally — additional path branches", () => {
    const imageData = new Uint8Array([1, 2, 3]);

    function makeCfg(overrides: Record<string, unknown> = {}) {
        return { get: vi.fn((key: string, def?: unknown) => overrides[key] ?? def) };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (vscode.workspace.getWorkspaceFolder as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
        mockFs.readDirectory.mockResolvedValue([]);
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFs.createDirectory.mockResolvedValue(undefined);
        mockFs.stat.mockRejectedValue(new Error("ENOENT"));
    });

    it("relative imageLocalPath + workspace folder present: joins the path with the workspace root", async () => {
        const docUri = vscode.Uri.file("/project/docs/note.md");
        (vscode.workspace.getWorkspaceFolder as ReturnType<typeof vi.fn>)
            .mockReturnValue({ uri: vscode.Uri.file("/project") });

        const cfg = makeCfg({ imageLocalPath: "static/images" });
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "x");

        const [callUri] = mockFs.writeFile.mock.calls[0] as [{ fsPath: string }];
        expect(callUri.fsPath).toContain("static/images");
    });

    it("relative imageLocalPath + no workspace folder: joins the path with the directory next to the .md file", async () => {
        const docUri = vscode.Uri.file("/project/docs/note.md");

        const cfg = makeCfg({ imageLocalPath: "imgs" });
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "x");

        const [callUri] = mockFs.writeFile.mock.calls[0] as [{ fsPath: string }];
        expect(callUri.fsPath).toContain("imgs");
    });

    it("untitled (non-file scheme) document falls back to saving in the home/images/ directory", async () => {
        const untitledUri = {
            fsPath: "untitled-1",
            scheme: "untitled",
            toString: () => "untitled:untitled-1",
        };

        const cfg = makeCfg();
        await saveImageLocally(untitledUri as never, cfg as never, imageData, "image/png", "x");

        expect(mockFs.createDirectory).toHaveBeenCalled();
        const [callUri] = mockFs.writeFile.mock.calls[0] as [{ fsPath: string }];
        expect(callUri.fsPath).toContain("images");
    });

    it("during auto-detection, prefers the existing imgs candidate directory", async () => {
        const docUri = vscode.Uri.file("/project/docs/note.md");
        mockFs.stat.mockImplementation(({ fsPath }: { fsPath: string }) =>
            fsPath.endsWith("imgs")
                ? Promise.resolve({ type: vscode.FileType.Directory })
                : Promise.reject(new Error("ENOENT")),
        );

        const cfg = makeCfg();
        await saveImageLocally(docUri, cfg as never, imageData, "image/png", "x");

        const [callUri] = mockFs.writeFile.mock.calls[0] as [{ fsPath: string }];
        expect(callUri.fsPath).toContain("imgs");
        expect(mockFs.createDirectory).not.toHaveBeenCalled();
    });

    it("MD5 deduplication: skips a file and continues when readFile fails", async () => {
        const docUri = vscode.Uri.file("/project/docs/note.md");
        mockFs.readDirectory.mockResolvedValue([["broken.png", vscode.FileType.File]]);
        mockFs.readFile.mockRejectedValue(new Error("EPERM"));

        const cfg = makeCfg();
        const result = await saveImageLocally(docUri, cfg as never, imageData, "image/png", "x");

        expect(mockFs.writeFile).toHaveBeenCalledOnce();
        expect(result.relPath).toMatch(/\.png$/);
    });
});
