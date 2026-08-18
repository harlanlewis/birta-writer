/**
 * src/suggestionProviders.ts
 *
 * The extension-side answers to the webview's three "what could this be"
 * questions, extracted from the provider (MAR-172): front-matter list values
 * used elsewhere in the workspace (the metadata panel's "+" menu), path
 * completions for a link or image URL under the caret, and workspace file
 * targets for a link input or a wikilink completer. Plus the one index two of
 * them share with smart link resolution: the workspace file list.
 *
 * Nothing here touches the document or the save boundary; the provider
 * routes each message to the method of the same shape and owns the two
 * things this module has to be told about: which folder is a document's
 * workspace root, and the per-document map that a save uses to turn a
 * webview image URI back into the path the file spells (`imageUriMapFor`),
 * which the path completer has to feed for the previews it offers.
 *
 * Both caches are keyed on time alone. The file index can only change on a
 * create or delete, so the provider's `**\/*` watcher clears it through
 * `invalidateFor` on those two events (MAR-208). The front-matter scan
 * changes on those and on an edit to a scanned file's front matter; the
 * watcher clears it on create and delete of a file it reads
 * (`isFrontMatterScanned`) and the TTL alone covers the edit, because a scan
 * is a 500-file read and a keystroke must not cost it, any more than a photo
 * landing in the workspace may.
 */
import * as path from "path";
import * as vscode from "vscode";
import { DOCUMENT_EXTENSIONS } from "../shared/documentExtensions";
import { extractListValuesByKey, rankListValues } from "../shared/frontmatterSuggestions";
import { isLocalPathQuery, rankLinkTargets } from "../shared/linkTargetSuggest";
import { buildLinkTargetItems } from "./utils/linkTargetSuggestions";
import { postToWebview } from "./webviewMessaging";

/**
 * The extensions the front-matter suggestion scan reads, as ONE fact, and the
 * same fact the editor uses to decide what it opens: a file this editor opens
 * can carry front matter, and there is no third answer.
 *
 * The glob below and the watcher predicate have to agree: the scan is cached
 * for a TTL window and only a create or delete of a file it reads can change
 * its answer, so a file type the glob collects but the watcher ignores goes
 * stale for the whole window. `.mdx` walked into exactly that, because it does
 * not end with `.md` (MAR-350). Both derive from the list below, so widening
 * it can never reach one half without the other.
 */
const FM_SCAN_EXTENSIONS = DOCUMENT_EXTENSIONS;
const FM_SCAN_GLOB = `**/*.{${FM_SCAN_EXTENSIONS.join(",")}}`;

/** Does the front-matter scan read this path? */
export function isFrontMatterScanned(fsPath: string): boolean {
    const dot = fsPath.lastIndexOf(".");
    return dot !== -1
        && (FM_SCAN_EXTENSIONS as readonly string[]).includes(fsPath.slice(dot + 1).toLowerCase());
}

/** What the provider lends this module: two facts only it can answer. */
export interface SuggestionHost {
    /** The workspace folder a document belongs to (VS Code's own answer,
     * with the provider's multi-root fallback), or undefined outside one. */
    workspaceRootFor(document: vscode.TextDocument): string | undefined;
    /** The per-document webview-URI to relative-path map a save reads back
     * (`restoreContentForSave`); the path completer registers the previews
     * it hands out so a picked image saves as the path, not the URI. */
    imageUriMapFor(uriKey: string): Map<string, string>;
}

const IGNORED_ENTRIES = new Set(["node_modules", ".git", "dist", ".DS_Store", "out", ".vscode-test"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".ico"]);

export class SuggestionProviders {
    // Workspace-wide frontmatter list-value scan, cached for a short TTL so
    // repeated "+" menu opens stay snappy (fsPath → key → list values).
    private _fmScanCache: { perFile: Map<string, ReadonlyMap<string, string[]>>; expires: number } | undefined;
    private static readonly _FM_SCAN_TTL_MS = 30_000;

    // Workspace file list cache for link target suggestions and smart link
    // resolution: one findFiles sweep, cached briefly so a click or keystroke
    // burst never pays it twice.
    private _linkFileCache: { uris: vscode.Uri[]; expires: number } | undefined;
    private static readonly _LINK_FILE_TTL_MS = 10_000;

    constructor(private readonly host: SuggestionHost) {}

    /**
     * A file was created or deleted (which is also what a rename fires): the
     * file index is stale, and the front-matter scan is too when the file is
     * one it reads. Clearing is O(1); either slot is rebuilt lazily on its
     * next ask.
     */
    invalidateFor(uri: vscode.Uri): void {
        this._linkFileCache = undefined;
        if (isFrontMatterScanned(uri.fsPath)) {
            this._fmScanCache = undefined;
        }
    }

    /**
     * Answers a requestFmSuggestions message: scans the workspace's markdown
     * files (once per TTL window, indexing every list-valued key), then replies
     * with the values used for `key` in files OTHER than the current document,
     * ranked by frequency (descending) then alphabetically.
     */
    async requestFmSuggestions(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        key: string,
    ): Promise<void> {
        const now = Date.now();
        if (!this._fmScanCache || now >= this._fmScanCache.expires) {
            // `.mdx` is in FM_SCAN_EXTENSIONS because the MDX format module is
            // built from markdown's presets, so an MDX file's `---` block is
            // front matter exactly as a `.md` file's is, and Astro and
            // Starlight pages routinely carry one. Scanning only `.md` meant a
            // workspace of MDX docs offered no suggestions at all, and its own
            // values never appeared in a `.md` file's either (MAR-350).
            const uris = await vscode.workspace.findFiles(FM_SCAN_GLOB, "**/node_modules/**", 500);
            const perFile = new Map<string, ReadonlyMap<string, string[]>>();
            await Promise.all(uris.map(async (uri) => {
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    perFile.set(uri.fsPath, extractListValuesByKey(Buffer.from(bytes).toString("utf8")));
                } catch { /* unreadable file: skip it */ }
            }));
            this._fmScanCache = { perFile, expires: now + SuggestionProviders._FM_SCAN_TTL_MS };
        }
        // Suggestions come from OTHER files only; the current document's own
        // values are already visible as chips (and excluded WebView-side too).
        const docFsPath = document.uri.fsPath;
        const otherFiles = [...this._fmScanCache.perFile.entries()]
            .filter(([fsPath]) => fsPath !== docFsPath)
            .map(([, keyValues]) => keyValues);
        const values = rankListValues(otherFiles, key);
        postToWebview(panel.webview, { type: "fmSuggestions", key, values });
    }

    /**
     * Path completions for the query under the caret in a link or image URL:
     * the direct children of the directory the query names, directories
     * first, capped, with an image's webview URI carried along for a preview.
     */
    async getPathSuggestions(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
        query: string,
    ): Promise<void> {
        const q = query.trim();
        if (!q) {
            postToWebview(panel.webview, { type: "pathSuggestions", id, items: [] });
            return;
        }

        const docFsPath = document.uri.fsPath;
        const docDir = path.dirname(docFsPath);
        const workspaceRoot = this.host.workspaceRootFor(document);

        // Split at the last "/" into a directory part and a name prefix
        const lastSlash = q.lastIndexOf("/");
        const dirPart = lastSlash >= 0 ? q.slice(0, lastSlash + 1) : "";
        const namePart = lastSlash >= 0 ? q.slice(lastSlash + 1) : q;

        // Resolve dirPart to an absolute path
        let absDir: string;
        if (dirPart.startsWith("@/")) {
            absDir = workspaceRoot
                ? path.join(workspaceRoot, dirPart.slice(2))
                : docDir;
        } else if (dirPart === "" || dirPart.startsWith("./") || dirPart.startsWith("../")) {
            absDir = path.resolve(docDir, dirPart || ".");
        } else {
            absDir = path.resolve(docDir, dirPart);
        }

        // readDirectory lists the direct children (with file types)
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absDir));
        } catch {
            postToWebview(panel.webview, { type: "pathSuggestions", id, items: [] });
            return;
        }

        const uriMap = this.host.imageUriMapFor(document.uri.toString());
        const items = entries
            .filter(([name, type]) =>
                !IGNORED_ENTRIES.has(name) &&
                name.toLowerCase().startsWith(namePart.toLowerCase()) &&
                (type === vscode.FileType.File || type === vscode.FileType.Directory) &&
                // Exclude files that exactly match namePart (the path is already complete, no need to suggest)
                !(type === vscode.FileType.File && name.toLowerCase() === namePart.toLowerCase()),
            )
            // Directories come before files; within the same type, sort alphabetically
            .sort(([an, at], [bn, bt]) => {
                if (at !== bt) { return bt === vscode.FileType.Directory ? 1 : -1; }
                return an.localeCompare(bn);
            })
            .slice(0, 15)
            .map(([name, type]) => {
                const fullPath = dirPart + name + (type === vscode.FileType.Directory ? "/" : "");
                let webviewUri: string | undefined;
                if (type === vscode.FileType.File) {
                    const ext = path.extname(name).toLowerCase();
                    if (IMAGE_EXTS.has(ext)) {
                        const absFilePath = path.join(absDir, name);
                        webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(absFilePath)).toString();
                        // Register the mapping so the save can convert it back to a relative path
                        uriMap.set(webviewUri, fullPath);
                    }
                }
                return { path: fullPath, isDir: type === vscode.FileType.Directory, webviewUri };
            });

        postToWebview(panel.webview, { type: "pathSuggestions", id, items });
    }

    /**
     * Workspace-wide file suggestions for link URL inputs (link popup /
     * insert-link prompt): case-insensitive substring match on the path,
     * markdown files first. Each match is replied in BOTH document-relative
     * and root-relative form; the WebView picks the form matching what the
     * user typed. External queries (http/https/mailto/#) get no suggestions.
     */
    async getLinkTargetSuggestions(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
        query: string,
    ): Promise<void> {
        const post = (items: ReturnType<typeof rankLinkTargets>) =>
            postToWebview(panel.webview, { type: "linkTargetSuggestions", id, items });

        // An EMPTY query is allowed (the wikilink completer's bare `[[` —
        // ranking returns everything, markdown first, capped); a non-empty
        // query must still be a local path, never a URL/#anchor.
        if ((query.trim() !== "" && !isLocalPathQuery(query)) || document.uri.scheme !== "file") {
            post([]);
            return;
        }
        const workspaceRoot = this.host.workspaceRootFor(document);
        if (!workspaceRoot) {
            post([]);
            return;
        }

        const uris = await this.getLinkFileIndex();

        const candidates = buildLinkTargetItems(
            uris.map((u) => u.fsPath),
            document.uri.fsPath,
            workspaceRoot,
        );
        post(rankLinkTargets(candidates, query));
    }

    /**
     * Workspace file index shared by link-target autocomplete and smart link
     * resolution: one findFiles sweep, cached briefly so a click or keystroke
     * burst never pays it twice.
     */
    async getLinkFileIndex(): Promise<readonly vscode.Uri[]> {
        const now = Date.now();
        if (!this._linkFileCache || now >= this._linkFileCache.expires) {
            const uris = await vscode.workspace.findFiles(
                "**/*",
                "{**/node_modules/**,**/.git/**,**/dist/**,**/releases/**}",
                2000,
            );
            this._linkFileCache = { uris, expires: now + SuggestionProviders._LINK_FILE_TTL_MS };
        }
        return this._linkFileCache.uris;
    }
}
