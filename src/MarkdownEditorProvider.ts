import * as path from "path";
import * as vscode from "vscode";
import { computeReplaceRange } from "./utils/textEdit";
import { saveImageLocally } from "./utils/imageService";
import { computeLineMap } from "./utils/lineMap";
import { extractFrontmatter, restoreContentForSave } from "./utils/contentTransform";
import { extractListValuesByKey, rankListValues } from "./utils/frontmatterSuggestions";
import { buildLinkTargetItems } from "./utils/linkTargetSuggestions";
import { DiskDriftController } from "./diskDrift";
import { judgeReplacement } from "./destructiveGuard";
import { postToWebview } from "./webviewMessaging";
import {
    getBirtaConfiguration,
    readBirtaSetting,
    readFoldingConfig,
    addUserWord,
    setContentWidth,
    setFontPreset,
    setFontSize,
    setProofreadOption,
    updateSettingRespectingScope,
} from "./config";
import { SaveFlushController } from "./saveFlushController";
import { watchExternalDocumentChanges } from "./externalChanges";
import { buildWebviewHtml, getCustomResourceRoots, clampNumberSetting, escapeHtmlAttr } from "./webviewHtml";
import { reportError, reportErrorWithNotification } from "./errorSink";
import { resolveLinkPath, resolveWikiTarget, type ResolverIo } from "./utils/linkResolver";
import { scanHeadings } from "./utils/headingScan";
import { extractOgTitle } from "./utils/openGraph";
import { isPubliclyRoutableUrl } from "./utils/urlGuard";
import { slugify } from "../shared/slug";
import { isLocalPathQuery, rankLinkTargets } from "../shared/linkTargetSuggest";
import { lintBlocks } from "./utils/harperService";
import type { ToExtensionMessage, ToWebviewMessage, TextCount } from "../shared/messages";
import type { WordCountView } from "./wordCountStatus";
import type { EditorCommandId } from "../shared/editorCommands";
import { normalizeBlockHandlesMode } from "../shared/blockHandles";
import { normalizeTocVisibility } from "../shared/tocVisibility";

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

// Re-exported for existing consumers/tests; the implementation moved to
// src/webviewHtml.ts with the rest of the HTML bootstrap (MAR-168).
export { escapeHtmlAttr };

/**
 * Paste-unfurl fetch bounds (MAR-178). The webview shows the bare link the
 * instant it's pasted, so the title fetch is pure enhancement — it must be
 * strictly time- and size-bounded and never able to hang the extension host.
 *
 * - TIMEOUT aborts a slow/unresponsive host; the webview also has its own
 *   backstop timeout so a dropped reply still resolves to "keep the bare link".
 * - MAX_BYTES caps how much of the response body we read: a page's title lives
 *   in <head> near the top, so a small budget finds it while a huge or
 *   streaming body can never balloon the parse.
 */
const UNFURL_FETCH_TIMEOUT_MS = 5000;
/**
 * 1 MB, not the intuitive 64–512 KB: real pages front-load enormous <head>
 * payloads before their title — youtube.com's watch page puts <title> at byte
 * ~660 K, so a 512 KB cap silently "unfurled to nothing" (the user-visible
 * symptom: Enable appeared to do nothing for the very link that prompted it).
 * The </head> early-stop below keeps typical pages far under the cap.
 */
const UNFURL_MAX_BYTES = 1024 * 1024;
/** Manual-redirect hop budget; each hop re-passes the scheme + SSRF checks. */
const UNFURL_MAX_REDIRECTS = 5;

/**
 * Read at most `maxBytes` of a fetch Response body as UTF-8 text, then stop.
 * Streaming the body and bailing early bounds the parse cost regardless of the
 * page's real size (a title lives in <head>, near the top). Falls back to a
 * plain `.text()` when the body isn't a readable stream (e.g. a stubbed
 * Response in a unit test), slicing the result to the same budget.
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
    const reader = res.body?.getReader?.();
    if (!reader) {
        return (await res.text()).slice(0, maxBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Early stop: titles live in <head>, so once the closing tag streams past
    // there is nothing left worth reading — typical pages finish in a few KB
    // even though the cap allows a megabyte. The marker is searched in a small
    // trailing window of the previous chunk joined to the new one, so a tag
    // split across a chunk boundary is still seen.
    const HEAD_END = "</head>";
    const decoder = new TextDecoder("utf-8");
    let tailText = "";
    try {
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done) { break; }
            if (value) {
                chunks.push(value);
                total += value.length;
                const text = tailText + decoder.decode(value, { stream: true });
                if (text.includes(HEAD_END)) { break; }
                tailText = text.slice(-HEAD_END.length);
            }
        }
    } finally {
        // Stop the transfer once we have enough (or on any read error).
        try { await reader.cancel(); } catch { /* already closed */ }
    }
    const merged = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
        if (offset >= merged.length) { break; }
        const take = Math.min(chunk.length, merged.length - offset);
        merged.set(chunk.subarray(0, take), offset);
        offset += take;
    }
    return new TextDecoder("utf-8").decode(merged);
}

export class MarkdownEditorProvider
    implements vscode.CustomTextEditorProvider {
    public static readonly viewType = "birta.editor";

    // Tracks the webviewPanel for each document (used to push new content on external changes)
    private readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();

    // The panel that is currently the active editor. Command-palette and
    // right-click commands (MAR-9) target it. Set on resolve and whenever a
    // panel becomes active; cleared when the active panel is disposed.
    private _activePanel: vscode.WebviewPanel | null = null;

    // Bridge for the just-in-time network opt-in (MAR-179): the fresh value
    // of birta.network.enabled while its async settings write is still in
    // flight. _fetchUnfurlTitle prefers this over the (possibly stale)
    // persisted read so the opt-in's own triggering link can unfurl; null
    // whenever no write is pending.
    private _networkWriteInFlight: boolean | null = null;

    // URIs that have already run keepEditor (pin tab), to avoid running it again
    private readonly _pinnedDocuments = new Set<string>();

    // File-space text the webview last produced or was last sent (key: uriKey).
    // onDidChangeTextDocument compares against this to tell webview-originated
    // edits (echoes of our own applyEdit) from genuine external changes.
    private readonly _lastSyncedText = new Map<string, string>();

    // The flush/seq protocol bookkeeping (sync versions, applied-seq high-water
    // marks, in-flight save flushes) lives in the SaveFlushController — see
    // src/saveFlushController.ts for the invariants. Constructed in the
    // constructor so the flush timeout stays injectable for tests.
    private readonly _flush: SaveFlushController<vscode.TextEdit>;

    // Per-document promise chain serializing webview-originated WorkspaceEdits,
    // so a second update can never race the applyEdit (and its change event)
    // of the first.
    private readonly _editQueues = new Map<string, Promise<void>>();

    // Notify-only detection of external disk edits: raises an advisory toolbar
    // badge when the file changes on disk while the document has unsaved edits.
    // It never edits/reverts/writes the document — the user chooses (see
    // src/diskDrift.ts). Relays drift transitions to the webview.
    private readonly _diskDrift = new DiskDriftController({
        onDriftChange: (uriKey, drifted) => {
            const panel = this._webviewPanels.get(uriKey);
            if (panel) {
                postToWebview(panel.webview, {
                    type: "syncConflict",
                    state: drifted ? "conflict" : "none",
                });
            }
        },
    });

    // One-slot pre-destruction text per document (MAR-114): armed when a
    // webview content replacement trips the destructive-change tripwire, read
    // back by birta.restorePreviousContent. Deliberately NOT cleared on panel
    // dispose — the slot must survive the user closing a wrecked editor. One
    // string per tripped document for the extension's lifetime; trips are rare.
    private readonly _previousContent = new Map<string, string>();

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

    // Panels whose webview currently holds OS focus (MAR-104). Mirrored into the
    // `birta.webviewFocused` when-clause context key so document-mutating
    // keybindings fire only while an editor is truly focused, not merely because
    // its tab is the active custom editor with focus parked elsewhere.
    private readonly _focusedPanels = new Set<string>();

    // While switching to the text editor, suppress the line-number callback from onDidChangeActiveTextEditor
    // Prevents the line number from being wrongly fed back to the WebView after the text editor opens, triggering a redundant scrollToLine
    private _suppressNavFromTextEditor = false;

    // Status bar word/character/reading-time readout (MAR-29). Injected from
    // extension.ts so the item is created once; the provider drives it from the
    // active panel's `wordCount` messages. Last-known counts are cached per
    // document so re-activating a retained webview re-renders without waiting
    // for a fresh report.
    private _wordCountView: WordCountView | null = null;
    private readonly _wordCounts = new Map<
        string,
        { doc: TextCount; selection: TextCount | null }
    >();

    public static current: MarkdownEditorProvider | null = null;

    /** Inject the status bar word-count view (called once from extension.ts). */
    public setWordCountView(view: WordCountView): void {
        this._wordCountView = view;
    }

    /** Render the cached counts for `uriKey`, or hide the readout if none exist. */
    private _renderWordCount(uriKey: string): void {
        const counts = this._wordCounts.get(uriKey);
        if (counts) {
            this._wordCountView?.update(counts.doc, counts.selection);
        } else {
            this._wordCountView?.hide();
        }
    }

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
                postToWebview(panel.webview, { type: 'scrollToLine', line });
                // Don't delete _pendingNavigations; keep it as a fallback for ready on panel rebuild (valid within TTL 5s)
            }
        }
    }

    /** Send an arbitrary message to the panel for the given URI (for extension.ts to call) */
    public postToPanel(uri: vscode.Uri, msg: ToWebviewMessage): void {
        const panel = this._webviewPanels.get(uri.toString());
        if (panel) { postToWebview(panel.webview, msg); }
    }

    /** Called from extension.ts (revealLine command): send a scroll message directly to the panel */
    public scrollPanelToLine(uri: vscode.Uri, line: number): void {
        const uriKey = uri.toString();
        const panel = this._webviewPanels.get(uriKey);
        if (panel) {
            postToWebview(panel.webview, { type: 'scrollToLine', line });
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
            postToWebview(panel.webview, msg);
        }
    }

    /** Sends a message to the active editor panel (no-op when none is active). */
    public postToActivePanel(msg: ToWebviewMessage): void {
        if (this._activePanel) { postToWebview(this._activePanel.webview, msg); }
    }

    /**
     * Records webview focus for `uriKey` and mirrors "any editor focused" into
     * the `birta.webviewFocused` context key. A Set (not a single boolean)
     * because split views can host several editor webviews; the key is true
     * while any one of them holds focus. Called on focusState messages, and with
     * `focused: false` when a panel disposes or goes inactive (MAR-104).
     */
    private _setWebviewFocus(uriKey: string, focused: boolean): void {
        const had = this._focusedPanels.has(uriKey);
        if (focused) {
            this._focusedPanels.add(uriKey);
        } else {
            this._focusedPanels.delete(uriKey);
        }
        if (had === focused) { return; }
        void vscode.commands.executeCommand(
            "setContext",
            "birta.webviewFocused",
            this._focusedPanels.size > 0,
        );
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
            postToWebview(named.webview, msg);
            return;
        }
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        if (activeTab?.input instanceof vscode.TabInputCustom) {
            const focused = this._webviewPanels.get(activeTab.input.uri.toString());
            if (focused) {
                postToWebview(focused.webview, msg);
                return;
            }
        }
        this.postToActivePanel(msg);
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
        flushTimeoutMs: number = 1000,
    ) {
        this._flush = new SaveFlushController<vscode.TextEdit>(flushTimeoutMs);
    }

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
        // Show cached counts if we've seen this document before, else clear any
        // stale readout from the previously active editor until the webview
        // reports (MAR-29).
        this._renderWordCount(uriKey);

        webviewPanel.onDidDispose(() => {
            this._webviewPanels.delete(uriKey);
            // Drop cached counts; hide the readout if this was the active editor
            // (its status bar figures no longer describe anything) (MAR-29).
            this._wordCounts.delete(uriKey);
            if (this._activePanel === webviewPanel) { this._wordCountView?.hide(); }
            if (this._activePanel === webviewPanel) { this._activePanel = null; }
            this._pinnedDocuments.delete(uriKey);
            this._imageUriMaps.delete(uriKey);
            this._initializedPanels.delete(uriKey);
            this._lastSyncedText.delete(uriKey);
            this._editQueues.delete(uriKey);
            this._flush.dispose(uriKey);
            // A disposed webview can't post a blur; clear its focus so the
            // context key can't latch true after the editor is gone (MAR-104).
            this._setWebviewFocus(uriKey, false);
        });

        // Watch the file for external writes so a dirty document can flag drift
        // (VS Code auto-reloads clean documents on its own). Disposed with the panel.
        const driftTracking = this._diskDrift.track(document, uriKey);
        webviewPanel.onDidDispose(() => driftTracking.dispose());

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "dist"),
                // Allow access to workspace folders (for displaying local images)
                ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
                // Allow access to the directory containing the .md file (outside the workspace or untitled)
                vscode.Uri.joinPath(document.uri, '..'),
                ...getCustomResourceRoots(document.uri),
            ],
        };
        webviewPanel.webview.html = buildWebviewHtml(
            webviewPanel.webview,
            document,
            this.context,
        );

        // When the panel is activated (e.g. clicking an already-open file from global search), check and send the pending navigation line
        // Only handle panels that are already initialized (ready), to avoid prematurely consuming the pending navigation when a new panel is created
        webviewPanel.onDidChangeViewState(({ webviewPanel: p }) => {
            if (!p.active) {
                // An inactive panel isn't focused. The webview also posts a blur,
                // but clearing here defends against a missed/late blur so the
                // context key can't stay latched on the wrong panel (MAR-104).
                this._setWebviewFocus(uriKey, false);
                // Clear the status bar readout only if THIS panel currently owns
                // it. A background panel deactivating in a split view — or an
                // out-of-order viewState event on a tab switch, where the newly
                // active panel already claimed `_activePanel` — must not blank
                // the still-active document's counts (MAR-29). Mirrors the
                // dispose handler's guard above.
                if (this._activePanel === webviewPanel) {
                    this._activePanel = null;
                    this._wordCountView?.hide();
                }
                return;
            }
            // Track the active panel for command-palette / context-menu routing.
            this._activePanel = p;
            // Restore this document's cached counts into the status bar (MAR-29).
            this._renderWordCount(uriKey);
            if (!this._initializedPanels.has(uriKey)) { return; }
            const line = this._consumePendingNavigation(document.uri.fsPath)
                ?? this._consumeGlobalRevealLine();
            if (line !== undefined) {
                console.log('[viewState] immediate scrollToLine:', line);
                postToWebview(p.webview, { type: "scrollToLine", line });
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
                    postToWebview(p.webview, { type: "scrollToLine", line: delayedLine });
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
                        const tableWrap = readBirtaSetting("tableWrap");
                        // Reset the echo baseline: init hands this exact text to the webview
                        this._lastSyncedText.set(uriKey, initContent);
                        // Reset the sync version so the webview's baseSyncVersion
                        // starts aligned with the extension.
                        this._flush.resetVersion(uriKey);
                        postToWebview(webviewPanel.webview, {
                            type: "init",
                            content: displayContent,
                            lineMap: computeLineMap(initContent),
                            frontmatter: this._frontmatterMap.get(uriKey) || undefined,
                            imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
                            tableWrap,
                            syncVersion: 0,
                            ...(scrollToLine !== undefined ? { scrollToLine } : {}),
                        });
                        // Deliver the current disk-drift state now that the webview
                        // is listening. track()'s initial evaluate can set drift
                        // before the webview boots (a restored/reopened dirty doc
                        // already diverged from disk), and that early postMessage is
                        // dropped — so re-send it here or the badge never appears.
                        if (this._diskDrift.isDrifted(uriKey)) {
                            postToWebview(webviewPanel.webview, {
                                type: "syncConflict",
                                state: "conflict",
                            });
                        }
                        break;
                    }
                    case "update":
                        if (message.content !== undefined) {
                            // Stale-update rejection: the webview serialized this
                            // against content we've since replaced (an
                            // externalUpdate landed after it read the document).
                            // Drop it and re-push the current authoritative state
                            // so the webview re-bases.
                            if (!this._flush.isCurrentVersion(uriKey, message.baseSyncVersion)) {
                                this._pushExternalUpdate(document, webviewPanel, uriKey);
                                break;
                            }
                            const newContent = this._prepareContentForSave(message.content, uriKey);
                            const seq = message.seq;
                            void this._enqueueEdit(uriKey, async () => {
                                // Ordering guard (checked at apply time, in queue
                                // order, and claimed even when the apply turns out
                                // to be a no-op — see claimSeq): drop an update a
                                // save-flush has already superseded, so it can
                                // never revert fresher content.
                                if (!this._flush.claimSeq(uriKey, seq)) { return; }
                                // Identical to the current document (e.g. serializer no-op echo): nothing to do
                                const applied = await this._applyWebviewEdit(document, newContent);
                                if (!applied) { return; }
                                this._pinTabOnFirstEdit(uriKey);
                                postToWebview(webviewPanel.webview, { type: "lineMapUpdate", lineMap: computeLineMap(document.getText()) });
                            });
                        }
                        break;
                    case "frontmatterUpdate": {
                        // Stale-update rejection (same rule as "update"): a
                        // frontmatter edit serialized against replaced content is
                        // dropped and the current state re-pushed.
                        if (!this._flush.isCurrentVersion(uriKey, message.baseSyncVersion)) {
                            this._pushExternalUpdate(document, webviewPanel, uriKey);
                            break;
                        }
                        // The WebView edited the frontmatter panel; replace just the frontmatter block.
                        // Deliberately NOT armed with the destructive-change tripwire
                        // (MAR-114): this path can only rewrite the frontmatter block —
                        // the body is untouched by construction, so the whole-document
                        // line thresholds don't describe its blast radius.
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
                            postToWebview(webviewPanel.webview, { type: "lineMapUpdate", lineMap: computeLineMap(document.getText()) });
                        });
                        break;
                    }
                    case "openUrl":
                        // Scheme allowlist only — VS Code itself shows the
                        // trusted-domains confirmation on openExternal.
                        if (message.url && isSafeExternalUrl(message.url)) {
                            void vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case "openFile": {
                        if (!message.path) break;
                        await this._handleOpenFile(document, uriKey, message.path, message.wiki === true)
                            // Open failures surface via VS Code's own UI; log for diagnosis.
                            .catch((err) => reportError("openFile", err));
                        break;
                    }
                    case "resolveLinkTarget": {
                        await this._handleResolveLinkTarget(
                            document,
                            webviewPanel,
                            message.id,
                            message.path,
                            message.wiki === true,
                        ).catch((err) => reportError("resolveLinkTarget", err)); // hint is best-effort
                        break;
                    }
                    case "switchToTextEditor": {
                        // Suppress the upcoming onDidChangeActiveTextEditor line-number callback (within 1.5s)
                        this.suppressNavFromTextEditor();
                        // Suppress the automatic WYSIWYG switch from onDidChangeTabs (to prevent switching back)
                        MarkdownEditorProvider.suppressAutoSwitch.add(document.uri.toString());
                        setTimeout(() => MarkdownEditorProvider.suppressAutoSwitch.delete(document.uri.toString()), 2000);
                        const viewCol = webviewPanel.viewColumn;

                        // Find this document's WYSIWYG tab and its preview state
                        // (italic = isPreview: true).
                        let isPreview = false;
                        let customTab: vscode.Tab | undefined;
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                if (
                                    tab.input instanceof vscode.TabInputCustom &&
                                    (tab.input as vscode.TabInputCustom).uri.toString() === document.uri.toString()
                                ) {
                                    isPreview = tab.isPreview;
                                    customTab = tab;
                                    break;
                                }
                            }
                        }

                        // Close the source (WYSIWYG) tab FIRST, and switch only if
                        // the close succeeded. Closing a dirty tab shows VS Code's
                        // native Save / Don't Save / Cancel prompt: Save and Don't
                        // Save close it (→ we proceed to the text editor), Cancel
                        // leaves it open and returns false (→ true no-op). Opening
                        // the destination only after a successful close means a
                        // mode switch never spawns a second tab based on dirty
                        // state. (tabGroups.close reports the cancel; dispose()
                        // can't, which is why it isn't used here.)
                        if (customTab) {
                            const closed = await vscode.window.tabGroups.close(customTab);
                            if (!closed) { break; }
                        } else {
                            webviewPanel.dispose();
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

                        const textDoc = await vscode.workspace.openTextDocument(document.uri);
                        await vscode.window.showTextDocument(textDoc, opts);
                        break;
                    }
                    case "openSettings":
                        // An optional query narrows the filter (e.g. the font
                        // settings); anything outside our namespace is ignored.
                        vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            message.query?.startsWith('birta') ? message.query : 'birta',
                        );
                        break;
                    case "openKeybindings":
                        // Filtered to this extension's commands; shows the
                        // user's effective (possibly rebound) shortcuts
                        vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'birta');
                        break;
                    case "uploadImage":
                        if (message.id && message.data) {
                            this._handleImageUpload(
                                document, panel,
                                message.id,
                                message.data,
                                message.mimeType ?? 'image/png',
                                message.altText ?? '',
                            ).catch((err) => reportError("uploadImage", err));
                        }
                        break;
                    case "getProjectImages":
                        if (message.id) {
                            this._handleGetProjectImages(document, panel, uriKey, message.id)
                                .catch((err) => reportError("getProjectImages", err));
                        }
                        break;
                    case "getPathSuggestions":
                        if (message.id && message.query !== undefined) {
                            this._handleGetPathSuggestions(document, panel, message.id, message.query)
                                .catch((err) => reportError("getPathSuggestions", err));
                        }
                        break;
                    case "getLinkTargetSuggestions":
                        if (message.id && message.query !== undefined) {
                            this._handleGetLinkTargetSuggestions(document, panel, message.id, message.query)
                                .catch((err) => reportError("getLinkTargetSuggestions", err));
                        }
                        break;
                    case "resolveImagePath":
                        if (message.id && message.relPath) {
                            this._handleResolveImagePath(document, panel, uriKey, message.id, message.relPath);
                        }
                        break;
                    case "unfurlUrl":
                        // Paste-unfurl: the webview already inserted `[url](url)`;
                        // fetch the page title (extension-side, past the webview's
                        // CSP/CORS) and reply so it can upgrade to `[title](url)`.
                        // _handleUnfurl always replies (with a null title on any
                        // failure); the .catch is a backstop for a post to a
                        // disposed panel.
                        if (message.id && message.url) {
                            this._handleUnfurl(panel, message.id, message.url)
                                .catch((err) => reportError("unfurlUrl", err));
                        }
                        break;
                    case "requestFmSuggestions":
                        if (message.key !== undefined) {
                            this._handleRequestFmSuggestions(document, panel, message.key)
                                .catch((err) => reportError("requestFmSuggestions", err));
                        }
                        break;
                    case "tocWidth":
                        // Persist the dragged width to birta.tocWidth. The
                        // config-change listener (extension.ts) echoes it back to
                        // every open editor (setTocWidth) — same path as position.
                        void updateSettingRespectingScope(
                            "tocWidth",
                            clampNumberSetting(message.width, 220, 150, 600),
                        );
                        break;
                    case "tocVisibility":
                        // Persist the toggle to birta.tocVisibility. The
                        // config-change listener echoes the new value to every
                        // open editor, keeping tabs in sync. Normalized as a guard.
                        void updateSettingRespectingScope(
                            "tocVisibility",
                            normalizeTocVisibility(message.visibility),
                        );
                        break;
                    // Persisting triggers onDidChangeConfiguration in extension.ts,
                    // which re-broadcasts the config to every open editor.
                    case "setProofreadOption":
                        setProofreadOption(message.key, message.value);
                        break;
                    case "setFontPreset":
                        setFontPreset(message.preset);
                        break;
                    case "setFontSize":
                        setFontSize(message.size);
                        break;
                    case "setContentWidth":
                        setContentWidth(message.mode);
                        break;
                    case "setBlockHandles":
                        updateSettingRespectingScope(
                            "blockHandles",
                            normalizeBlockHandlesMode(message.mode),
                        );
                        break;
                    case "setToolbarLayout":
                        if (message.item) {
                            updateSettingRespectingScope(
                                `toolbar.items.${message.item.id}`,
                                message.item.placement,
                            );
                        }
                        updateSettingRespectingScope("toolbar.order", message.order);
                        break;
                    case "setToolbarVisible":
                        updateSettingRespectingScope("toolbar.visible", message.visible);
                        break;
                    case "setTocPosition":
                        updateSettingRespectingScope("tocPosition", message.position);
                        break;
                    case "setNetworkEnabled":
                        // Just-in-time opt-in (MAR-179): the user accepted an
                        // "Enable" affordance. Persist the master switch through
                        // the scope-respecting write-back, exactly like the
                        // toolbar settings above.
                        //
                        // The accept flow posts `unfurlUrl` for the triggering
                        // link IMMEDIATELY after this message, and the async
                        // config write may not have landed when that fetch
                        // re-reads the setting — without a bridge, the very
                        // link that prompted the opt-in stays bare. Hold the
                        // fresh value in memory only while the write is in
                        // flight; once it resolves (or fails), the persisted
                        // setting is authoritative again.
                        this._networkWriteInFlight = message.enabled;
                        Promise.resolve(
                            updateSettingRespectingScope("network.enabled", message.enabled),
                        )
                            .catch(() => undefined)
                            .then(() => { this._networkWriteInFlight = null; });
                        break;
                    case "setCalcAutoInsert":
                        // The calc menu's "Always insert result" row. The
                        // accepting webview flips its own __i18n gate; other
                        // open webviews pick the value up on reopen.
                        updateSettingRespectingScope("calc.autoInsert", message.enabled);
                        break;
                    case "setPasteUnfurlAutoApply":
                        // The unfurl offer's "Always use fetched titles" row.
                        // The config-change listener broadcasts the new value,
                        // so every open webview picks it up live.
                        updateSettingRespectingScope("pasteUnfurl.autoApply", message.enabled);
                        break;
                    case "setChecklistSink":
                        // The "Move checked tasks to bottom" toggle (toolbar Lists
                        // menu / task-list block menu). Same local-gate model
                        // as calc.autoInsert.
                        updateSettingRespectingScope("checklist.sinkChecked", message.enabled);
                        break;
                    case "spellAddWord":
                        addUserWord(message.word);
                        break;
                    case "lintBlocks":
                        lintBlocks(message.blocks)
                            .then((results) => {
                                postToWebview(webviewPanel.webview, {
                                    type: "lintResults",
                                    id: message.id,
                                    results,
                                });
                            })
                            .catch((err) => reportError("harper lint", err));
                        break;
                    case "clipboardWrite":
                        // Copy-as-HTML / copy-as-Markdown from the right-click menu.
                        // The webview already serialized the selection; VS Code's
                        // clipboard API is text-only, so both formats write text.
                        if (message.data) {
                            void vscode.env.clipboard.writeText(message.data);
                        }
                        break;
                    case "flushResult":
                        // Reply to an onWillSaveTextDocument flush: hand the parked
                        // waitUntil resolver the freshest serialized content.
                        this._flush.resolveFlush(message.id, {
                            content: message.content,
                            baseSyncVersion: message.baseSyncVersion,
                            seq: message.seq,
                        });
                        break;
                    case "resolveSyncConflict":
                        // The disk-drift badge was clicked: offer the user the
                        // native reload/compare picker. Never edits the document.
                        void this._diskDrift.resolveDriftInteractively(document);
                        break;
                    case "focusState":
                        // Gate document-mutating keybindings on real webview
                        // focus (MAR-104).
                        this._setWebviewFocus(uriKey, message.focused);
                        break;
                    case "crash":
                        // The webview's crash boundary reported an uncaught
                        // error / unhandled rejection (MAR-169). Log every
                        // occurrence; the toast is deduped per DOCUMENT (the
                        // dedupeKey), not per the constant message — a crash
                        // in a different editor later in the session is a new
                        // failure and warns again, while a crash-looping
                        // webview on one document stays a single toast. The
                        // document itself is safe — the TextDocument (and hot
                        // exit) live extension-side.
                        reportErrorWithNotification(
                            `webview ${message.source} (${document.uri.fsPath})`,
                            message.stack ? `${message.message}\n${message.stack}` : message.message,
                            vscode.l10n.t(
                                "The Birta editor reported an internal error. Your document is safe; see the developer console for details.",
                            ),
                            `crash:${uriKey}`,
                        );
                        break;
                    case "wordCount":
                        // Cache per document so re-activating a retained webview
                        // re-renders instantly; only the active panel drives the
                        // shared status bar item (MAR-29).
                        this._wordCounts.set(uriKey, { doc: message.doc, selection: message.selection });
                        if (this._activePanel === webviewPanel) {
                            this._wordCountView?.update(message.doc, message.selection);
                        }
                        break;
                }
            },
        );


        // Sync external document changes (text editor edits, undo/redo, git checkout,
        // disk changes picked up by VS Code, hot exit restore) into the WebView.
        // The TextDocument is the single source of truth, so the listener rides
        // onDidChangeTextDocument (mechanism A of the external-change seam — the
        // unify-vs-divide ADR against diskDrift's watcher is in
        // src/externalChanges.ts). Our own webview-originated WorkspaceEdits are
        // recognized by comparing against the _lastSyncedText baseline.
        const changeSubscription = watchExternalDocumentChanges(document, uriKey, {
            isEcho: (text) => text === this._lastSyncedText.get(uriKey),
            // A genuine external change is now pending. Bump the sync version
            // SYNCHRONOUSLY — before the debounce — so a webview `update` that
            // was already in flight (serialized against the pre-change text,
            // carrying the old baseSyncVersion) is recognized as stale and
            // rejected rather than silently overwriting the external edit inside
            // the debounce window. _pushExternalUpdate reads (does not re-bump)
            // this version, so it stays a monotonic count of distinct external
            // changes.
            onChangeObserved: () => this._flush.bumpVersion(uriKey),
            onChangeSettled: () => {
                const panel = this._webviewPanels.get(uriKey);
                if (!panel) { return; }
                // The document settled back to the webview's state within the debounce window
                if (document.getText() === this._lastSyncedText.get(uriKey)) { return; }
                this._pushExternalUpdate(document, panel, uriKey);
            },
        });
        // Flush pending webview edits into the save. onWillSaveTextDocument
        // fires ONLY for a dirty document — the webview's eager leading-edge sync
        // (see editor.ts) makes the document dirty within an IPC hop of the first
        // edit, so a fast Cmd+S reliably reaches here. waitUntil blocks the write
        // until the webview hands back its freshest serialization, so a save can
        // never persist content older than the editor state.
        const willSaveSubscription = vscode.workspace.onWillSaveTextDocument((e) => {
            if (e.document.uri.toString() !== uriKey) { return; }
            e.waitUntil(this._flushWebviewEdits(document, uriKey));
        });
        // Dispose the subscriptions when the panel closes
        webviewPanel.onDidDispose(() => {
            changeSubscription.dispose();
            willSaveSubscription.dispose();
            // Fail any parked flush so a save mid-teardown never hangs.
            this._flush.failFlushes(uriKey);
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
        const version = this._flush.currentVersion(uriKey);
        const displayContent = this._prepareContentForDisplay(text, document, panel, uriKey);
        const tableWrap = readBirtaSetting("tableWrap");
        postToWebview(panel.webview, {
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
        const before = document.getText();
        const replace = computeReplaceRange(before, newContent);
        if (!replace) { return false; }
        this._armTripwire(document.uri.toString(), before, newContent, "update");
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

    /**
     * The destructive-change tripwire (MAR-114): called at both choke points
     * where webview-produced content replaces the document (the update path
     * and the save flush). When the replacement removes a large share of the
     * document's significant lines, keep the prior full text for
     * `birta.restorePreviousContent` and log a structured dev-console warning
     * — no notification, no telemetry: layer-4 insurance stays silent.
     */
    private _armTripwire(
        uriKey: string,
        before: string,
        after: string,
        source: "update" | "saveFlush",
    ): void {
        const verdict = judgeReplacement(before, after);
        if (!verdict.tripped) { return; }
        this._previousContent.set(uriKey, before);
        console.warn(
            `[birta] destructive-change tripwire (${source}): ` +
            `${verdict.removed} of ${verdict.beforeSig} significant lines removed in one update; ` +
            `previous content kept — "Birta Writer: Restore Previous Content" recovers it`,
            { uri: uriKey, ...verdict },
        );
    }

    /**
     * "Birta Writer: Restore Previous Content" (MAR-114): swap the active
     * document's text with the tripwire slot. The swap makes the command its
     * own inverse — running it again puts the replaced text back. The edit
     * flows through the normal external-change pipeline (version bump at
     * observe time), so an open webview re-bases on the restored text and a
     * save immediately after cannot be clobbered by a stale webview
     * serialization.
     */
    public async restorePreviousContent(): Promise<void> {
        const uriKey = this._activeDocumentUriKey();
        const stored = uriKey !== undefined ? this._previousContent.get(uriKey) : undefined;
        if (uriKey === undefined || stored === undefined) {
            void vscode.window.showInformationMessage(
                vscode.l10n.t("No previous content is stored for this editor."),
            );
            return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriKey));
        // Through the per-document edit queue: a webview update in flight at
        // restore time would otherwise splice a range computed against the
        // pre-restore text into the post-restore document (and the swap would
        // store that garbled state as the new slot).
        await this._enqueueEdit(uriKey, async () => {
            const current = document.getText();
            if (current === stored) {
                void vscode.window.showInformationMessage(
                    vscode.l10n.t("The stored content is identical to the current document."),
                );
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(document.positionAt(0), document.positionAt(current.length)),
                stored,
            );
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                // The user explicitly asked for a recovery; a silent no-op would
                // read as success, so this failure is one of the few that toasts.
                reportErrorWithNotification(
                    "restorePreviousContent",
                    new Error("applyEdit was rejected"),
                    vscode.l10n.t("Could not restore the previous content. See the developer console for details."),
                );
                return;
            }
            this._previousContent.set(uriKey, current);
            void vscode.window.showInformationMessage(
                vscode.l10n.t("Previous content restored. Run the command again to swap back."),
            );
        });
    }

    /**
     * The document the restore command targets: the active Birta editor tab
     * (never another extension's custom editor), falling back to the last
     * panel we saw active (out-of-order viewState events can leave the tab
     * momentarily unreadable), else the active text editor — the slot
     * outlives its panel, so the command must work from the raw editor too.
     */
    private _activeDocumentUriKey(): string | undefined {
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        if (
            activeTab?.input instanceof vscode.TabInputCustom &&
            activeTab.input.viewType === MarkdownEditorProvider.viewType
        ) {
            return activeTab.input.uri.toString();
        }
        for (const [uriKey, panel] of this._webviewPanels) {
            if (panel === this._activePanel) { return uriKey; }
        }
        return vscode.window.activeTextEditor?.document.uri.toString();
    }

    /**
     * onWillSaveTextDocument participant: ask the webview to serialize the live
     * document NOW and resolve with the TextEdits that make the about-to-be-saved
     * bytes match it. Returns [] fast when there's nothing to flush (no live/ready
     * panel). The protocol (correlation, stale guards, the injectable safety
     * timeout — reachable only when the webview can't serialize in time, e.g. a
     * pathological multi-MB doc, MAR-137) lives in the SaveFlushController; this
     * method contributes only the markdown-aware edit computation.
     */
    private _flushWebviewEdits(
        document: vscode.TextDocument,
        uriKey: string,
    ): Promise<vscode.TextEdit[]> {
        const panel = this._webviewPanels.get(uriKey);
        if (!panel || !this._initializedPanels.has(uriKey)) {
            return Promise.resolve([]);
        }
        return this._flush.flushPendingEdit(
            uriKey,
            // Throws when the panel disposed between the guard and the post; the
            // controller resolves that to "no edits".
            (id) => postToWebview(panel.webview, { type: "flushSave", id }),
            async (content) => {
                const newContent = this._prepareContentForSave(content, uriKey);
                const before = document.getText();
                const replace = computeReplaceRange(before, newContent);
                if (!replace) { return []; } // document already current — nothing to write
                this._armTripwire(uriKey, before, newContent, "saveFlush");
                // Record the echo baseline BEFORE the save applies these edits, so
                // the resulting onDidChangeTextDocument is recognized as our own
                // (not an external change to re-push). (No tab-pin here: a save
                // only fires on an already-dirty document, which the dirtying
                // update already pinned.)
                this._lastSyncedText.set(uriKey, newContent);
                return [
                    vscode.TextEdit.replace(
                        new vscode.Range(
                            document.positionAt(replace.startOffset),
                            document.positionAt(replace.endOffset),
                        ),
                        replace.replacement,
                    ),
                ];
            },
        );
    }

    /** Pin the tab on first edit (remove the italic preview state) */
    private _pinTabOnFirstEdit(uriKey: string): void {
        if (this._pinnedDocuments.has(uriKey)) { return; }
        this._pinnedDocuments.add(uriKey);
        vscode.commands.executeCommand('workbench.action.keepEditor');
    }

    /**
     * openFile: resolve a document's local link to a real file and open it.
     * Smart mode (`birta.smartLinks`, default on) runs the resolver
     * chain in linkResolver.ts — workspace-root paths, ancestor content roots,
     * markdown suffix inference, wikilink filename matching — and warns
     * non-modally when nothing matches. Non-smart mode is pure path math with
     * no existence checks (the pre-smart behavior, minus the old
     * leading-`/` → filesystem-root bug).
     */
    private async _handleOpenFile(
        document: vscode.TextDocument,
        uriKey: string,
        rawPath: string,
        wiki: boolean,
    ): Promise<void> {
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

        // Separate the path from the fragment. A wikilink fragment is always a
        // heading; otherwise a numeric fragment is a line number (./file.md#27-30).
        const hashIdx = rawPath.indexOf("#");
        const filePath = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
        const fragment = hashIdx >= 0 ? rawPath.slice(hashIdx + 1) : undefined;
        const lineMatch = wiki ? undefined : fragment?.match(/^(\d+)(-\d+)?$/);
        const lineNumber = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

        const absPath = await this._resolveLinkTargetPath(document, filePath, wiki);
        if (!absPath) {
            void vscode.window.showWarningMessage(
                vscode.l10n.t('Could not find "{0}" in this workspace.', rawPath),
            );
            return;
        }

        const targetUri = vscode.Uri.file(absPath);
        if (/\.(md|markdown)$/i.test(absPath)) {
            // .md file: open with WYSIWYG preview; the line number is passed via
            // setPendingNavigation. A non-numeric fragment (file.md#some-heading,
            // [[page#Heading]]) resolves to the matching heading's line; no match
            // just opens the file without scrolling.
            let navLine = lineNumber;
            if (navLine === undefined && fragment) {
                navLine = await this._findHeadingLine(targetUri, fragment);
            }
            if (navLine !== undefined) {
                this.setPendingNavigation(absPath, navLine);
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
    }

    /**
     * The absolute file a link's path portion (fragment already stripped)
     * points at, via the linkResolver chain — shared by the openFile handler
     * and the popup's resolved-target hint so the hint always tells the truth
     * about where a click will go. Null only in smart mode when nothing
     * matches (non-smart mode returns the computed path unchecked, exactly
     * like the click does).
     */
    private async _resolveLinkTargetPath(
        document: vscode.TextDocument,
        filePath: string,
        wiki: boolean,
    ): Promise<string | null> {
        const docFsPath = document.uri.fsPath;
        const containingFolder = vscode.workspace.workspaceFolders?.find(
            f => docFsPath.startsWith(f.uri.fsPath + path.sep),
        );
        const workspaceRoot =
            containingFolder?.uri.fsPath ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

        const smartLinks = readBirtaSetting("smartLinks", document.uri);

        const ctx = { docFsPath, workspaceRootFsPath: workspaceRoot, smartLinks };
        const io: ResolverIo = {
            isFile: async (absPath) => {
                try {
                    const st = await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
                    return (st.type & vscode.FileType.File) !== 0;
                } catch {
                    return false;
                }
            },
            getFileIndex: async () => (await this._getLinkFileIndex()).map((u) => u.fsPath),
        };

        // A wikilink without smart resolution degrades to a plain path lookup
        // ("visible but safe" — the chip still opens whatever the bytes name).
        return wiki && smartLinks
            ? resolveWikiTarget(filePath, ctx, io)
            : resolveLinkPath(filePath, ctx, io);
    }

    /**
     * Replies to the popup's resolved-target hint request: where would this
     * link open right now? The reply is the workspace-relative path (posix,
     * for display), the absolute path when the target sits outside the
     * workspace, or null for a smart-mode miss.
     */
    private async _handleResolveLinkTarget(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
        rawPath: string,
        wiki: boolean,
    ): Promise<void> {
        const hashIdx = rawPath.indexOf("#");
        const filePath = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
        const absPath = filePath
            ? await this._resolveLinkTargetPath(document, filePath, wiki)
            : null;

        let resolved: string | null = null;
        if (absPath) {
            const docFsPath = document.uri.fsPath;
            const root = (vscode.workspace.workspaceFolders?.find(
                f => docFsPath.startsWith(f.uri.fsPath + path.sep),
            ) ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
            if (root) {
                const rel = path.relative(root, absPath);
                resolved = rel.startsWith("..") || path.isAbsolute(rel)
                    ? absPath
                    : rel.split(path.sep).join("/");
            } else {
                resolved = absPath;
            }
        }
        try {
            postToWebview(panel.webview, { type: "linkTargetResolved", id, resolved });
        } catch {
            // Panel disposed while the resolver awaited stat/findFiles.
        }
    }

    /**
     * 1-based line of the heading a link fragment names, or undefined. The
     * fragment may be a ready slug (`#some-heading`, possibly percent-encoded)
     * or raw heading text (a wikilink's `#Some Heading`); both are matched
     * against the target's headings slugged EXACTLY the way the webview slugs
     * its in-page anchors (shared/slug.ts + the same duplicate suffixing), so
     * cross-file and in-page navigation always agree.
     */
    private async _findHeadingLine(
        targetUri: vscode.Uri,
        fragment: string,
    ): Promise<number | undefined> {
        let text: string;
        try {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            text = doc.getText();
        } catch {
            return undefined;
        }
        let decoded = fragment;
        try {
            decoded = decodeURIComponent(fragment);
        } catch { /* keep raw */ }
        const wanted = new Set([decoded.toLowerCase(), slugify(decoded)]);

        // The webview slugs RENDERED heading text; scanHeadings yields raw
        // markdown. Reduce the inline constructs whose source bytes differ
        // from their rendering (links/images keep only their text, code
        // drops its backticks) so both sides produce the same slug.
        const rendered = (raw: string): string =>
            raw
                .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
                .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
                .replace(/`([^`]*)`/g, "$1");

        const counts = new Map<string, number>();
        for (const h of scanHeadings(text)) {
            const base = slugify(rendered(h.text));
            if (!base) continue;
            const count = counts.get(base) ?? 0;
            counts.set(base, count + 1);
            const slug = count === 0 ? base : `${base}-${count}`;
            if (wanted.has(slug)) return h.line;
        }
        return undefined;
    }

    /**
     * Live path for `editor.showFoldingControls` / `editor.folding` changes:
     * because the settings are resource-scoped, this re-resolves per open
     * document and posts per-webview — never one global postToAll value.
     */
    public broadcastFoldingConfig(): void {
        for (const [uriKey, panel] of this._webviewPanels) {
            const folding = readFoldingConfig(vscode.Uri.parse(uriKey));
            postToWebview(panel.webview, {
                type: "setFoldingControls",
                controls: folding.controls,
                enabled: folding.enabled,
            });
        }
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
        const cfg = getBirtaConfiguration(document.uri);
        try {
            // Images are always saved to the local workspace; nothing is uploaded off the machine.
            const { relPath, absUri } = await saveImageLocally(document.uri, cfg, data, mimeType, altText);
            const webviewUri = panel.webview.asWebviewUri(absUri);
            const url = webviewUri.toString();
            // Store the mapping so that on save, webviewUri is replaced back with relPath
            const uriMap = this._imageUriMaps.get(uriKey) ?? new Map<string, string>();
            this._imageUriMaps.set(uriKey, uriMap);
            uriMap.set(url, relPath);
            postToWebview(panel.webview, { type: 'imageUploaded', id, url });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            postToWebview(panel.webview, { type: 'imageUploadError', id, error: errMsg });
            vscode.window.showErrorMessage(vscode.l10n.t('Failed to save image: {0}', errMsg));
        }
    }

    /**
     * Paste-unfurl (MAR-178): fetch the page title for a pasted URL and reply so
     * the webview can upgrade its optimistically-inserted `[url](url)` to
     * `[title](url)`. ALWAYS replies — a null title (the failure/offline case) is
     * a valid answer meaning "keep the bare link" — so the webview never waits on
     * a lost message. The fetch itself is confined to `_fetchUnfurlTitle`, which
     * swallows and logs its own errors; this method only routes the reply.
     */
    private async _handleUnfurl(
        panel: vscode.WebviewPanel,
        id: string,
        url: string,
    ): Promise<void> {
        const title = await this._fetchUnfurlTitle(url);
        postToWebview(panel.webview, { type: "unfurlResult", id, url, title });
    }

    /**
     * Fetch `url` and return its deterministically-parsed title, or null on ANY
     * failure (non-http(s) scheme, bad URL, non-200, network error, timeout, no
     * title in the HTML). Never throws: paste-unfurl is best-effort, so every
     * failure degrades silently to the bare link and logs via the console-only
     * error sink (never a toast).
     *
     * This is the extension's ONLY outbound network request. It is gated by
     * `birta.network.enabled` (the master switch) AND `birta.pasteUnfurl.enabled`,
     * restricted to http(s) on every redirect hop, SSRF-guarded (urlGuard: no
     * localhost/private/link-local/metadata hosts, re-checked per hop),
     * time-bounded by an AbortController, and size-bounded by reading at most
     * UNFURL_MAX_BYTES.
     *
     * Defense in depth (MAR-179): the webview's own gates are the primary
     * control (it never posts `unfurlUrl` when either setting is off); BOTH
     * settings are re-checked here so a stale or rogue webview message can
     * never trigger a fetch the configuration forbids.
     */
    private async _fetchUnfurlTitle(url: string): Promise<string | null> {
        // Master switch AND the per-feature key: offline by default, and the
        // extension-side gate mirrors the webview's upstream gate exactly, so a
        // stale/rogue message can't fetch while either half says no. The
        // in-flight opt-in value bridges the async settings write (see
        // _networkWriteInFlight) — without it, the just-in-time accept's own
        // link would race the write and stay bare.
        const networkOn = this._networkWriteInFlight ?? readBirtaSetting("networkEnabled");
        if (!networkOn || !readBirtaSetting("pasteUnfurlEnabled")) {
            return null;
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UNFURL_FETCH_TIMEOUT_MS);
        try {
            // Redirects are followed MANUALLY so every hop — not just the
            // pasted URL — passes the same two checks:
            //  - http(s) only: never file:, data:, vscode:, or any other
            //    scheme a pasted string or a redirect could carry;
            //  - publicly routable host only (urlGuard): a pasted or
            //    redirected-to URL must not steer the extension host at
            //    localhost, RFC1918 space, or cloud metadata (SSRF — the
            //    fetched title lands in the document, so a probe would leak).
            // The single AbortController spans the whole chain, so the total
            // time stays bounded by UNFURL_FETCH_TIMEOUT_MS.
            for (let hop = 0; hop <= UNFURL_MAX_REDIRECTS; hop++) {
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return null;
                }
                if (!(await isPubliclyRoutableUrl(parsed))) {
                    return null;
                }
                const res = await globalThis.fetch(parsed.href, {
                    signal: controller.signal,
                    redirect: "manual",
                    // Ask for HTML and identify ourselves; some hosts serve a
                    // leaner page (or refuse) without these. No cookies.
                    headers: {
                        accept: "text/html,application/xhtml+xml",
                        "user-agent": "Birta-Writer/paste-unfurl",
                    },
                });
                if (res.status >= 300 && res.status < 400) {
                    const location = res.headers.get("location");
                    if (!location) { return null; }
                    parsed = new URL(location, parsed); // relative Location: ok
                    continue;
                }
                if (!res.ok) {
                    return null;
                }
                // Only parse text-ish responses; a PDF or image 200 has no
                // <title> and isn't worth streaming 512 KB of.
                const contentType = res.headers.get("content-type");
                if (contentType && !/^text\/|xhtml/i.test(contentType)) {
                    return null;
                }
                const html = await readCappedText(res, UNFURL_MAX_BYTES);
                return extractOgTitle(html);
            }
            return null; // redirect chain too long
        } catch (e) {
            // Offline, DNS failure, abort-on-timeout, malformed response, etc.
            reportError("unfurlUrl", e);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private async _handleGetProjectImages(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
        id: string,
    ): Promise<void> {
        const customPath = readBirtaSetting("imageLocalPath", document.uri).trim();
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

        postToWebview(panel.webview, { type: 'projectImagesList', id, images });
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
        postToWebview(panel.webview, { type: "fmSuggestions", key, values });
    }

    private async _handleGetPathSuggestions(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
        query: string,
    ): Promise<void> {
        const q = query.trim();
        if (!q) {
            postToWebview(panel.webview, { type: 'pathSuggestions', id, items: [] });
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
            postToWebview(panel.webview, { type: 'pathSuggestions', id, items: [] });
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

        postToWebview(panel.webview, { type: 'pathSuggestions', id, items });
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
            postToWebview(panel.webview, { type: 'linkTargetSuggestions', id, items });

        // An EMPTY query is allowed (the wikilink completer's bare `[[` —
        // ranking returns everything, markdown first, capped); a non-empty
        // query must still be a local path, never a URL/#anchor.
        if ((query.trim() !== "" && !isLocalPathQuery(query)) || document.uri.scheme !== 'file') {
            post([]);
            return;
        }
        const workspaceRoot = (vscode.workspace.getWorkspaceFolder(document.uri)
            ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
        if (!workspaceRoot) {
            post([]);
            return;
        }

        const uris = await this._getLinkFileIndex();

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
    private async _getLinkFileIndex(): Promise<readonly vscode.Uri[]> {
        const now = Date.now();
        if (!this._linkFileCache || now >= this._linkFileCache.expires) {
            const uris = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/dist/**,**/releases/**}',
                2000,
            );
            this._linkFileCache = { uris, expires: now + MarkdownEditorProvider._LINK_FILE_TTL_MS };
        }
        return this._linkFileCache.uris;
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
            postToWebview(panel.webview, { type: 'imagePathResolved', id, webviewUri });
        } catch { /* Invalid path, no response */ }
    }
}
