import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import * as vscode from "vscode";

// Extract a value from an object using a dot-separated path
export function getByPath(obj: unknown, dotPath: string): unknown {
    return dotPath.split(".").reduce<unknown>((acc, key) => {
        if (acc != null && typeof acc === "object") {
            return (acc as Record<string, unknown>)[key];
        }
        return undefined;
    }, obj);
}

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

/**
 * Upload the image to a remote server and return the image URL
 */
export async function uploadImageToServer(
    cfg: vscode.WorkspaceConfiguration,
    data: Uint8Array,
    mimeType: string,
    altText: string,
): Promise<string> {
    const serverUrl = cfg.get<string>("imageServerUrl", "").trim();
    if (!serverUrl) {
        throw new Error("Please configure markdownWysiwyg.imageServerUrl in settings first");
    }

    const fieldName =
        cfg.get<string>("imageServerFieldName", "file").trim() || "file";
    const responsePath =
        cfg.get<string>("imageServerResponsePath", "url").trim() || "url";

    // Parse extra parameters
    let extraParams: Record<string, string> = {};
    const extraParamsStr = cfg.get<string>("imageServerExtraParams", "").trim();
    if (extraParamsStr) {
        try {
            extraParams = JSON.parse(extraParamsStr);
        } catch {
            // Ignore invalid JSON and continue uploading
        }
    }

    // Build multipart/form-data
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const filename = generateFilename(altText, mimeType);
    const CRLF = "\r\n";

    const parts: Buffer[] = [];

    // Extra parameters
    for (const [key, value] of Object.entries(extraParams)) {
        parts.push(
            Buffer.from(
                `--${boundary}${CRLF}` +
                    `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
                    `${value}${CRLF}`,
            ),
        );
    }

    // Image file
    parts.push(
        Buffer.from(
            `--${boundary}${CRLF}` +
                `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"${CRLF}` +
                `Content-Type: ${mimeType}${CRLF}${CRLF}`,
        ),
    );
    parts.push(Buffer.from(data));
    parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));

    const body = Buffer.concat(parts);

    const url = new URL(serverUrl);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const responseBody = await new Promise<string>((resolve, reject) => {
        const options: http.RequestOptions = {
            method: "POST",
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": body.length,
            },
        };

        const req = transport.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
                resolve(Buffer.concat(chunks).toString("utf-8")),
            );
        });

        req.on("error", reject);

        // 30 second timeout
        req.setTimeout(30000, () => {
            req.destroy(new Error("Upload request timed out after 30s"));
        });

        req.write(body);
        req.end();
    });

    let parsed: unknown;
    try {
        parsed = JSON.parse(responseBody);
    } catch {
        throw new Error(
            `Server returned non-JSON response: ${responseBody.slice(0, 200)}`,
        );
    }

    const imageUrl = getByPath(parsed, responsePath);
    if (typeof imageUrl !== "string" || !imageUrl) {
        throw new Error(
            `Cannot extract URL using path "${responsePath}" from response: ${responseBody.slice(0, 200)}`,
        );
    }

    return imageUrl;
}
