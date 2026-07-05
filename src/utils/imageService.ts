import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as vscode from "vscode";

// Derive a file extension from a MIME type
export function mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
    };
    return map[mimeType] ?? "png";
}

// Generate a non-conflicting file name
export function generateFilename(altText: string, mimeType: string): string {
    const sanitized =
        (altText || "image")
            .slice(0, 20)
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "image";
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    const ext = mimeToExt(mimeType);
    return `${sanitized}_${ts}_${rand}.${ext}`;
}

// List of candidate image directories (in priority order)
const CANDIDATE_DIRS = ["images", "imgs", "assets/images", "assets"];

// Check whether a directory exists
async function dirExists(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.type === vscode.FileType.Directory;
    } catch {
        return false;
    }
}

export interface SaveImageResult {
    relPath: string;
    absUri: vscode.Uri;
}

/**
 * Save the image to local disk and return the path relative to the .md file along with the absolute Uri
 */
export async function saveImageLocally(
    docUri: vscode.Uri,
    cfg: vscode.WorkspaceConfiguration,
    data: Uint8Array,
    mimeType: string,
    altText: string,
): Promise<SaveImageResult> {
    const ext = mimeToExt(mimeType);
    let targetDir: vscode.Uri;

    const customPath = cfg.get<string>("imageLocalPath", "").trim();

    if (customPath) {
        // Custom path: use absolute paths directly; for relative paths prefer the workspace root, then fall back to the .md directory
        if (path.isAbsolute(customPath)) {
            targetDir = vscode.Uri.file(customPath);
        } else {
            const wsFolder = vscode.workspace.getWorkspaceFolder(docUri);
            if (wsFolder) {
                targetDir = vscode.Uri.joinPath(wsFolder.uri, customPath);
            } else {
                targetDir = vscode.Uri.joinPath(docUri, "..", customPath);
            }
        }
        // Make sure the directory exists
        await vscode.workspace.fs.createDirectory(targetDir);
    } else if (docUri.scheme !== "file") {
        // Untitled files fall back to saving under home/images/
        targetDir = vscode.Uri.file(path.join(os.homedir(), "images"));
        await vscode.workspace.fs.createDirectory(targetDir);
    } else {
        // Auto-detect: first look under the workspace root, then in the directory next to the .md file
        const mdDir = vscode.Uri.joinPath(docUri, "..");
        const wsFolder = vscode.workspace.getWorkspaceFolder(docUri);
        const searchRoots = wsFolder ? [wsFolder.uri, mdDir] : [mdDir];

        targetDir = vscode.Uri.joinPath(mdDir, "images"); // default fallback
        let found = false;

        outer: for (const root of searchRoots) {
            for (const candidate of CANDIDATE_DIRS) {
                const candidateUri = vscode.Uri.joinPath(root, candidate);
                if (await dirExists(candidateUri)) {
                    targetDir = candidateUri;
                    found = true;
                    break outer;
                }
            }
        }

        if (!found) {
            // Create images/ in the directory next to the .md file
            targetDir = vscode.Uri.joinPath(mdDir, "images");
            await vscode.workspace.fs.createDirectory(targetDir);
        }
    }

    // ── Deduplication: compare MD5 against same-extension files in the directory ────────────────
    const newHash = crypto.createHash("md5").update(data).digest("hex");
    let entries: [string, vscode.FileType][] = [];
    try {
        entries = await vscode.workspace.fs.readDirectory(targetDir);
    } catch {
        /* ignore */
    }
    for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) {
            continue;
        }
        if (!name.endsWith("." + ext)) {
            continue;
        }
        const existingUri = vscode.Uri.joinPath(targetDir, name);
        let existingData: Uint8Array | null = null;
        try {
            existingData = await vscode.workspace.fs.readFile(existingUri);
        } catch {
            /* ignore */
        }
        if (!existingData) {
            continue;
        }
        const existingHash = crypto
            .createHash("md5")
            .update(existingData)
            .digest("hex");
        if (existingHash === newHash) {
            // Reuse the existing file
            const relPath = buildRelPath(docUri, existingUri);
            return { relPath, absUri: existingUri };
        }
    }

    const filename = generateFilename(altText, mimeType);
    const fileUri = vscode.Uri.joinPath(targetDir, filename);
    await vscode.workspace.fs.writeFile(fileUri, data);

    const relPath = buildRelPath(docUri, fileUri);
    return { relPath, absUri: fileUri };
}

export function buildRelPath(docUri: vscode.Uri, fileUri: vscode.Uri): string {
    if (docUri.scheme !== "file") {
        return fileUri.fsPath; // untitled: return the absolute path
    }
    const mdDir = path.dirname(docUri.fsPath);
    let rel = path.relative(mdDir, fileUri.fsPath).replace(/\\/g, "/");
    if (!rel.startsWith(".")) {
        rel = "./" + rel;
    }
    return rel;
}
