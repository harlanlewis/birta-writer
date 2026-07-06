import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { getNonce } from "./utils/getNonce";
import { computeReplaceRange } from "./utils/textEdit";
import { saveImageLocally } from "./utils/imageService";
import { computeLineMap } from "./utils/lineMap";
import { extractFrontmatter, restoreContentForSave } from "./utils/contentTransform";
import { extractListValuesByKey, rankListValues } from "./utils/frontmatterSuggestions";
import { buildLinkTargetItems } from "./utils/linkTargetSuggestions";
import { isLocalPathQuery, rankLinkTargets } from "../shared/linkTargetSuggest";
import { lintBlocks } from "./utils/harperService";
import { resolveThemeColors } from "./themeManager";
import type { ToExtensionMessage, ToWebviewMessage, TableWrapMode, ProofreadConfig, ProofreadOptionKey, ToolbarConfig, FontPreset } from "../shared/messages";
import type { EditorCommandId } from "../shared/editorCommands";
import { resolveFontFamily, DEFAULT_FONT_PRESET } from "../shared/fontPresets";

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
    implements vscode.CustomTextEditorProvider {
    public static readonly viewType = "markdownWriter.editor";

    // Auto-save debounce timers (key: document uri string)
    private readonly _autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Tracks the webviewPanel for each document (used to push new content on external changes)
    private readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();

    // The panel that is currently the active editor. Command-palette and
    // right-click commands (MAR-9) target it. Set on resolve and whenever a
    // panel becomes active; cleared when the active panel is disposed.
    private _activePanel: vscode.WebviewPanel | null = null;

    // URIs that have already run keepEditor (pin tab), to avoid running it again
    private readonly _pinnedDocuments = new Set<string>();

    // File-space text the webview last produced or was last sent (key: uriKey).
    // onDidChangeTextDocument compares against this to tell webview-originated
    // edits (echoes of our own applyEdit) from genuine external changes.
    private readonly _lastSyncedText = new Map<string, string>();

    // Authoritative sync version per document (key: uriKey). Bumped on every
    // externalUpdate push (external text-editor edit, undo/redo, git, hot-exit
    // restore). The webview echoes the version it last applied back as
    // `baseSyncVersion`; a content update whose base doesn't match the current
    // version was serialized against content we've since replaced, so it is
    // dropped and the current state is re-pushed.
    private readonly _syncVersion = new Map<string, number>();

    // Per-document promise chain serializing webview-originated WorkspaceEdits,
    // so a second update can never race the applyEdit (and its change event)
    // of the first.
    private readonly _editQueues = new Map<string, Promise<void>>();

    // Image webviewUri → relPath mapping (key: docUri.toString())
    private readonly _imageUriMaps = new Map<string, Map<string, string>>();
    private readonly _frontmatterMap = new Map<string, string>(); // uriKey → raw frontmatter string

    // Workspace-wide frontmatter list-value scan, cached for a short TTL so
    // repeated "+" menu opens stay snappy (fsPath → key → list values).
    private _fmScanCache: { perFile: Map<string, ReadonlyMap<string, string[]>>; expires: number } | undefined;
    private static readonly _FM_SCAN_TTL_MS = 30_000;

    // Workspace file list cache for link target suggestions — avoids re-running
    // findFiles on every debounced keystroke in a link URL input.
    private _linkFileCache: { uris: vscode.Uri[]; expires: number } | undefined;
    private static readonly _LINK_FILE_TTL_MS = 10_000;
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

    /** Sends a message to the active editor panel (no-op when none is active). */
    public postToActivePanel(msg: ToWebviewMessage): void {
        this._activePanel?.webview.postMessage(msg);
    }

    /**
     * Routes an editor command (keybinding / command palette / context menu)
     * to the webview. Target resolution, most to least specific:
     * 1. the panel named by `documentUriStr` (right-click context objects
     *    carry it as a belt-and-braces routing hint);
     * 2. the focused group's active tab — keybindings match per editor group
     *    (`activeCustomEditorId` is group-scoped), and with split editors two
     *    panels are simultaneously "active" in their groups, so
     *    `_activePanel` (last view-state change) may name the wrong split;
     * 3. `_activePanel` as the fallback.
     */
    public postEditorCommand(command: EditorCommandId, documentUriStr?: string, args?: unknown): void {
        const msg: ToWebviewMessage = { type: "editorCommand", command, args };
        const named = documentUriStr ? this._webviewPanels.get(documentUriStr) : undefined;
        if (named) {
            named.webview.postMessage(msg);
            return;
        }
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        if (activeTab?.input instanceof vscode.TabInputCustom) {
            const focused = this._webviewPanels.get(activeTab.input.uri.toString());
            if (focused) {
                focused.webview.postMessage(msg);
                return;
            }
        }
        this.postToActivePanel(msg);
    }

    public async applyThemeToAll(): Promise<void> {
        const themeId = vscode.workspace
            .getConfiguration("markdownWriter")
            .get<string>("colorTheme", "auto");

        const colors = await resolveThemeColors(themeId);
        this.postToAll({ type: "setTheme", colors });
    }

    private async _applyThemeToPanel(panel: vscode.WebviewPanel): Promise<void> {
        const themeId = vscode.workspace
            .getConfiguration("markdownWriter")
            .get<string>("colorTheme", "auto");

        const colors = await resolveThemeColors(themeId);
        panel.webview.postMessage({ type: "setTheme", colors });
    }

    public static register(
        context: vscode.ExtensionContext,
    ): vscode.Disposable {
        const provider = new MarkdownEditorProvider(context);
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
    ) {}

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
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
        // A freshly resolved editor is the active one.
        this._activePanel = webviewPanel;

        webviewPanel.onDidDispose(() => {
            this._webviewPanels.delete(uriKey);
            if (this._activePanel === webviewPanel) { this._activePanel = null; }
            this._pinnedDocuments.delete(uriKey);
            this._imageUriMaps.delete(uriKey);
            this._initializedPanels.delete(uriKey);
            this._lastSyncedText.delete(uriKey);
            this._syncVersion.delete(uriKey);
            this._editQueues.delete(uriKey);
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
            // Track the active panel for command-palette / context-menu routing.
            this._activePanel = p;
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
                        const cfg = vscode.workspace.getConfiguration("markdownWriter");
                        const tableWrap = cfg.get<TableWrapMode>("tableWrap", "normal");
                        // Reset the echo baseline: init hands this exact text to the webview
                        this._lastSyncedText.set(uriKey, initContent);
                        // Reset the sync version so the webview's baseSyncVersion
                        // starts aligned with the extension.
                        this._syncVersion.set(uriKey, 0);
                        webviewPanel.webview.postMessage({
                            type: "init",
                            content: displayContent,
                            lineMap: computeLineMap(initContent),
                            frontmatter: this._frontmatterMap.get(uriKey) || undefined,
                            imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
                            tableWrap,
                            syncVersion: 0,
                            ...(scrollToLine !== undefined ? { scrollToLine } : {}),
                        });
                        // Apply the theme
                        this._applyThemeToPanel(webviewPanel);
                        break;
                    }
                    case "update":
                        if (message.content !== undefined) {
                            // Stale-update rejection: the webview serialized this
                            // against content we've since replaced (an
                            // externalUpdate landed after it read the document).
                            // Drop it and re-push the current authoritative state
                            // so the webview re-bases.
                            const currentVersion = this._syncVersion.get(uriKey) ?? 0;
                            if (message.baseSyncVersion !== currentVersion) {
                                this._pushExternalUpdate(document, webviewPanel, uriKey);
                                break;
                            }
                            const newContent = this._prepareContentForSave(message.content, uriKey);
                            void this._enqueueEdit(uriKey, async () => {
                                // Identical to the current document (e.g. serializer no-op echo): nothing to do
                                const applied = await this._applyWebviewEdit(document, newContent);
                                if (!applied) { return; }
                                this._pinTabOnFirstEdit(uriKey);
                                this._scheduleAutoSave(document);
                                webviewPanel.webview.postMessage({ type: "lineMapUpdate", lineMap: computeLineMap(document.getText()) });
                            });
                        }
                        break;
                    case "frontmatterUpdate": {
                        // Stale-update rejection (same rule as "update"): a
                        // frontmatter edit serialized against replaced content is
                        // dropped and the current state re-pushed.
                        const fmVersion = this._syncVersion.get(uriKey) ?? 0;
                        if (message.baseSyncVersion !== fmVersion) {
                            this._pushExternalUpdate(document, webviewPanel, uriKey);
                            break;
                        }
                        // The WebView edited the frontmatter panel; replace just the frontmatter block
                        const oldFm = this._frontmatterMap.get(uriKey) ?? "";
                        const newFm = message.frontmatter;
                        if (oldFm === newFm) { break; }
                        this._frontmatterMap.set(uriKey, newFm);
                        void this._enqueueEdit(uriKey, async () => {
                            const currentText = document.getText();
                            const { frontmatter } = extractFrontmatter(currentText);
                            const fullContent = newFm + currentText.slice(frontmatter.length);
                            if (fullContent === currentText) { return; }
                            this._lastSyncedText.set(uriKey, fullContent);
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(
                                document.uri,
                                new vscode.Range(document.positionAt(0), document.positionAt(frontmatter.length)),
                                newFm,
                            );
                            const applied = await vscode.workspace.applyEdit(edit);
                            if (!applied) { return; }
                            this._pinTabOnFirstEdit(uriKey);
                            this._scheduleAutoSave(document);
                            webviewPanel.webview.postMessage({ type: "lineMapUpdate", lineMap: computeLineMap(document.getText()) });
                        });
                        break;
                    }
                    case "openUrl":
                        if (message.url && isSafeExternalUrl(message.url)) {
                            this._openExternalUrl(document, message.url);
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
                    case "openSettings":
                        vscode.commands.executeCommand('workbench.action.openSettings', 'markdownWriter');
                        break;
                    case "openKeybindings":
                        // Filtered to this extension's commands; shows the
                        // user's effective (possibly rebound) shortcuts
                        vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'markdownWriter');
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
                    case "getLinkTargetSuggestions":
                        if (message.id && message.query !== undefined) {
                            this._handleGetLinkTargetSuggestions(document, panel, message.id, message.query).catch(() => {});
                        }
                        break;
                    case "resolveImagePath":
                        if (message.id && message.relPath) {
                            this._handleResolveImagePath(document, panel, uriKey, message.id, message.relPath);
                        }
                        break;
                    case "requestFmSuggestions":
                        if (message.key !== undefined) {
                            this._handleRequestFmSuggestions(document, panel, message.key).catch(() => {});
                        }
                        break;
                    case "tocWidth":
                        void this.context.globalState.update(
                            "tocWidth",
                            this._getNumberSettingValue(message.width, 220, 150, 600),
                        );
                        break;
                    // Persisting triggers onDidChangeConfiguration in extension.ts,
                    // which re-broadcasts the config to every open editor.
                    case "setProofreadOption":
                        MarkdownEditorProvider.setProofreadOption(message.key, message.value);
                        break;
                    case "setFontPreset":
                        MarkdownEditorProvider.setFontPreset(message.preset);
                        break;
                    case "setToolbarLayout":
                        if (message.item) {
                            MarkdownEditorProvider.updateSettingRespectingScope(
                                `toolbar.items.${message.item.id}`,
                                message.item.placement,
                            );
                        }
                        MarkdownEditorProvider.updateSettingRespectingScope("toolbar.order", message.order);
                        break;
                    case "spellAddWord":
                        this._handleSpellAddWord(message.word);
                        break;
                    case "lintBlocks":
                        lintBlocks(message.blocks)
                            .then((results) => {
                                void webviewPanel.webview.postMessage({
                                    type: "lintResults",
                                    id: message.id,
                                    results,
                                } satisfies ToWebviewMessage);
                            })
                            .catch((err) => {
                                console.error("[markdownWriter] harper lint failed", err);
                            });
                        break;
                    case "clipboardWrite":
                        // Copy-as-HTML / copy-as-Markdown from the right-click menu.
                        // The webview already serialized the selection; VS Code's
                        // clipboard API is text-only, so both formats write text.
                        if (message.data) {
                            void vscode.env.clipboard.writeText(message.data);
                        }
                        break;
                }
            },
        );


        // Sync external document changes (text editor edits, undo/redo, git checkout,
        // disk changes picked up by VS Code, hot exit restore) into the WebView.
        // The TextDocument is the single source of truth now, so listening to
        // onDidChangeTextDocument replaces the old FileSystemWatcher + self-write
        // suppression window: our own webview-originated WorkspaceEdits are
        // recognized by comparing against the _lastSyncedText baseline instead.
        let externalChangeTimer: ReturnType<typeof setTimeout> | undefined;
        const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() !== uriKey) { return; }
            if (e.contentChanges.length === 0) { return; }
            // Echo of a webview-originated applyEdit: the webview already has this text
            if (e.document.getText() === this._lastSyncedText.get(uriKey)) { return; }
            // A genuine external change is now pending. Bump the sync version
            // SYNCHRONOUSLY — before the 200ms debounce — so a webview `update`
            // that was already in flight (serialized against the pre-change text,
            // carrying the old baseSyncVersion) is recognized as stale and
            // rejected rather than silently overwriting the external edit inside
            // the debounce window. Without this, the version only bumped when the
            // debounced push fired, leaving a ~200ms hole where a concurrent
            // external edit (git checkout, format-on-save, external tool) could be
            // lost. _pushExternalUpdate reads (does not re-bump) this version, so
            // it stays a monotonic count of distinct external changes.
            this._syncVersion.set(uriKey, (this._syncVersion.get(uriKey) ?? 0) + 1);
            // Debounce: coalesce bursts (e.g. typing in a side-by-side text editor)
            if (externalChangeTimer !== undefined) { clearTimeout(externalChangeTimer); }
            externalChangeTimer = setTimeout(() => {
                externalChangeTimer = undefined;
                const panel = this._webviewPanels.get(uriKey);
                if (!panel) { return; }
                const text = document.getText();
                // The document settled back to the webview's state within the debounce window
                if (text === this._lastSyncedText.get(uriKey)) { return; }
                this._pushExternalUpdate(document, panel, uriKey);
            }, 200);
        });
        // Dispose the subscription when the panel closes
        webviewPanel.onDidDispose(() => {
            if (externalChangeTimer !== undefined) { clearTimeout(externalChangeTimer); }
            changeSubscription.dispose();
        });
    }

    /**
     * Pushes the current document state to the webview as a cursor-preserving
     * externalUpdate, bumping the sync version. Used both for genuine external
     * changes (side-by-side text edits, undo/redo, git, hot-exit restore) and
     * to re-base the webview after a stale update is rejected. The webview
     * applies this as a minimal diff so the caret survives; it falls back to a
     * full rebuild only when the diff can't be applied.
     */
    private _pushExternalUpdate(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
    ): void {
        const text = document.getText();
        this._lastSyncedText.set(uriKey, text);
        // The version is bumped at observe-time in the onDidChangeTextDocument
        // listener (and only there), so a concurrent in-flight webview update is
        // rejected as stale before this debounced push runs. Read it here; do not
        // re-bump, or the count would drift ahead of the webview's baseline.
        const version = this._syncVersion.get(uriKey) ?? 0;
        const displayContent = this._prepareContentForDisplay(text, document, panel, uriKey);
        const tableWrap = vscode.workspace.getConfiguration("markdownWriter").get<TableWrapMode>("tableWrap", "normal");
        panel.webview.postMessage({
            type: "externalUpdate",
            content: displayContent,
            lineMap: computeLineMap(text),
            frontmatter: this._frontmatterMap.get(uriKey) || undefined,
            imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
            tableWrap,
            syncVersion: version,
        });
    }

    /** Serializes webview-originated edits per document so they never interleave. */
    private _enqueueEdit(uriKey: string, task: () => Promise<void>): Promise<void> {
        const prev = this._editQueues.get(uriKey) ?? Promise.resolve();
        const next = prev.then(task, task);
        this._editQueues.set(uriKey, next);
        return next;
    }

    /**
     * Applies webview-produced whole-file content to the TextDocument as a
     * single minimal range replacement. Returns false when the content is
     * already current or the edit was rejected.
     */
    private async _applyWebviewEdit(
        document: vscode.TextDocument,
        newContent: string,
    ): Promise<boolean> {
        const replace = computeReplaceRange(document.getText(), newContent);
        if (!replace) { return false; }
        // Record the expected text BEFORE applying: onDidChangeTextDocument
        // fires during applyEdit and must recognize this change as our own.
        this._lastSyncedText.set(document.uri.toString(), newContent);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(
                document.positionAt(replace.startOffset),
                document.positionAt(replace.endOffset),
            ),
            replace.replacement,
        );
        return vscode.workspace.applyEdit(edit);
    }

    /** Pin the tab on first edit (remove the italic preview state) */
    private _pinTabOnFirstEdit(uriKey: string): void {
        if (this._pinnedDocuments.has(uriKey)) { return; }
        this._pinnedDocuments.add(uriKey);
        vscode.commands.executeCommand('workbench.action.keepEditor');
    }

    /**
     * Auto-save mode: debounce a native workspace save after webview-originated
     * edits. Manual mode needs no code — the TextDocument carries native dirty
     * state, and Cmd+S / hot exit / undo/redo are handled by VS Code itself.
     */
    private _scheduleAutoSave(document: vscode.TextDocument): void {
        const config = vscode.workspace.getConfiguration("markdownWriter");
        if (!config.get<boolean>("autoSave", true)) { return; }
        // Respect the built-in `files.autoSave` preference: if the user has
        // explicitly chosen manual saving ("off"), don't force a save from here.
        // Now that the editor is TextDocument-backed, VS Code's own autosave
        // governs the other modes natively, so honoring "off" makes the
        // `markdownWriter.autoSave` deprecation message truthful.
        if (vscode.workspace.getConfiguration("files").get<string>("autoSave") === "off") { return; }
        const delay = config.get<number>("autoSaveDelay", 1000);
        const uriKey = document.uri.toString();

        const existing = this._autoSaveTimers.get(uriKey);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        this._autoSaveTimers.set(
            uriKey,
            setTimeout(() => {
                this._autoSaveTimers.delete(uriKey);
                if (document.isDirty) {
                    void vscode.workspace.save(document.uri);
                }
            }, delay),
        );
    }

    /**
     * Open an external URL from the document. Gated by the
     * `markdownWriter.confirmExternalLinks` setting (default true): when enabled,
     * the user must confirm before the link is handed to the OS, so a document can
     * never navigate anywhere without an explicit extra confirmation.
     */
    private async _openExternalUrl(
        document: vscode.TextDocument,
        url: string,
    ): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('markdownWriter', document.uri);
        const confirm = cfg.get<boolean>('confirmExternalLinks', true);

        if (confirm) {
            const open = vscode.l10n.t('Open');
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('Open external link?'),
                { modal: true, detail: url },
                open,
            );
            if (choice !== open) {
                return;
            }
        }

        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private _getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
        const maxHeight = cfg.get<number>("codeBlockMaxHeight", 500);
        const editorMaxWidth = this._getEditorMaxWidthCssValue(cfg.get<number | string>("editorMaxWidth", "auto"));
        const tocContentGap = this._getPixelSettingCssValue(cfg.get<number>("tocContentGap", 100), 100, 16, 240);
        // User-dragged TOC panel width, persisted across documents and sessions
        const tocWidth = this._getNumberSettingValue(this.context.globalState.get<number>("tocWidth"), 220, 150, 600);
        const tocRight = cfg.get<string>("tocPosition", "left") === "right";
        const isAutoWidth = editorMaxWidth === "none";
        const fontFamily = cfg.get<string>("fontFamily", "");
        const fontPreset = cfg.get<FontPreset>("fontPreset", DEFAULT_FONT_PRESET);
        const resolvedFont = resolveFontFamily(fontPreset, fontFamily);
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
        // English is the sole source language: t() falls back to the key itself,
        // so the webview renders the English base strings with no translation map.
        const translations: Record<string, string> = {};
        const debugMode = cfg.get<boolean>("debugMode", false);
        const codeBlockAutoConvert = cfg.get<boolean>("codeBlockAutoConvert", true);
        const codeBlockWordWrap = this._getCodeBlockWordWrap(document.uri, cfg);
        const tocAutoHideThreshold = this._getNumberSettingValue(cfg.get<number>("tocAutoHideThreshold", 3), 3, 0, 20);
        const proofread = MarkdownEditorProvider.getProofreadConfig();
        const toolbar = MarkdownEditorProvider.getToolbarConfig();
        const documentUri = document.uri.toString();
        // The extension's display name, the single source for any UI that must
        // name the product (e.g. "Open <name> settings"). From package.json;
        // optional-chained so a stripped-down test context still resolves.
        const productName =
            (this.context.extension?.packageJSON?.displayName as string | undefined) ?? "Markdown Writer";
        const i18nScript = `window.__i18n=${JSON.stringify({ translations, isMac, debugMode, codeBlockAutoConvert, codeBlockWordWrap, tocAutoHideThreshold, proofread, toolbar, fontPreset, documentUri, productName })};`;
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
             img-src ${webview.cspSource} data:;
             font-src ${webview.cspSource} data:;">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Markdown Editor</title>
	  <link rel="stylesheet" href="${styleUri}">
	  ${customCssUris.map(uri => `<link rel="stylesheet" href="${uri}">`).join("\n  ")}
	  <style>:root { --code-block-max-height: ${maxHeight}px; --editor-max-width: ${editorMaxWidth}; --toc-width: ${tocWidth}px; --toc-tab-width: 20px; --toc-content-gap: ${tocContentGap};${resolvedFont ? ` --custom-font-family: ${resolvedFont};` : ''} --image-selection-color: ${imageSelectionColor}; }</style>
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

    /** Snapshot of the proofread (style check + spell check) settings. */
    public static getProofreadConfig(): ProofreadConfig {
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
        return {
            styleCheck: cfg.get<boolean>("styleCheck.enabled", false),
            fillers: cfg.get<boolean>("styleCheck.fillers", true),
            redundancies: cfg.get<boolean>("styleCheck.redundancies", true),
            cliches: cfg.get<boolean>("styleCheck.cliches", true),
            wordiness: cfg.get<boolean>("styleCheck.wordiness", true),
            aiVocabulary: cfg.get<boolean>("styleCheck.aiVocabulary", true),
            aiArtifacts: cfg.get<boolean>("styleCheck.aiArtifacts", true),
            passive: cfg.get<boolean>("styleCheck.passive", true),
            negativeParallelism: cfg.get<boolean>("styleCheck.negativeParallelism", true),
            longSentences: cfg.get<boolean>("styleCheck.longSentences", false),
            ruleOfThree: cfg.get<boolean>("styleCheck.ruleOfThree", false),
            emDash: cfg.get<boolean>("styleCheck.emDash", false),
            nonAsciiPunct: cfg.get<boolean>("styleCheck.nonAsciiPunct", false),
            styleExceptions: cfg.get<string[]>("styleCheck.exceptions", []),
            spellCheck: cfg.get<boolean>("spellCheck.enabled", true),
            grammarCheck: cfg.get<boolean>("spellCheck.grammar", true),
            userWords: cfg.get<string[]>("spellCheck.userWords", []),
        };
    }

    /** Snapshot of the per-item toolbar placement settings. */
    public static getToolbarConfig(): ToolbarConfig {
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
        // VS Code merges contributed defaults into this nested read, so every
        // registered item id is present with its effective value.
        return {
            placements: cfg.get("toolbar.items", {}),
            order: cfg.get<string[]>("toolbar.order", []),
        };
    }

    /** Persist the font-picker choice (toolbar → settings write-back). */
    public static setFontPreset(preset: FontPreset): void {
        MarkdownEditorProvider.updateSettingRespectingScope("fontPreset", preset);
    }

    /**
     * Persist a setting, writing to the scope that currently wins — a Global
     * write would be silently overridden by an existing workspace value.
     */
    public static updateSettingRespectingScope(key: string, value: unknown): void {
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
        const target = cfg.inspect(key)?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        void cfg.update(key, value, target);
    }

    /**
     * Persist a proofread on/off switch, writing to the scope that currently
     * wins — a Global write would be silently overridden by an existing
     * workspace value.
     */
    public static setProofreadEnabled(key: "styleCheck.enabled" | "spellCheck.enabled", enabled: boolean): void {
        MarkdownEditorProvider.updateSettingRespectingScope(key, enabled);
    }

    /**
     * Every proofread toggle the webview may write, mapped to its setting path.
     * The three masters live under their own keys; the sub-checks nest under
     * `styleCheck.*`. Unknown keys are ignored (guards the write).
     */
    private static readonly PROOFREAD_SETTING: Record<ProofreadOptionKey, string> = {
        styleCheck: "styleCheck.enabled",
        spellCheck: "spellCheck.enabled",
        grammarCheck: "spellCheck.grammar",
        fillers: "styleCheck.fillers",
        redundancies: "styleCheck.redundancies",
        cliches: "styleCheck.cliches",
        wordiness: "styleCheck.wordiness",
        aiVocabulary: "styleCheck.aiVocabulary",
        aiArtifacts: "styleCheck.aiArtifacts",
        passive: "styleCheck.passive",
        longSentences: "styleCheck.longSentences",
        negativeParallelism: "styleCheck.negativeParallelism",
        ruleOfThree: "styleCheck.ruleOfThree",
        emDash: "styleCheck.emDash",
        nonAsciiPunct: "styleCheck.nonAsciiPunct",
    };

    /** Persist one proofread toggle (checks menu → settings write-back). */
    public static setProofreadOption(key: ProofreadOptionKey, value: boolean): void {
        const path = MarkdownEditorProvider.PROOFREAD_SETTING[key];
        if (!path) { return; }
        MarkdownEditorProvider.updateSettingRespectingScope(path, value);
    }

    /** Flip the style check (command palette / keyboard shortcut). */
    public static toggleStyleCheck(): void {
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
        MarkdownEditorProvider.setProofreadEnabled(
            "styleCheck.enabled",
            !cfg.get<boolean>("styleCheck.enabled", false),
        );
    }

    private _handleSpellAddWord(word: string): void {
        const trimmed = word?.trim();
        if (!trimmed) { return; }
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
        const words = cfg.get<string[]>("spellCheck.userWords", []);
        if (words.includes(trimmed)) { return; }
        // Prefer the workspace list (project jargon); fall back to user settings
        const target = vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        void cfg.update("spellCheck.userWords", [...words, trimmed], target);
    }

    private _getCustomResourceRoots(documentUri: vscode.Uri): vscode.Uri[] {
        const cfg = vscode.workspace.getConfiguration("markdownWriter");
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
        document: vscode.TextDocument,
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
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
        data: Uint8Array,
        mimeType: string,
        altText: string,
    ): Promise<void> {
        const uriKey = document.uri.toString();
        const cfg = vscode.workspace.getConfiguration('markdownWriter', document.uri);
        try {
            // Images are always saved to the local workspace; nothing is uploaded off the machine.
            const { relPath, absUri } = await saveImageLocally(document.uri, cfg, data, mimeType, altText);
            const webviewUri = panel.webview.asWebviewUri(absUri);
            const url = webviewUri.toString();
            // Store the mapping so that on save, webviewUri is replaced back with relPath
            const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
            this._imageUriMaps.set(uriKey, uriMap);
            uriMap.set(url, relPath);
            panel.webview.postMessage({ type: 'imageUploaded', id, url });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            panel.webview.postMessage({ type: 'imageUploadError', id, error: errMsg });
            vscode.window.showErrorMessage(vscode.l10n.t('Failed to save image: {0}', errMsg));
        }
    }

    private async _handleGetProjectImages(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
        id: string,
    ): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('markdownWriter', document.uri);
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
        document: vscode.TextDocument,
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

    /**
     * Answers a requestFmSuggestions message: scans the workspace's markdown
     * files (once per TTL window, indexing every list-valued key), then replies
     * with the values used for `key` in files OTHER than the current document,
     * ranked by frequency (descending) then alphabetically.
     */
    private async _handleRequestFmSuggestions(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        key: string,
    ): Promise<void> {
        const now = Date.now();
        if (!this._fmScanCache || now >= this._fmScanCache.expires) {
            const uris = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**", 500);
            const perFile = new Map<string, ReadonlyMap<string, string[]>>();
            await Promise.all(uris.map(async (uri) => {
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    perFile.set(uri.fsPath, extractListValuesByKey(Buffer.from(bytes).toString("utf8")));
                } catch { /* unreadable file: skip it */ }
            }));
            this._fmScanCache = { perFile, expires: now + MarkdownEditorProvider._FM_SCAN_TTL_MS };
        }
        // Suggestions come from OTHER files only; the current document's own
        // values are already visible as chips (and excluded WebView-side too).
        const docFsPath = document.uri.fsPath;
        const otherFiles = [...this._fmScanCache.perFile.entries()]
            .filter(([fsPath]) => fsPath !== docFsPath)
            .map(([, keyValues]) => keyValues);
        const values = rankListValues(otherFiles, key);
        panel.webview.postMessage({ type: "fmSuggestions", key, values });
    }

    private async _handleGetPathSuggestions(
        document: vscode.TextDocument,
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

    /**
     * Workspace-wide file suggestions for link URL inputs (link popup /
     * insert-link prompt): case-insensitive substring match on the path,
     * markdown files first. Each match is replied in BOTH document-relative
     * and root-relative form; the WebView picks the form matching what the
     * user typed. External queries (http/https/mailto/#) get no suggestions.
     */
    private async _handleGetLinkTargetSuggestions(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
        query: string,
    ): Promise<void> {
        const post = (items: ReturnType<typeof rankLinkTargets>) =>
            panel.webview.postMessage({ type: 'linkTargetSuggestions', id, items });

        if (!isLocalPathQuery(query) || document.uri.scheme !== 'file') {
            post([]);
            return;
        }
        const workspaceRoot = (vscode.workspace.getWorkspaceFolder(document.uri)
            ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
        if (!workspaceRoot) {
            post([]);
            return;
        }

        const now = Date.now();
        if (!this._linkFileCache || now >= this._linkFileCache.expires) {
            const uris = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/dist/**,**/releases/**}',
                2000,
            );
            this._linkFileCache = { uris, expires: now + MarkdownEditorProvider._LINK_FILE_TTL_MS };
        }

        const candidates = buildLinkTargetItems(
            this._linkFileCache.uris.map((u) => u.fsPath),
            document.uri.fsPath,
            workspaceRoot,
        );
        post(rankLinkTargets(candidates, query));
    }

    private _handleResolveImagePath(
        document: vscode.TextDocument,
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
