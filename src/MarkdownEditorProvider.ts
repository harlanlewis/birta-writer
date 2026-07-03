import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { MarkdownDocument } from "./MarkdownDocument";
import { getNonce } from "./utils/getNonce";
import { saveImageLocally, uploadImageToServer } from "./utils/imageService";
import { computeLineMap } from "./utils/lineMap";
import { extractFrontmatter, restoreContentForSave } from "./utils/contentTransform";
import { getAllThemes, getThemeColors, getAutoThemeColors, getCustomThemes } from "./themeManager";
import type { ToExtensionMessage, ToWebviewMessage, TableWrapMode } from "../shared/messages";

/**
 * Allowlist of URL schemes permitted to open in the user's default browser.
 * Blocks schemes a malicious document could abuse (file:/vscode:/command:/javascript:),
 * which trigger local file access or command execution rather than harmless external navigation.
 */
const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(rawUrl: string): boolean {
    try {
        const scheme = vscode.Uri.parse(rawUrl, true).scheme.toLowerCase() + ":";
        return SAFE_URL_SCHEMES.has(scheme);
    } catch {
        return false;
    }
}

export class MarkdownEditorProvider
    implements vscode.CustomEditorProvider<MarkdownDocument> {
    public static readonly viewType = "markdownWysiwyg.editor";

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentEditEvent<MarkdownDocument>
    >();
    public readonly onDidChangeCustomDocument =
        this._onDidChangeCustomDocument.event;

    // Auto-save debounce timers (key: document uri string)
    private readonly _autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Tracks the webviewPanel for each document (used to push new content on revert)
    private readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();

    // URIs that have already run keepEditor (pin tab), to avoid running it again
    private readonly _pinnedDocuments = new Set<string>();

    // Records the time of our own last write to disk, to avoid our own save triggering a file-watcher revert
    private readonly _lastSaveTimes = new Map<string, number>();

    // Image webviewUri → relPath mapping (key: docUri.toString())
    private readonly _imageUriMaps = new Map<string, Map<string, string>>();
    private readonly _frontmatterMap = new Map<string, string>(); // uriKey → raw frontmatter string
    /** While switchToTextEditor is in progress, suppress onDidChangeTabs from switching the text tab back to WYSIWYG */
    public static readonly suppressAutoSwitch = new Set<string>();

    // Pending navigation line number (temporarily stored on global-search click / editor switch) key: fsPath
    private readonly _pendingNavigations = new Map<string, { line: number; ts: number }>();

    // Global fallback navigation line number (stored when revealLine fires but the active tab hasn't switched)
    private _pendingRevealLine: { line: number; ts: number } | undefined;

    // Panels that have finished WebView initialization (sent a ready message) key: uriKey
    private readonly _initializedPanels = new Set<string>();

    // While switching to the text editor, suppress the line-number callback from onDidChangeActiveTextEditor
    // Prevents the line number from being wrongly fed back to the WebView after the text editor opens, triggering a redundant scrollToLine
    private _suppressNavFromTextEditor = false;

    public static current: MarkdownEditorProvider | null = null;

    /** Called from extension.ts: when revealLine fires but the active tab hasn't switched, store the global fallback */
    public setGlobalRevealLine(line: number): void {
        this._pendingRevealLine = { line, ts: Date.now() };
    }

    /** Consume the global fallback navigation line number (valid within 10 seconds; large files init Milkdown more slowly) */
    private _consumeGlobalRevealLine(): number | undefined {
        const p = this._pendingRevealLine;
        if (!p) { return undefined; }
        this._pendingRevealLine = undefined;
        if (Date.now() - p.ts > 10000) { return undefined; }
        return p.line;
    }

    /** Returns the list of fsPaths for all currently registered (open) .md panels */
    public getAllMdFsPaths(): string[] {
        const paths: string[] = [];
        for (const uriKey of this._webviewPanels.keys()) {
            try {
                const uri = vscode.Uri.parse(uriKey);
                if (uri.fsPath.endsWith('.md') || uri.fsPath.endsWith('.markdown')) {
                    paths.push(uri.fsPath);
                }
            } catch {
                // Ignore invalid URIs
            }
        }
        return paths;
    }

    /** Called when switching to the text editor: block line-number callbacks from the text editor for 1.5 seconds */
    public suppressNavFromTextEditor(): void {
        this._suppressNavFromTextEditor = true;
        setTimeout(() => { this._suppressNavFromTextEditor = false; }, 1500);
    }

    /** extension.ts checks whether it should skip the onDidChangeActiveTextEditor line-number callback */
    public get isNavFromTextEditorSuppressed(): boolean {
        return this._suppressNavFromTextEditor;
    }

    /** Called from extension.ts: stash a pending navigation line; if the panel is visible and ready, send it immediately */
    public setPendingNavigation(fsPath: string, line: number): void {
        this._pendingNavigations.set(fsPath, { line, ts: Date.now() });
        // Panel already exists and is initialized → send directly, no need to wait for onDidChangeViewState
        const uriKey = vscode.Uri.file(fsPath).toString();
        const initialized = this._initializedPanels.has(uriKey);
        console.log('[setPendingNav] fsPath:', fsPath, 'line:', line, '| initialized:', initialized);
        if (initialized) {
            const panel = this._webviewPanels.get(uriKey);
            // Only send immediately when the panel is currently visible (a hidden panel means the user just switched away, so don't send the line number back)
            if (panel && panel.visible) {
                panel.webview.postMessage({ type: 'scrollToLine', line });
                // Don't delete _pendingNavigations; keep it as a fallback for ready on panel rebuild (valid within TTL 5s)
            }
        }
    }

    /** Send an arbitrary message to the panel for the given URI (for extension.ts to call) */
    public postToPanel(uri: vscode.Uri, msg: ToWebviewMessage): void {
        const panel = this._webviewPanels.get(uri.toString());
        if (panel) { panel.webview.postMessage(msg); }
    }

    /** Called from extension.ts (revealLine command): send a scroll message directly to the panel */
    public scrollPanelToLine(uri: vscode.Uri, line: number): void {
        const uriKey = uri.toString();
        const panel = this._webviewPanels.get(uriKey);
        if (panel) {
            panel.webview.postMessage({ type: 'scrollToLine', line });
        }
    }

    private _consumePendingNavigation(fsPath: string): number | undefined {
        const pending = this._pendingNavigations.get(fsPath);
        if (!pending) { return undefined; }
        this._pendingNavigations.delete(fsPath);
        // Treat anything older than 5 seconds as expired; do not apply
        if (Date.now() - pending.ts > 5000) { return undefined; }
        return pending.line;
    }

    public postToAll(msg: ToWebviewMessage): void {
        for (const panel of this._webviewPanels.values()) {
            panel.webview.postMessage(msg);
        }
    }

    public async applyThemeToAll(): Promise<void> {
        const themeId = vscode.workspace
            .getConfiguration("markdownWysiwyg")
            .get<string>("colorTheme", "auto");

        const colors = await this._getThemeColors(themeId);
        this.postToAll({ type: "setTheme", colors });
    }

    private async _applyThemeToPanel(panel: vscode.WebviewPanel): Promise<void> {
        const themeId = vscode.workspace
            .getConfiguration("markdownWysiwyg")
            .get<string>("colorTheme", "auto");

        const colors = await this._getThemeColors(themeId);
        panel.webview.postMessage({ type: "setTheme", colors });
    }

    private async _getThemeColors(themeId: string): Promise<Record<string, string>> {
        // Check whether it's a custom theme (format: custom:themeName)
        if (themeId.startsWith("custom:")) {
            const customThemeName = themeId.slice(7);
            const customThemes = getCustomThemes();
            const customTheme = customThemes.find(t => t.name === customThemeName);
            if (customTheme) {
                // Convert the custom theme color format
                const colors: Record<string, string> = {};
                for (const [key, value] of Object.entries(customTheme.colors)) {
                    colors[`--vscode-${key.replace(/\./g, "-")}`] = value;
                }
                return colors;
            }
        }

        // Original logic: look up the built-in VSCode theme
        let currentThemeLabel: string | undefined;
        if (themeId === "auto") {
            const config = vscode.workspace.getConfiguration();
            currentThemeLabel = config.get<string>(
                "workbench.colorTheme",
            );
        }

        const themes = getAllThemes();
        const theme = themes.find((t) => t.id === themeId || currentThemeLabel === t.label);
        if (theme) {
            return await getThemeColors(theme.path);
        }

        return getAutoThemeColors();
    }

    public static register(
        context: vscode.ExtensionContext,
        claudeTerminals: Set<vscode.Terminal>,
    ): vscode.Disposable {
        const provider = new MarkdownEditorProvider(context, claudeTerminals);
        MarkdownEditorProvider.current = provider;
        return vscode.window.registerCustomEditorProvider(
            MarkdownEditorProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            },
        );
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly claudeTerminals: Set<vscode.Terminal>,
    ) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<MarkdownDocument> {
        // Debug: log the URI fragment/query to check whether global search passes a line number
        console.log('[openCustomDocument] uri:', uri.toString(), '| fragment:', uri.fragment, '| query:', uri.query);
        return MarkdownDocument.create(uri);
    }

    async resolveCustomEditor(
        document: MarkdownDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        // Non-local files (git diff, virtual URIs, etc.): render a blank page, do not dispose
        // dispose would crash the diff engine's claimWebview (OverlayWebview has been disposed)
        if (document.uri.scheme !== 'file') {
            webviewPanel.webview.html = '<!DOCTYPE html><html><body></body></html>';
            return;
        }

        // Save the panel reference (used to push content on revert)
        const uriKey = document.uri.toString();
        this._webviewPanels.set(uriKey, webviewPanel);

        webviewPanel.onDidDispose(() => {
            this._webviewPanels.delete(uriKey);
            this._pinnedDocuments.delete(uriKey);
            this._imageUriMaps.delete(uriKey);
            this._initializedPanels.delete(uriKey);
            // Clean up any leftover timer
            const timer = this._autoSaveTimers.get(uriKey);
            if (timer !== undefined) {
                clearTimeout(timer);
                this._autoSaveTimers.delete(uriKey);
            }

        });

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "dist"),
                // Allow access to workspace folders (for displaying local images)
                ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
                // Allow access to the directory containing the .md file (outside the workspace or untitled)
                vscode.Uri.joinPath(document.uri, '..'),
                ...this._getCustomResourceRoots(document.uri),
            ],
        };
        webviewPanel.webview.html = this._getHtmlForWebview(
            webviewPanel.webview,
            document,
        );

        // When the panel is activated (e.g. clicking an already-open file from global search), check and send the pending navigation line
        // Only handle panels that are already initialized (ready), to avoid prematurely consuming the pending navigation when a new panel is created
        webviewPanel.onDidChangeViewState(({ webviewPanel: p }) => {
            if (!p.active) { return; }
            if (!this._initializedPanels.has(uriKey)) { return; }
            const line = this._consumePendingNavigation(document.uri.fsPath)
                ?? this._consumeGlobalRevealLine();
            if (line !== undefined) {
                console.log('[viewState] immediate scrollToLine:', line);
                p.webview.postMessage({ type: "scrollToLine", line });
                return;
            }
            // revealLine may fire after the viewState change (global search timing is unpredictable)
            // Delay 1000ms and check the global fallback line or pending navigation again
            setTimeout(() => {
                try {
                    if (!p.active) { return; }
                } catch {
                    return; // Panel already destroyed (e.g. the preview tab was replaced); ignore
                }
                const delayedLine = this._consumePendingNavigation(document.uri.fsPath)
                    ?? this._consumeGlobalRevealLine();
                if (delayedLine !== undefined) {
                    console.log('[viewState] delayed scrollToLine:', delayedLine);
                    p.webview.postMessage({ type: "scrollToLine", line: delayedLine });
                }
            }, 1000);
        });

        webviewPanel.webview.onDidReceiveMessage(
            async (message: ToExtensionMessage) => {
                const panel = webviewPanel;
                switch (message.type) {
                    case "ready": {
                        // Mark the panel as initialized; only after this will onDidChangeViewState handle pending navigation
                        this._initializedPanels.add(uriKey);
                        const initContent = document.getText();
                        const displayContent = this._prepareContentForDisplay(initContent, document, webviewPanel, uriKey);
                        // Consume the pending navigation (set when switching preview / first opening from global search)
                        const scrollToLine = this._consumePendingNavigation(document.uri.fsPath)
                            ?? this._consumeGlobalRevealLine();
                        console.log('[ready] scrollToLine:', scrollToLine);
                        const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
                        const tableWrap = cfg.get<TableWrapMode>("tableWrap", "normal");
                        // Reset the stabilization baseline (a new init means the content will be reloaded from disk)
                        webviewPanel.webview.postMessage({
                            type: "init",
                            content: displayContent,
                            lineMap: computeLineMap(initContent),
                            frontmatter: this._frontmatterMap.get(uriKey) || undefined,
                            imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
                            tableWrap,
                            ...(scrollToLine !== undefined ? { scrollToLine } : {}),
                        });
                        // Apply the theme
                        this._applyThemeToPanel(webviewPanel);
                        break;
                    }
                    case "update":
                        if (message.content !== undefined) {
                            const newContent = this._prepareContentForSave(message.content, uriKey);
                            // If the content is identical to the current in-memory version, skip auto-save:
                            // the WebView-side isSettled flag already blocks init-triggered updates; this is the last line of defense against infinite loops
                            if (newContent === document.getText()) { break; }
                            document.update(newContent);
                            // Pin the tab on first edit (remove the italic preview state)
                            if (!this._pinnedDocuments.has(uriKey)) {
                                this._pinnedDocuments.add(uriKey);
                                vscode.commands.executeCommand('workbench.action.keepEditor');
                            }
                            this._scheduleAutoSaveOrMarkDirty(document);
                        }
                        break;
                    case "frontmatterUpdate": {
                        // The WebView edited the frontmatter panel; sync it to the Extension and trigger a save
                        const oldFm = this._frontmatterMap.get(uriKey) ?? "";
                        const newFm = message.frontmatter;
                        if (oldFm === newFm) { break; }
                        this._frontmatterMap.set(uriKey, newFm);
                        // Extract the body from the current document content (dropping the old frontmatter) and prepend the new frontmatter
                        const currentText = document.getText();
                        const { body } = extractFrontmatter(currentText);
                        const fullContent = newFm + body;
                        if (fullContent === currentText) { break; }
                        document.update(fullContent);
                        if (!this._pinnedDocuments.has(uriKey)) {
                            this._pinnedDocuments.add(uriKey);
                            vscode.commands.executeCommand('workbench.action.keepEditor');
                        }
                        this._scheduleAutoSaveOrMarkDirty(document);
                        break;
                    }
                    case "openUrl":
                        if (message.url && isSafeExternalUrl(message.url)) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case "openFile": {
                        if (!message.path) break;

                        // If the current tab is in preview state (italic), pin the current file first
                        let currentIsPreview = false;
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                if (
                                    tab.input instanceof vscode.TabInputCustom &&
                                    (tab.input as vscode.TabInputCustom).uri.toString() === document.uri.toString()
                                ) {
                                    currentIsPreview = tab.isPreview;
                                    break;
                                }
                            }
                        }
                        if (currentIsPreview) {
                            this._pinnedDocuments.add(uriKey);
                            vscode.commands.executeCommand('workbench.action.keepEditor');
                        }

                        // Separate the path from the line-number fragment (e.g. ./file.md#27-30)
                        const hashIdx = message.path.indexOf("#");
                        const filePath = hashIdx >= 0 ? message.path.slice(0, hashIdx) : message.path;
                        const fragment = hashIdx >= 0 ? message.path.slice(hashIdx + 1) : undefined;
                        const lineMatch = fragment?.match(/^(\d+)(-\d+)?$/);
                        const lineNumber = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

                        let absPath: string;
                        if (filePath.startsWith("@/")) {
                            // @/ denotes the workspace root: find the workspace folder containing the current document
                            const docFsPath = document.uri.fsPath;
                            const sep = path.sep;
                            const containingFolder = vscode.workspace.workspaceFolders?.find(
                                f => docFsPath.startsWith(f.uri.fsPath + sep),
                            );
                            const workspaceRoot =
                                containingFolder?.uri.fsPath ??
                                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                            absPath = workspaceRoot
                                ? path.join(workspaceRoot, filePath.slice(2))
                                : path.resolve(path.dirname(docFsPath), "..", filePath.slice(2));
                        } else {
                            const docDir = path.dirname(document.uri.fsPath);
                            absPath = path.resolve(docDir, filePath);
                        }

                        const targetUri = vscode.Uri.file(absPath);
                        if (/\.(md|markdown)$/i.test(absPath)) {
                            // .md file: open with WYSIWYG preview; the line number is passed via setPendingNavigation
                            if (lineNumber !== undefined) {
                                this.setPendingNavigation(absPath, lineNumber);
                            }
                            await vscode.commands.executeCommand(
                                "vscode.openWith",
                                targetUri,
                                MarkdownEditorProvider.viewType,
                                { preview: true },
                            );
                        } else if (lineNumber !== undefined) {
                            // Non-.md with a line number: use showTextDocument to jump to the given line
                            const doc = await vscode.workspace.openTextDocument(targetUri);
                            await vscode.window.showTextDocument(doc, {
                                selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0),
                                preview: true,
                            });
                        } else {
                            vscode.commands.executeCommand("vscode.open", targetUri);
                        }
                        break;
                    }
                    case "switchToTextEditor": {
                        // Suppress the upcoming onDidChangeActiveTextEditor line-number callback (within 1.5s)
                        this.suppressNavFromTextEditor();
                        // Suppress the automatic WYSIWYG switch from onDidChangeTabs (to prevent switching back)
                        MarkdownEditorProvider.suppressAutoSwitch.add(document.uri.toString());
                        setTimeout(() => MarkdownEditorProvider.suppressAutoSwitch.delete(document.uri.toString()), 2000);
                        const textDoc = await vscode.workspace.openTextDocument(document.uri);
                        const viewCol = webviewPanel.viewColumn;

                        // Read the current WYSIWYG tab's preview state (italic = isPreview: true)
                        let isPreview = false;
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                if (
                                    tab.input instanceof vscode.TabInputCustom &&
                                    (tab.input as vscode.TabInputCustom).uri.toString() === document.uri.toString()
                                ) {
                                    isPreview = tab.isPreview;
                                    break;
                                }
                            }
                        }

                        const opts: vscode.TextDocumentShowOptions = {
                            viewColumn: viewCol,
                            preview: isPreview,   // Preserve the original tab's italic/non-italic state
                            preserveFocus: false,
                        };
                        if (message.line && message.line > 0) {
                            const pos = new vscode.Position(message.line - 1, 0);
                            opts.selection = new vscode.Range(pos, pos);
                        }

                        // Close the WYSIWYG tab first, then open the text editor, to avoid flicker from both tabs coexisting
                        webviewPanel.dispose();
                        await vscode.window.showTextDocument(textDoc, opts);
                        break;
                    }
                    case "sendToClaudeChat":
                        if (message.text) {
                            await this._handleSendToClaudeChat(
                                document, webviewPanel,
                                message.text,
                                message.startLine ?? 1,
                                message.endLine   ?? (message.startLine ?? 1),
                            );
                        }
                        break;
                    case "openSettings":
                        vscode.commands.executeCommand('workbench.action.openSettings', 'markdownWysiwyg');
                        break;
                    case "uploadImage":
                        if (message.id && message.data) {
                            this._handleImageUpload(
                                document, panel,
                                message.id,
                                message.data,
                                message.mimeType ?? 'image/png',
                                message.altText ?? '',
                            ).catch(() => {});
                        }
                        break;
                    case "getProjectImages":
                        if (message.id) {
                            this._handleGetProjectImages(document, panel, uriKey, message.id).catch(() => {});
                        }
                        break;
                    case "renameImage":
                        if (message.id && message.webviewUri && message.newBasename) {
                            this._handleImageRename(
                                document, panel, uriKey,
                                message.id,
                                message.webviewUri,
                                message.newBasename,
                            ).catch(() => {});
                        }
                        break;
                    case "getPathSuggestions":
                        if (message.id && message.query !== undefined) {
                            this._handleGetPathSuggestions(document, panel, message.id, message.query).catch(() => {});
                        }
                        break;
                    case "resolveImagePath":
                        if (message.id && message.relPath) {
                            this._handleResolveImagePath(document, panel, uriKey, message.id, message.relPath);
                        }
                        break;
                }
            },
        );


        // Watch for external file changes (including writes by AI tools) and auto-sync them to the WebView
        // Note: vscode.workspace.createFileSystemWatcher does not detect files written by the same Extension Host
        // so we use Node.js fs.watch instead, listening to OS-level events directly
        import("fs").then(({ watch: fsWatch }) => {
            let debounceTimer: ReturnType<typeof setTimeout> | undefined;
            const targetFile = path.basename(document.uri.fsPath);
            const fsWatcher = fsWatch(path.dirname(document.uri.fsPath), async (_event, filename) => {
                if (filename !== targetFile) { return; }
                // Debounce: with multiple triggers in a short window, only handle the last one
                if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
                debounceTimer = setTimeout(async () => {
                    debounceTimer = undefined;
                    // If the change was caused by our own auto-save (within 1.5 seconds), skip it
                    const lastSave = this._lastSaveTimes.get(uriKey) ?? 0;
                    if (Date.now() - lastSave < 1500) { return; }
                    const cts = new vscode.CancellationTokenSource();
                    try {
                        await document.revert(cts.token);
                        const panel = this._webviewPanels.get(uriKey);
                        if (panel) {
                            const revertContent = document.getText();
                            const displayContent = this._prepareContentForDisplay(revertContent, document, panel, uriKey);
                            const tableWrap = vscode.workspace.getConfiguration("markdownWysiwyg").get<TableWrapMode>("tableWrap", "normal");
                            panel.webview.postMessage({ type: "revert", content: displayContent, lineMap: computeLineMap(revertContent), frontmatter: this._frontmatterMap.get(uriKey) || undefined, imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []), tableWrap });
                        }
                    } finally {
                        cts.dispose();
                    }
                }, 200);
            });
            // Dispose the watcher when the panel closes
            webviewPanel.onDidDispose(() => { fsWatcher.close(); });
        });
    }

    private _scheduleAutoSaveOrMarkDirty(document: MarkdownDocument): void {
        const config = vscode.workspace.getConfiguration("markdownWysiwyg");
        const autoSave = config.get<boolean>("autoSave", true);
        const delay = config.get<number>("autoSaveDelay", 1000);
        const uriKey = document.uri.toString();

        if (autoSave) {
            // Debounced auto-save: write to disk delay ms after editing stops, without showing the ● marker
            const existing = this._autoSaveTimers.get(uriKey);
            if (existing !== undefined) {
                clearTimeout(existing);
            }
            this._autoSaveTimers.set(
                uriKey,
                setTimeout(async () => {
                    this._autoSaveTimers.delete(uriKey);
                    const cts = new vscode.CancellationTokenSource();
                    try {
                        await document.save(cts.token);
                        // Record the time only after the write completes, so the timestamp is accurate when FileWatcher fires
                        // (If recorded before save, the protection fails when FileWatcher is delayed by > 1500ms)
                        this._lastSaveTimes.set(uriKey, Date.now());
                        const panel = this._webviewPanels.get(uriKey);
                        if (panel) {
                            panel.webview.postMessage({ type: "lineMapUpdate", lineMap: computeLineMap(document.getText()) });
                        }
                    } finally {
                        cts.dispose();
                    }
                }, delay),
            );
        } else {
            // Manual save mode: mark as dirty and wait for Cmd+S
            this._onDidChangeCustomDocument.fire({
                document,
                label: "Edit",
                undo: () => { /* TODO */ },
                redo: () => { /* TODO */ },
            });
        }
    }

    private async _handleSendToClaudeChat(
        document: MarkdownDocument,
        webviewPanel: vscode.WebviewPanel,
        text: string,
        startLine: number,
        endLine: number,
    ): Promise<void> {
        const relPath = vscode.workspace.asRelativePath(document.uri);
        const mentionStr = startLine === endLine
            ? `@${relPath}#${startLine}`
            : `@${relPath}#${startLine}-${endLine}`;
        let success = false;
        console.log('[sendToClaudeChat] triggered, file:', relPath, 'lines:', startLine, '-', endLine);

        try {
            // Path A: terminal Claude
            // Heuristic: state.shell is missing → VSCode can't recognize it as a standard shell → likely the claude CLI
            const isClaudeLikeTerminal = (t: vscode.Terminal) =>
                !(t.state as { shell?: string }).shell;

            const claudeTerminal =
                [...this.claudeTerminals].at(-1)                          // ① Shell Integration detection
                ?? vscode.window.terminals.find(isClaudeLikeTerminal)     // ② state.shell missing
                ?? undefined;  // Don't fall back to activeTerminal, to avoid mistakenly sending to a plain shell
            console.log(claudeTerminal,"terminal:", vscode.window.terminals);

            if (claudeTerminal) {
                claudeTerminal.sendText(mentionStr, false);
                await vscode.commands.executeCommand('workbench.action.terminal.focus');
                success = true;
                console.log('[sendToClaudeChat] sent to terminal');
            }

            // Path B: VSCode Claude extension
            if (!success) {
                // Fix 3: open the temporary text editor in the same column (avoids layout flicker from creating a new column)
                // Use preview: false to avoid replacing the custom editor tab that's in preview state
                const textDoc    = await vscode.workspace.openTextDocument(document.uri);
                const textEditor = await vscode.window.showTextDocument(textDoc, {
                    viewColumn:    webviewPanel.viewColumn,
                    preview:       false,
                    preserveFocus: false,
                });
                const setSelection = () => {
                    textEditor.selection = new vscode.Selection(
                        new vscode.Position(startLine - 1, 0),
                        new vscode.Position(endLine   - 1, 9999),
                    );
                };
                setSelection();

                // Fix 2: check whether Claude is already open, splitting into two paths to avoid losing activeTextEditor
                const claudeOpen = vscode.window.tabGroups.all.some(g =>
                    g.tabs.some(t =>
                        t.input instanceof vscode.TabInputWebview &&
                        (t.input as vscode.TabInputWebview).viewType.includes('claudeVSCodePanel')
                    )
                );
                console.log('[sendToClaudeChat] claudeOpen:', claudeOpen);

                if (claudeOpen) {
                    await vscode.commands.executeCommand('claude-vscode.focus');
                } else {
                    await vscode.commands.executeCommand('claude-vscode.editor.openLast');
                    await new Promise(r => setTimeout(r, 700));
                    await vscode.window.showTextDocument(textDoc, {
                        viewColumn:    textEditor.viewColumn,
                        preview:       false,
                        preserveFocus: false,
                    });
                    setSelection();
                    await vscode.commands.executeCommand('claude-vscode.insertAtMention');
                }
                success = true;

                // Close the temporary text editor
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        if (tab.input instanceof vscode.TabInputText &&
                            (tab.input as vscode.TabInputText).uri.toString() === document.uri.toString()) {
                            await vscode.window.tabGroups.close(tab);
                            break;
                        }
                    }
                }
                // Bring the custom editor back to the foreground (so it isn't hidden after the temporary text editor closes)
                webviewPanel.reveal(webviewPanel.viewColumn, false);
                console.log('[sendToClaudeChat] done');
            }
        } catch (_e) {
            console.log('[sendToClaudeChat] failed:', _e);
        }

        if (!success) {
            // Path C: fall back to VSCode's built-in chat
            const query = `@${relPath}\n\n${text}`;
            console.log('[sendToClaudeChat] fallback chat.open');
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', { query });
            } catch (_e) {
                vscode.window.showErrorMessage(vscode.l10n.t('Cannot open chat: please install Claude extension or GitHub Copilot'));
            }
        }
    }

    async saveCustomDocument(
        document: MarkdownDocument,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        // Clear the auto-save timer (Cmd+S saves immediately, no need to wait for the timer)
        const uriKey = document.uri.toString();
        const timer = this._autoSaveTimers.get(uriKey);
        if (timer !== undefined) {
            clearTimeout(timer);
            this._autoSaveTimers.delete(uriKey);
        }
        this._lastSaveTimes.set(uriKey, Date.now());
        await document.save(cancellation);
        const panel = this._webviewPanels.get(uriKey);
        if (panel) {
            panel.webview.postMessage({ type: "lineMapUpdate", lineMap: computeLineMap(document.getText()) });
        }
    }

    async saveCustomDocumentAs(
        document: MarkdownDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        await document.saveAs(destination, cancellation);
    }

    async revertCustomDocument(
        document: MarkdownDocument,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        await document.revert(cancellation);
        // Push the new content to the WebView to trigger an editor rebuild
        const uriKey = document.uri.toString();
        const panel = this._webviewPanels.get(uriKey);
        if (panel) {
            const revertContent = document.getText();
            const displayContent = this._prepareContentForDisplay(revertContent, document, panel, uriKey);
            panel.webview.postMessage({
                type: "revert",
                content: displayContent,
                lineMap: computeLineMap(revertContent),
                frontmatter: this._frontmatterMap.get(uriKey) || undefined,
                imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
            });
        }
    }

    async backupCustomDocument(
        document: MarkdownDocument,
        context: vscode.CustomDocumentBackupContext,
        cancellation: vscode.CancellationToken,
    ): Promise<vscode.CustomDocumentBackup> {
        return document.backup(context.destination, cancellation);
    }

    private _getHtmlForWebview(webview: vscode.Webview, document: MarkdownDocument): string {
        const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
        const maxHeight = cfg.get<number>("codeBlockMaxHeight", 500);
        const editorMaxWidth = this._getEditorMaxWidthCssValue(cfg.get<number | string>("editorMaxWidth", "auto"));
        const tocContentGap = this._getPixelSettingCssValue(cfg.get<number>("tocContentGap", 100), 100, 16, 240);
        const tocRight = cfg.get<string>("tocPosition", "left") === "right";
        const isAutoWidth = editorMaxWidth === "none";
        const fontFamily = cfg.get<string>("fontFamily", "");
        const imageSelectionColor = cfg.get<string>("imageSelectionColor", "rgba(52, 211, 153, 0.6)");
        const customCssUris = this._getCustomResourceUris(webview, document.uri, cfg.get<string[]>("customCss", []));
        const customJsUris = this._getCustomResourceUris(webview, document.uri, cfg.get<string[]>("customJs", []));
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                "dist",
                "webview.js",
            ),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                "dist",
                "webview.css",
            ),
        );
        const nonce = getNonce();

        const isMac = process.platform === 'darwin';
        const translations = {};
        const debugMode = cfg.get<boolean>("debugMode", false);
        const codeBlockAutoConvert = cfg.get<boolean>("codeBlockAutoConvert", true);
        const codeBlockWordWrap = this._getCodeBlockWordWrap(document.uri, cfg);
        const tocAutoHideThreshold = this._getNumberSettingValue(cfg.get<number>("tocAutoHideThreshold", 3), 3, 0, 20);
        const i18nScript = `window.__i18n=${JSON.stringify({ translations, isMac, debugMode, codeBlockAutoConvert, codeBlockWordWrap, tocAutoHideThreshold })};`;
        const bodyClasses = [
            isAutoWidth ? "editor-width-auto" : "",
            codeBlockWordWrap ? "code-block-word-wrap" : "",
            tocRight ? "toc-right" : "",
        ].filter(Boolean).join(" ");

        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}' ${webview.cspSource};
             img-src ${webview.cspSource} data:;">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Markdown Editor</title>
	  <link rel="stylesheet" href="${styleUri}">
	  ${customCssUris.map(uri => `<link rel="stylesheet" href="${uri}">`).join("\n  ")}
	  <style>:root { --code-block-max-height: ${maxHeight}px; --editor-max-width: ${editorMaxWidth}; --toc-width: 220px; --toc-tab-width: 20px; --toc-content-gap: ${tocContentGap};${fontFamily ? ` --custom-font-family: ${fontFamily};` : ''} --image-selection-color: ${imageSelectionColor}; }</style>
	</head>
	<body class="${bodyClasses}">
	  <div class="editor-topbar"></div>
	  <div id="editor"></div>
	  <script nonce="${nonce}">${i18nScript}</script>
	  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
	  ${customJsUris.map(uri => `<script type="module" nonce="${nonce}" src="${uri}"></script>`).join("\n  ")}
	</body>
	</html>`;
    }

    private _getEditorMaxWidthCssValue(value: number | string | undefined): string {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return `${Math.max(400, Math.round(value))}px`;
        }
        if (typeof value === "string") {
            const trimmed = value.trim().toLowerCase();
            if (trimmed === "auto" || trimmed === "") {
                return "none";
            }
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric) && numeric > 0) {
                return `${Math.max(400, Math.round(numeric))}px`;
            }
        }
        return "none";
    }

    private _getPixelSettingCssValue(
        value: number | undefined,
        fallback: number,
        min: number,
        max: number,
    ): string {
        if (!Number.isFinite(value)) {
            return `${fallback}px`;
        }
        return `${Math.min(max, Math.max(min, Math.round(value as number)))}px`;
    }

    private _getNumberSettingValue(
        value: number | undefined,
        fallback: number,
        min: number,
        max: number,
    ): number {
        if (!Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, Math.round(value as number)));
    }

    private _getCodeBlockWordWrap(
        documentUri: vscode.Uri,
        cfg: vscode.WorkspaceConfiguration,
    ): boolean {
        const value = cfg.get<"inherit" | "on" | "off">("codeBlockWordWrap", "inherit");
        if (value === "on") {
            return true;
        }
        if (value === "off") {
            return false;
        }

        const editorWordWrap = vscode.workspace
            .getConfiguration("editor", documentUri)
            .get<string>("wordWrap", "off");
        return editorWordWrap !== "off";
    }

    private _getCustomResourceRoots(documentUri: vscode.Uri): vscode.Uri[] {
        const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
        const paths = [
            ...cfg.get<string[]>("customCss", []),
            ...cfg.get<string[]>("customJs", []),
        ];
        const roots: vscode.Uri[] = [];
        const seen = new Set<string>();
        for (const resourcePath of paths) {
            const uri = this._resolveCustomResourceUri(resourcePath, documentUri);
            if (!uri) { continue; }
            const root = vscode.Uri.file(path.dirname(uri.fsPath));
            const key = root.toString();
            if (!seen.has(key)) {
                seen.add(key);
                roots.push(root);
            }
        }
        return roots;
    }

    private _getCustomResourceUris(
        webview: vscode.Webview,
        documentUri: vscode.Uri,
        resourcePaths: string[] | undefined,
    ): string[] {
        return (resourcePaths ?? [])
            .map(resourcePath => this._resolveCustomResourceUri(resourcePath, documentUri))
            .filter((uri): uri is vscode.Uri => Boolean(uri))
            .map(uri => webview.asWebviewUri(uri).toString());
    }

    private _resolveCustomResourceUri(resourcePath: string, documentUri: vscode.Uri): vscode.Uri | undefined {
        const trimmed = resourcePath.trim();
        if (!trimmed) { return undefined; }

        const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let resolved = workspaceRoot
            ? trimmed
                .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
                .replace(/\$\{workspaceRoot\}/g, workspaceRoot)
            : trimmed;
        if (resolved.startsWith("~/")) {
            resolved = path.join(os.homedir(), resolved.slice(2));
        } else if (resolved === "~") {
            resolved = os.homedir();
        } else if (!path.isAbsolute(resolved)) {
            const baseDir = workspaceRoot
                ?? (documentUri.scheme === "file" ? path.dirname(documentUri.fsPath) : undefined);
            if (!baseDir) { return undefined; }
            resolved = path.join(baseDir, resolved);
        }

        return vscode.Uri.file(resolved);
    }

    private _prepareContentForDisplay(
        content: string,
        document: MarkdownDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
    ): string {
        const { frontmatter, body } = extractFrontmatter(content);
        this._frontmatterMap.set(uriKey, frontmatter);
        content = body;

        if (document.uri.scheme !== 'file') { return content; }
        const mdDir = path.dirname(document.uri.fsPath);
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
        this._imageUriMaps.set(uriKey, uriMap);
        return content.replace(/!\[([^\]]*)\]\(([^)\s"]+)/g, (match, alt, src) => {
            if (/^(https?:|data:|vscode-resource:|vscode-webview-)/.test(src)) { return match; }
            try {
                let absPath: string;
                if (src.startsWith('@/')) {
                    // @/ is the workspace-root alias, resolved to the workspace root directory
                    const root = workspaceRoot ?? mdDir;
                    absPath = path.join(root, src.slice(2));
                } else {
                    absPath = path.resolve(mdDir, src);
                }
                const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
                uriMap.set(webviewUri, src);
                return `![${alt}](${webviewUri}`;
            } catch {
                return match;
            }
        });
    }

    private _prepareContentForSave(content: string, uriKey: string): string {
        const frontmatter = this._frontmatterMap.get(uriKey) ?? "";
        const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
        return restoreContentForSave(content, frontmatter, uriMap);
    }

    private async _handleImageUpload(
        document: MarkdownDocument,
        panel: vscode.WebviewPanel,
        id: string,
        data: Uint8Array,
        mimeType: string,
        altText: string,
    ): Promise<void> {
        const uriKey = document.uri.toString();
        const cfg = vscode.workspace.getConfiguration('markdownWysiwyg', document.uri);
        const storage = cfg.get<string>('imageStorage', 'local');
        try {
            let url: string;
            if (storage === 'server') {
                url = await uploadImageToServer(cfg, data, mimeType, altText);
            } else {
                const { relPath, absUri } = await saveImageLocally(document.uri, cfg, data, mimeType, altText);
                const webviewUri = panel.webview.asWebviewUri(absUri);
                url = webviewUri.toString();
                // Store the mapping so that on save, webviewUri is replaced back with relPath
                const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
                this._imageUriMaps.set(uriKey, uriMap);
                uriMap.set(url, relPath);
            }
            panel.webview.postMessage({ type: 'imageUploaded', id, url });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            panel.webview.postMessage({ type: 'imageUploadError', id, error: errMsg });
            vscode.window.showErrorMessage(vscode.l10n.t('Image upload failed: {0}', errMsg));
        }
    }

    private async _handleGetProjectImages(
        document: MarkdownDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
        id: string,
    ): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('markdownWysiwyg', document.uri);
        const customPath = cfg.get<string>('imageLocalPath', '').trim();
        const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico']);
        const CANDIDATE_DIRS = ['images', 'imgs', 'assets/images', 'assets'];

        let targetDir: vscode.Uri | null = null;

        if (customPath) {
            if (path.isAbsolute(customPath)) {
                targetDir = vscode.Uri.file(customPath);
            } else {
                const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                targetDir = wsFolder
                    ? vscode.Uri.joinPath(wsFolder.uri, customPath)
                    : vscode.Uri.joinPath(document.uri, '..', customPath);
            }
        } else if (document.uri.scheme === 'file') {
            const mdDir = vscode.Uri.joinPath(document.uri, '..');
            const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            const searchRoots = wsFolder ? [wsFolder.uri, mdDir] : [mdDir];
            outer: for (const root of searchRoots) {
                for (const candidate of CANDIDATE_DIRS) {
                    const candidateUri = vscode.Uri.joinPath(root, candidate);
                    try {
                        const stat = await vscode.workspace.fs.stat(candidateUri);
                        if (stat.type === vscode.FileType.Directory) {
                            targetDir = candidateUri;
                            break outer;
                        }
                    } catch { /* not found */ }
                }
            }
        }

        const images: Array<{ relPath: string; webviewUri: string; name: string }> = [];

        if (targetDir) {
            const mdDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : '';
            const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
            this._imageUriMaps.set(uriKey, uriMap);
            try {
                const entries = await vscode.workspace.fs.readDirectory(targetDir);
                for (const [name, type] of entries) {
                    if (type !== vscode.FileType.File) { continue; }
                    const ext = path.extname(name).toLowerCase();
                    if (!IMAGE_EXTS.has(ext)) { continue; }
                    const fileUri = vscode.Uri.joinPath(targetDir, name);
                    const wvUri = panel.webview.asWebviewUri(fileUri).toString();
                    let relPath = name;
                    if (mdDir) {
                        const rel = path.relative(mdDir, fileUri.fsPath).replace(/\\/g, '/');
                        relPath = rel.startsWith('.') ? rel : './' + rel;
                    }
                    uriMap.set(wvUri, relPath);
                    images.push({ relPath, webviewUri: wvUri, name });
                }
            } catch { /* directory not accessible */ }
        }

        panel.webview.postMessage({ type: 'projectImagesList', id, images });
    }

    private async _handleImageRename(
        document: MarkdownDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
        id: string,
        webviewUri: string,
        newBasename: string,
    ): Promise<void> {
        const uriMap = this._imageUriMaps.get(uriKey);
        if (!uriMap) {
            panel.webview.postMessage({ type: 'imageRenameError', id, error: 'URI map not found' });
            return;
        }

        const oldRelPath = uriMap.get(webviewUri);
        if (!oldRelPath) {
            panel.webview.postMessage({ type: 'imageRenameError', id, error: 'Image not found in URI map' });
            return;
        }

        try {
            const mdDir = path.dirname(document.uri.fsPath);
            const oldAbsPath = path.resolve(mdDir, oldRelPath);
            const oldUri = vscode.Uri.file(oldAbsPath);

            // Verify the file exists
            await vscode.workspace.fs.stat(oldUri);

            // Sanitize the new filename: strip illegal characters, keep the original extension
            const oldExt = path.extname(oldAbsPath);
            const safeBasename = newBasename
                .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
                .replace(/\.+$/, '')
                .trim();
            if (!safeBasename) {
                panel.webview.postMessage({ type: 'imageRenameError', id, error: 'Invalid filename' });
                return;
            }

            const dir = path.dirname(oldAbsPath);
            let targetUri = vscode.Uri.file(path.join(dir, safeBasename + oldExt));

            // Check whether the target file already exists; if so, warn the user and don't overwrite automatically
            try {
                await vscode.workspace.fs.stat(targetUri);
                // A successful stat means the file already exists
                const errMsg = vscode.l10n.t('A file named "{0}" already exists.', safeBasename + oldExt);
                panel.webview.postMessage({ type: 'imageRenameError', id, error: errMsg });
                vscode.window.showErrorMessage(errMsg);
                return;
            } catch { /* File doesn't exist, continue normally */ }

            await vscode.workspace.fs.rename(oldUri, targetUri);

            // Update the URI mapping
            const rel = path.relative(mdDir, targetUri.fsPath).replace(/\\/g, '/');
            const newRelPath = rel.startsWith('.') ? rel : './' + rel;
            const newWebviewUri = panel.webview.asWebviewUri(targetUri).toString();

            uriMap.delete(webviewUri);
            uriMap.set(newWebviewUri, newRelPath);

            panel.webview.postMessage({ type: 'imageRenamed', id, oldWebviewUri: webviewUri, newWebviewUri });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            panel.webview.postMessage({ type: 'imageRenameError', id, error: errMsg });
            vscode.window.showErrorMessage(vscode.l10n.t('Image rename failed: {0}', errMsg));
        }
    }

    private async _handleGetPathSuggestions(
        document: MarkdownDocument,
        panel: vscode.WebviewPanel,
        id: string,
        query: string,
    ): Promise<void> {
        const q = query.trim();
        if (!q) {
            panel.webview.postMessage({ type: 'pathSuggestions', id, items: [] });
            return;
        }

        const docFsPath = document.uri.fsPath;
        const docDir = path.dirname(docFsPath);
        const sep = path.sep;
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(
            f => docFsPath.startsWith(f.uri.fsPath + sep),
        ) ?? vscode.workspace.workspaceFolders?.[0];
        const workspaceRoot = workspaceFolder?.uri.fsPath;

        // Split at the last "/" into a directory part and a name prefix
        const lastSlash = q.lastIndexOf('/');
        const dirPart = lastSlash >= 0 ? q.slice(0, lastSlash + 1) : '';
        const namePart = lastSlash >= 0 ? q.slice(lastSlash + 1) : q;

        // Resolve dirPart to an absolute path
        let absDir: string;
        if (dirPart.startsWith('@/')) {
            absDir = workspaceRoot
                ? path.join(workspaceRoot, dirPart.slice(2))
                : docDir;
        } else if (dirPart === '' || dirPart.startsWith('./') || dirPart.startsWith('../')) {
            absDir = path.resolve(docDir, dirPart || '.');
        } else {
            absDir = path.resolve(docDir, dirPart);
        }

        // readDirectory lists the direct children (with file types)
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absDir));
        } catch {
            panel.webview.postMessage({ type: 'pathSuggestions', id, items: [] });
            return;
        }

        const IGNORE = new Set(['node_modules', '.git', 'dist', '.DS_Store', 'out', '.vscode-test']);
        const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico']);
        const uriKey = document.uri.toString();
        const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
        this._imageUriMaps.set(uriKey, uriMap);
        const items = entries
            .filter(([name, type]) =>
                !IGNORE.has(name) &&
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
                const fullPath = dirPart + name + (type === vscode.FileType.Directory ? '/' : '');
                let webviewUri: string | undefined;
                if (type === vscode.FileType.File) {
                    const ext = path.extname(name).toLowerCase();
                    if (IMAGE_EXTS.has(ext)) {
                        const absFilePath = path.join(absDir, name);
                        webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(absFilePath)).toString();
                        // Register the mapping so _prepareContentForSave can convert it back to a relative path on save
                        uriMap.set(webviewUri, fullPath);
                    }
                }
                return { path: fullPath, isDir: type === vscode.FileType.Directory, webviewUri };
            });

        panel.webview.postMessage({ type: 'pathSuggestions', id, items });
    }

    private _handleResolveImagePath(
        document: MarkdownDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
        id: string,
        relPath: string,
    ): void {
        if (document.uri.scheme !== 'file') { return; }
        const mdDir = path.dirname(document.uri.fsPath);
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
            let absPath: string;
            if (relPath.startsWith('@/')) {
                const root = workspaceRoot ?? mdDir;
                absPath = path.join(root, relPath.slice(2));
            } else {
                absPath = path.resolve(mdDir, relPath);
            }
            const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
            // Register the mapping so it can be restored on save
            const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
            this._imageUriMaps.set(uriKey, uriMap);
            uriMap.set(webviewUri, relPath);
            panel.webview.postMessage({ type: 'imagePathResolved', id, webviewUri });
        } catch { /* Invalid path, no response */ }
    }
}
