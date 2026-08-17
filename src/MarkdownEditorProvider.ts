import * as path from "path";
import * as vscode from "vscode";
import { computeReplaceRange } from "../shared/textEdit";
import { DOCUMENT_EXTENSIONS, DOCUMENT_EXT_REGEX } from "../shared/documentExtensions";
import { saveImageLocally } from "./utils/imageService";
import { computeLineMap, sourceLineCount } from "../shared/lineMap";
import { extractFrontmatter, restoreContentForSave } from "../shared/contentTransform";
import { extractListValuesByKey, rankListValues } from "../shared/frontmatterSuggestions";
import { buildLinkTargetItems } from "./utils/linkTargetSuggestions";
import { DiskDriftController } from "./diskDrift";
import { settlePhantomDirty } from "./phantomDirty";
import { judgeReplacement } from "../shared/destructiveGuard";
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
    updateUserSetting,
} from "./config";
import { SaveFlushController, type BaseRejection, type FlushBackend } from "../shared/saveFlushController";
import { watchExternalDocumentChanges } from "./externalChanges";
import { buildWebviewHtml, getCustomResourceRoots, clampNumberSetting, escapeHtmlAttr } from "./webviewHtml";
import { reportError, reportErrorWithNotification } from "./errorSink";
import { resolveLinkPath, resolveWikiTarget, type ResolverIo } from "./utils/linkResolver";
import { detectLogseq } from "./utils/logseqDetect";
import { scanHeadings } from "../shared/headingScan";
import { extractOgTitle } from "./utils/openGraph";
import { isPubliclyRoutableUrl } from "./utils/urlGuard";
import { readCappedText } from "./utils/cappedRead";
import { fetchEmbedTitle } from "./utils/embedMetaFetcher";
import type { ConnectorService } from "./connectors/connectorService";
import { asConnectorId, runConnectFlow } from "./connectors/commands";
import { slugify } from "../shared/slug";
import { isLocalPathQuery, rankLinkTargets } from "../shared/linkTargetSuggest";
import { lintBlocks } from "./utils/harperService";
import type { ToExtensionMessage, ToWebviewMessage, TextCount, LogseqReason } from "../shared/messages";
import type { EditorSelectionContext } from "../shared/agentContext";
import type { WordCountView } from "./wordCountStatus";
import type { EditorCommandId } from "../shared/editorCommands";
import { normalizeBlockHandlesMode } from "../shared/blockHandles";
import { normalizeTocVisibility } from "../shared/tocVisibility";
import { acknowledgeSeen, unreadNow } from "./whatsNew";

/**
 * Allowlist of URL schemes permitted to open in the user's default browser.
 * Blocks schemes a malicious document could abuse (file:/vscode:/command:/javascript:),
 * which trigger local file access or command execution rather than harmless external navigation.
 */
const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * File extensions this editor can open, and the set a clicked link routes
 * into the WYSIWYG view rather than handing to `vscode.open`. It must mirror
 * `contributes.customEditors[].selector` in package.json: an extension named
 * here but not there sends `vscode.openWith` at a viewType that refuses the
 * file, and the click lands nowhere. `package.json`'s selector is the
 * authority; `editorSelectorParity.test.ts` reads both and fails on a drift.
 */
const WYSIWYG_EXT_REGEX = DOCUMENT_EXT_REGEX;

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

/** A `(3:1)` or `(3:1-3:6)` position embedded in a parser's own message. */
const EMBEDDED_POSITION_REGEX = /\((\d+):(\d+)(?:-(\d+):(\d+))?\)/g;

/**
 * The message shown when a document's format cannot be parsed and the tab
 * falls back to the text editor.
 *
 * The webview renders the BODY, so every position it reports counts from the
 * first body line; the user is about to be looking at the whole file in the
 * text editor, where that line is `frontmatterLines` further down. Shifting is
 * this side's job because the frontmatter is this side's secret: the webview
 * has never seen it (see `_prepareContentForDisplay`).
 */
export function fatalParseNotice(
    error: string,
    at: { line: number; column: number } | undefined,
    frontmatterLines: number,
): string {
    const shifted = frontmatterLines > 0
        ? error.replace(EMBEDDED_POSITION_REGEX, (_m, l1, c1, l2, c2) =>
            l2 === undefined
                ? `(${Number(l1) + frontmatterLines}:${c1})`
                : `(${Number(l1) + frontmatterLines}:${c1}-${Number(l2) + frontmatterLines}:${c2})`)
        : error;
    const head = "This file isn't valid MDX, so it opened in the text editor instead";
    if (!at) {
        return `${head}: ${shifted}`;
    }
    return `${head}. Line ${at.line + frontmatterLines}, column ${at.column}: ${shifted}`;
}

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

// readCappedText lives in utils/cappedRead.ts (shared with the embed-metadata
// fetcher); unfurl passes "</head>" as its early-stop marker — titles live in
// <head>, so once the closing tag streams past there is nothing worth reading.

/**
 * A place in the document a panel should navigate to: a 1-indexed document
 * line, plus the caret column when the navigation's origin knew one — a mode
 * switch and a search hit both do (the latter via src/searchNavigation.ts),
 * a bare `#L10` fragment doesn't.
 */
interface NavTarget {
    line: number;
    column?: number;
    /** The selection's other end, when a raw-editor selection rides the switch. */
    anchorLine?: number;
    anchorColumn?: number;
}

export class MarkdownEditorProvider
    implements vscode.CustomTextEditorProvider {
    public static readonly viewType = "birta.editor";

    // Tracks the webviewPanel for each document (used to push new content on external changes)
    private readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();

    // A flush whose edits were handed to a save and whose applied-ack is held
    // until the save confirms them. computeEdits resolving proves the edits
    // were RETURNED to the waitUntil, not that VS Code applied them — the
    // willSave budget can expire, or a queued edit can change the document and
    // void the participant's edits. The verdict is settled at
    // onDidSaveTextDocument by comparing the saved text against `expected`;
    // acking applied on unapplied bytes would re-open MAR-349 on that path.
    // At most one per document: a newer decided flush acks the old one
    // discarded, and a save that never completes leaves the entry to be
    // replaced the same way.
    private readonly _pendingFlushAcks = new Map<string, { id: string; expected: string }>();

    // The panel that is currently the active editor. Command-palette and
    // right-click commands (MAR-9) target it. Set on resolve and whenever a
    // panel becomes active; cleared when that panel deactivates or is disposed
    // — so while a raw editor or another view has focus, this is null, not the
    // last panel that was active.
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

    // The document's text as of the last moment it had no unsaved changes: what
    // a revert would find on disk. A string compare against it is the cheap
    // gate that keeps the phantom-dirty settle (src/phantomDirty.ts) from
    // reading the file on every sync of a typing burst.
    private readonly _savePointText = new Map<string, string>();

    // Documents inside a save's participant window. Those edits reach the
    // document outside the edit queue, so this is what the phantom-dirty
    // settle checks to know the queue is not the whole story right now.
    private readonly _savingDocuments = new Set<string>();

    // The flush/seq protocol bookkeeping (sync versions, applied-seq high-water
    // marks, in-flight save flushes) lives in the SaveFlushController — see
    // shared/saveFlushController.ts for the invariants. Constructed in the
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
    /**
     * uriKey → the webview's last view-state bag (fold anchors, scroll,
     * frontmatter collapse, per-block widths/wrap). VS Code's own webview
     * state dies with the tab, and switching to the raw editor CLOSES the
     * tab — this echo is what lets the recreated webview restore the user's
     * view. The map is a read-through cache over `workspaceState` (the
     * VIEW_STATE_MEMENTO_KEY entry below), so a deliberate per-block choice
     * survives window reloads and full restarts too — the same scope VS Code
     * gives its own per-file view state (cursor/folds/scroll persist per
     * workspace, never in the file, never across workspaces). Maintainer
     * decision 2026-07-28, superseding the earlier session-scope-on-purpose
     * design: a width the user set on a table should not evaporate because
     * they peeked at the raw source.
     */
    private readonly _viewStateMap = new Map<string, Record<string, unknown>>();

    /**
     * The workspaceState entry backing _viewStateMap — the first Memento in
     * this codebase, so the conventions live here: one versioned namespace
     * key (`birta.viewState.v1` — bump on shape changes, never migrate in
     * place), value `{ [uriKey]: { t: lastWriteMs, s: bag } }`, LRU-bounded
     * to VIEW_STATE_MAX_DOCS by `t` on every write. Keys are absolute
     * `file://` URIs: a renamed or deleted file simply orphans its entry
     * until eviction (view state degrades to defaults — never guessed).
     * Access is optional-chained throughout: unit tests stub the extension
     * context without a workspaceState, and a provider without a Memento
     * must degrade to the in-memory session scope, not throw.
     */
    private static readonly VIEW_STATE_MEMENTO_KEY = "birta.viewState.v1";
    private static readonly VIEW_STATE_MAX_DOCS = 100;

    private _readViewStateMemento(): Record<string, { t: number; s: Record<string, unknown> }> {
        const raw = this.context.workspaceState?.get?.(MarkdownEditorProvider.VIEW_STATE_MEMENTO_KEY);
        return raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, { t: number; s: Record<string, unknown> }>)
            : {};
    }

    /** The durable bag for a document: live map first, then workspaceState. */
    private _viewStateFor(uriKey: string): Record<string, unknown> | undefined {
        const live = this._viewStateMap.get(uriKey);
        if (live) {
            return live;
        }
        const persisted = this._readViewStateMemento()[uriKey]?.s;
        if (persisted && typeof persisted === "object") {
            this._viewStateMap.set(uriKey, persisted);
            return persisted;
        }
        return undefined;
    }

    /** Write-through: cache in the map, persist to workspaceState (LRU-capped). */
    private _storeViewState(uriKey: string, state: Record<string, unknown>): void {
        this._viewStateMap.set(uriKey, state);
        if (!this.context.workspaceState?.update || Object.keys(state).length === 0) {
            return;
        }
        const all = { ...this._readViewStateMemento() };
        all[uriKey] = { t: Date.now(), s: state };
        const keys = Object.keys(all);
        if (keys.length > MarkdownEditorProvider.VIEW_STATE_MAX_DOCS) {
            keys.sort((a, b) => (all[a]?.t ?? 0) - (all[b]?.t ?? 0));
            for (const evict of keys.slice(0, keys.length - MarkdownEditorProvider.VIEW_STATE_MAX_DOCS)) {
                delete all[evict];
            }
        }
        // Fire-and-forget: Memento writes are async and this runs on a
        // message handler; a failed write degrades to session scope.
        void this.context.workspaceState.update(MarkdownEditorProvider.VIEW_STATE_MEMENTO_KEY, all);
    }

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

    // Pending navigation position (temporarily stored on global-search click /
    // editor switch) key: fsPath. `column` is present only when the source of
    // the navigation knew one — a mode switch carries the caret and a search
    // hit its match range; a bare `#L10` fragment knows only its line.
    private readonly _pendingNavigations = new Map<string, NavTarget & { ts: number }>();

    // Panels that have finished WebView initialization (sent a ready message) key: uriKey
    private readonly _initializedPanels = new Set<string>();

    // Panels whose webview currently holds OS focus (MAR-104). Mirrored into the
    // `birta.webviewFocused` when-clause context key so document-mutating
    // keybindings fire only while an editor is truly focused, not merely because
    // its tab is the active custom editor with focus parked elsewhere.
    private readonly _focusedPanels = new Set<string>();

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

    // Coding-agent bridge (src/agentBridge/): the document behind the active
    // panel, and the in-flight requestEditorContext correlations. Tracked
    // alongside `_activePanel` so getActiveEditorContext can name the file and
    // route the pull to the right webview.
    private _activeDocument: vscode.TextDocument | null = null;
    private _contextReqSeq = 0;
    private readonly _pendingContext = new Map<
        string,
        (context: EditorSelectionContext | null) => void
    >();

    public static current: MarkdownEditorProvider | null = null;

    /** How long getActiveEditorContext waits for the webview's reply before null. */
    private static readonly CONTEXT_REQUEST_TIMEOUT_MS = 1000;

    /** Inject the status bar word-count view (called once from extension.ts). */
    public setWordCountView(view: WordCountView): void {
        this._wordCountView = view;
    }

    /**
     * The workspace folder that owns `document` — the base every `@/…` path in
     * that file resolves against.
     *
     * The single source of truth for this, deliberately (MAR-216). Six call
     * sites used to answer it two different ways: `getWorkspaceFolder`, and a
     * hand-rolled `workspaceFolders.find(f => fsPath.startsWith(f.fsPath + sep))`.
     * Those disagree whenever one workspace folder is nested inside another —
     * `.find` returns the FIRST folder that is a prefix, `getWorkspaceFolder`
     * returns the MOST SPECIFIC one. With `/repo` and `/repo/docs` both open, a
     * file in `/repo/docs` resolved to `/repo` on some paths and `/repo/docs`
     * on others, so the same `@/img.png` pointed at two different files
     * depending on whether it went through link resolution or image rewriting.
     *
     * `getWorkspaceFolder` is the correct one: it is what VS Code itself means
     * by "the containing folder", including its own multi-root tie-breaking.
     * The `?? [0]` fallback keeps files outside any folder working.
     */
    private _workspaceRootFor(document: vscode.TextDocument): string | undefined {
        return (
            vscode.workspace.getWorkspaceFolder(document.uri)
            ?? vscode.workspace.workspaceFolders?.[0]
        )?.uri.fsPath;
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

    /**
     * The file + live selection currently active in a Birta editor, or null when
     * no Birta editor is active or the webview did not answer in time.
     *
     * This is the neutral source the coding-agent bridge (src/agentBridge/) reads
     * so agents that rely on vscode.window.activeTextEditor — undefined for a
     * custom editor (microsoft/vscode#102110) — can still see what the user has
     * open/selected. Pull-only: it asks the active webview on demand, so the
     * editor's selection path is never touched until an agent requests context.
     */
    public async getActiveEditorContext(): Promise<
        { uri: vscode.Uri; context: EditorSelectionContext } | null
    > {
        const panel = this._activePanel;
        const document = this._activeDocument;
        if (!panel || !document) { return null; }
        const context = await this._requestEditorContext(panel);
        return context ? { uri: document.uri, context } : null;
    }

    /**
     * Post a `requestEditorContext` to one webview and resolve with its reply,
     * or null if the panel is disposed or does not answer within the timeout (a
     * wedged webview degrades to "no context" rather than hanging the caller).
     */
    private _requestEditorContext(
        panel: vscode.WebviewPanel,
    ): Promise<EditorSelectionContext | null> {
        const id = `ctx-${++this._contextReqSeq}`;
        return new Promise((resolve) => {
            const finish = (context: EditorSelectionContext | null): void => {
                clearTimeout(timer);
                this._pendingContext.delete(id);
                resolve(context);
            };
            const timer = setTimeout(
                () => finish(null),
                MarkdownEditorProvider.CONTEXT_REQUEST_TIMEOUT_MS,
            );
            this._pendingContext.set(id, finish);
            try {
                postToWebview(panel.webview, { type: "requestEditorContext", id });
            } catch {
                // Disposed panel: no reply will ever arrive.
                finish(null);
            }
        });
    }

    /**
     * The line map for `text`, paired with the source lines its frontmatter
     * occupies (MAR-23).
     *
     * The map must describe the BODY, because that — not the whole file — is
     * what the webview renders: entry `i` has to line up with `doc.child(i)`.
     * The offset is what keeps the wire in document lines regardless, so a
     * navigation into a file with frontmatter no longer lands a block early.
     */
    private _lineMapFor(text: string): { lineMap: number[]; lineOffset: number } {
        const { frontmatter, body } = extractFrontmatter(text);
        return { lineMap: computeLineMap(body), lineOffset: sourceLineCount(frontmatter) };
    }

    /** Called from extension.ts: stash a pending navigation position; if the panel is visible and ready, send it immediately */
    public setPendingNavigation(
        fsPath: string,
        line: number,
        column?: number,
        anchor?: { line: number; column?: number },
    ): void {
        const nav: NavTarget = {
            line,
            column,
            ...(anchor ? { anchorLine: anchor.line, anchorColumn: anchor.column } : {}),
        };
        this._pendingNavigations.set(fsPath, { ...nav, ts: Date.now() });
        // Panel already exists and is initialized → send directly, no need to wait for onDidChangeViewState
        const uriKey = vscode.Uri.file(fsPath).toString();
        if (this._initializedPanels.has(uriKey)) {
            const panel = this._webviewPanels.get(uriKey);
            // Only send immediately when the panel is currently visible (a hidden panel means the user just switched away, so don't send the line number back)
            if (panel && panel.visible) {
                postToWebview(panel.webview, { type: 'scrollToLine', ...nav });
                // Don't delete _pendingNavigations; keep it as a fallback for ready on panel rebuild (valid within TTL 5s)
            }
        }
    }

    /** Send an arbitrary message to the panel for the given URI (for extension.ts to call) */
    public postToPanel(uri: vscode.Uri, msg: ToWebviewMessage): void {
        const panel = this._webviewPanels.get(uri.toString());
        if (panel) { postToWebview(panel.webview, msg); }
    }

    private _consumePendingNavigation(fsPath: string): NavTarget | undefined {
        const pending = this._pendingNavigations.get(fsPath);
        if (!pending) { return undefined; }
        this._pendingNavigations.delete(fsPath);
        // Treat anything older than 5 seconds as expired; do not apply
        if (Date.now() - pending.ts > 5000) { return undefined; }
        const { ts: _ts, ...nav } = pending;
        return nav;
    }

    public postToAll(msg: ToWebviewMessage): void {
        for (const panel of this._webviewPanels.values()) {
            postToWebview(panel.webview, msg);
        }
    }

    /**
     * The connector service (MAR-198), owned by activate() because it holds
     * `context.secrets`. Absent until then, and absent in unit tests that
     * construct a provider directly — every use site treats that as "no
     * connectors", which is the same answer as "nothing connected".
     */
    private _connectors: ConnectorService | null = null;

    public setConnectorService(service: ConnectorService): void {
        this._connectors = service;
    }

    /**
     * Tell every open webview which services are connected. Called when a
     * webview reports ready, and after every connect or disconnect, so a card
     * locked a moment ago unlocks in place rather than on the next reopen.
     */
    public broadcastConnectorState(): void {
        const connectors = this._connectors;
        if (!connectors) { return; }
        connectors.connectionStates()
            .then((states) => this.postToAll({ type: "connectorStateChanged", connectors: states }))
            .catch((err) => reportError("connectorState", err));
    }

    /**
     * Detect whether `document` belongs to a Logseq graph and tell its webview.
     *
     * The `birta.logseq: off` default returns before any IO and before the
     * detector is even called, so the feature costs one setting read per open
     * for everyone who does not use it. `auto` stats the document's ancestor
     * directories, which is why this is a message sent AFTER `init` rather than
     * a field baked into the launch bootstrap (see `logseqState` in
     * shared/messages.ts).
     *
     * Fire-and-forget: a panel disposed mid-detection makes postToWebview
     * throw, which is a dead editor rather than a failure worth reporting.
     *
     * `announceOff` is the difference between the two callers. On open, `off`
     * sends nothing at all — the webview boots with the badge hidden, so a
     * message saying so is the one message the default configuration could
     * still have been paying. On a settings change it must be sent, or a panel
     * already told "logseq" would keep the badge after the setting went off.
     */
    public detectLogseqFor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        announceOff = false,
    ): void {
        const mode = readBirtaSetting("logseq", document.uri);
        if (mode === "off") {
            if (announceOff) { this._postLogseqState(panel, null); }
            return;
        }
        const workspaceRoot =
            vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? null;
        detectLogseq(
            mode,
            {
                docFsPath: document.uri.fsPath,
                workspaceRootFsPath: workspaceRoot,
                text: document.getText(),
            },
            {
                isFile: (p) => this._statIsType(p, vscode.FileType.File),
                isDirectory: (p) => this._statIsType(p, vscode.FileType.Directory),
            },
        )
            .then((reason) => this._postLogseqState(panel, reason))
            .catch((err) => reportError("logseqDetect", err));
    }

    /** Post to a panel that may already be gone (see detectLogseqFor). */
    private _postLogseqState(
        panel: vscode.WebviewPanel,
        reason: LogseqReason | null,
    ): void {
        try {
            postToWebview(panel.webview, { type: "logseqState", reason });
        } catch {
            // Panel disposed while detection was in flight.
        }
    }

    /** `stat` reduced to "is it this kind of node", with missing → false. */
    private async _statIsType(absPath: string, kind: vscode.FileType): Promise<boolean> {
        try {
            const st = await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
            return (st.type & kind) !== 0;
        } catch {
            return false;
        }
    }

    /** Re-run Logseq detection for every open editor (the setting changed). */
    public redetectLogseqAll(): void {
        for (const [uriKey, panel] of this._webviewPanels) {
            const doc = vscode.workspace.textDocuments.find(
                (d) => d.uri.toString() === uriKey,
            );
            if (doc) { this.detectLogseqFor(doc, panel, true); }
        }
    }

    /** Sends a message to the active editor panel (no-op when none is active). */
    public postToActivePanel(msg: ToWebviewMessage): void {
        if (this._activePanel) { postToWebview(this._activePanel.webview, msg); }
    }

    /** TEST-ONLY (MAR-191): pending `__getPerfMarks` requests, id → resolver. */
    private _pendingPerfMarks = new Map<string, (marks: Record<string, number>) => void>();

    /**
     * TEST-ONLY (MAR-191): ask the active webview for its live `mdw:` launch
     * marks so the integration suite can measure real VS Code launch time and
     * validate the headless harness. Resolves with `{}` on timeout so a wedged
     * webview can never hang the suite.
     */
    public requestPerfMarks(timeoutMs = 3000): Promise<Record<string, number>> {
        const id = `pm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._pendingPerfMarks.delete(id);
                resolve({});
            }, timeoutMs);
            this._pendingPerfMarks.set(id, (marks) => {
                clearTimeout(timer);
                resolve(marks);
            });
            this.postToActivePanel({ type: "__getPerfMarks", id });
        });
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
     *    `_activePanel` (whichever of them reported active most recently) may
     *    name the wrong split;
     * 3. `_activePanel`, which is LIVE rather than sticky: the panel that is
     *    active in its group right now, or null once it deactivates (see the
     *    field's declaration). So a command from a raw editor with no Birta
     *    panel active anywhere is dropped, and one issued while a Birta panel
     *    is active in another group reaches that panel.
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
        flushBackend?: FlushBackend,
    ) {
        this._flush = new SaveFlushController<vscode.TextEdit>(flushTimeoutMs, flushBackend);
        this._watchWorkspaceIndex();
        // The save point outlives its PANEL on purpose (a document closed dirty
        // and reopened keeps it), so the panel's dispose is the wrong place to
        // drop it. This is the right one: a document VS Code has closed cannot
        // come back dirty from memory, and without it the map holds one full
        // copy of every Markdown file opened for the life of the host.
        this.context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this._savePointText.delete(doc.uri.toString());
            }),
        );
    }

    /**
     * Drop the two workspace-index caches the moment the FILE SET changes
     * (MAR-208). Both are keyed only by a TTL, so nothing about them captures
     * what is on disk: a file created a moment ago would not autocomplete for
     * up to 10s, and a deleted one kept being offered — the TTL was the only
     * thing bounding staleness.
     *
     * Create/delete only, which is also what a rename fires. A content EDIT can
     * change a file's frontmatter values but not the file set, so it stays on
     * the coarse TTL backstop rather than invalidating a 500-file scan on every
     * save of any `.md` in the workspace.
     *
     * Clearing is O(1) — the slot is rebuilt lazily on the next menu open — so
     * a noisy workspace costs nothing. The watcher honours `files.watcherExclude`.
     */
    private _watchWorkspaceIndex(): void {
        const watcher = vscode.workspace.createFileSystemWatcher("**/*");
        const invalidate = (uri: vscode.Uri): void => {
            this._linkFileCache = undefined;
            if (isFrontMatterScanned(uri.fsPath)) {
                this._fmScanCache = undefined;
            }
        };
        this.context.subscriptions.push(
            watcher,
            watcher.onDidCreate(invalidate),
            watcher.onDidDelete(invalidate),
        );
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
        // A document with nothing unsaved IS its own save point. Recorded (and
        // deliberately not dropped when the panel is disposed) because it is a
        // fact about the file rather than about this editor: a document that is
        // dirty when reopened has no other way to learn where its save point
        // was, and a stale entry can cost only the disk read that confirms it.
        if (!document.isDirty) { this._savePointText.set(uriKey, document.getText()); }
        // A freshly resolved editor is the active one.
        this._activePanel = webviewPanel;
        this._activeDocument = document;
        // Show cached counts if we've seen this document before, else clear any
        // stale readout from the previously active editor until the webview
        // reports (MAR-29).
        this._renderWordCount(uriKey);

        webviewPanel.onDidDispose(() => {
            this._webviewPanels.delete(uriKey);
            // Drop cached counts; hide the readout if this was the active editor
            // (its status bar figures no longer describe anything) (MAR-29).
            this._wordCounts.delete(uriKey);
            if (this._activePanel === webviewPanel) {
                this._wordCountView?.hide();
                this._activePanel = null;
                this._activeDocument = null;
            }
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
                    this._activeDocument = null;
                    this._wordCountView?.hide();
                }
                return;
            }
            // Track the active panel for command-palette / context-menu routing.
            this._activePanel = p;
            this._activeDocument = document;
            // Restore this document's cached counts into the status bar (MAR-29).
            this._renderWordCount(uriKey);
            if (!this._initializedPanels.has(uriKey)) { return; }
            // A navigation stashed while this panel was hidden (the mode switch
            // sets one before the panel is activated) lands as it comes back.
            // Nothing can stash one LATER than this: every origin now captures
            // its target before the panel is opened or revealed.
            const nav = this._consumePendingNavigation(document.uri.fsPath);
            if (nav !== undefined) {
                postToWebview(p.webview, { type: "scrollToLine", ...nav });
            }
        });

        webviewPanel.webview.onDidReceiveMessage(
            async (message: ToExtensionMessage) => {
                const panel = webviewPanel;
                switch (message.type) {
                    case "__perfMarks": {
                        // TEST-ONLY reply (MAR-191): resolve the pending getPerfMarks request.
                        this._pendingPerfMarks.get(message.id)?.(message.marks);
                        this._pendingPerfMarks.delete(message.id);
                        break;
                    }
                    case "ready": {
                        // Mark the panel as initialized; only after this will onDidChangeViewState handle pending navigation
                        this._initializedPanels.add(uriKey);
                        const initContent = document.getText();
                        const displayContent = this._prepareContentForDisplay(initContent, document, webviewPanel, uriKey);
                        // Consume the pending navigation (set when switching preview / first opening from global search)
                        const nav = this._consumePendingNavigation(document.uri.fsPath);
                        const tableWrap = readBirtaSetting("tableWrap");
                        // Reset the echo baseline: init hands this exact text to the webview
                        this._lastSyncedText.set(uriKey, initContent);
                        // Reset the sync version so the webview's baseSyncVersion
                        // starts aligned with the extension.
                        this._flush.resetWebviewBaseline(uriKey);
                        postToWebview(webviewPanel.webview, {
                            type: "init",
                            content: displayContent,
                            // `.mdx` selects the webview's MDX FormatModule
                            // (structural, never-executed JSX/ESM islands);
                            // everything else is markdown. Derived from the
                            // URI because a custom editor's document has no
                            // reliable languageId of its own.
                            format: document.uri.path.toLowerCase().endsWith(".mdx")
                                ? "mdx"
                                : "markdown",
                            ...this._lineMapFor(initContent),
                            frontmatter: this._frontmatterMap.get(uriKey) || undefined,
                            imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
                            tableWrap,
                            syncVersion: 0,
                            viewState: this._viewStateFor(uriKey),
                            ...(nav !== undefined
                                ? {
                                      scrollToLine: nav.line,
                                      ...(nav.column !== undefined ? { scrollToColumn: nav.column } : {}),
                                      ...(nav.anchorLine !== undefined
                                          ? { scrollToAnchorLine: nav.anchorLine, scrollToAnchorColumn: nav.anchorColumn }
                                          : {}),
                                  }
                                : {}),
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
                        // Which services are connected (MAR-198). Sent after
                        // init because reading it is async (the keychain) while
                        // the __i18n snapshot is baked synchronously into the
                        // HTML. The webview's default is "nothing connected",
                        // so the wait costs a locked card, never a wrong fetch.
                        this.broadcastConnectorState();
                        // Same placement, and the same reason: detection is
                        // async while init is on the path to first paint.
                        this.detectLogseqFor(document, webviewPanel);
                        // The unread dot, from the answer activation already
                        // computed. A webview is disposed on every switch to
                        // the raw editor, so a fresh one has to be told; the
                        // read is not repeated because the answer cannot have
                        // changed in between.
                        if (unreadNow()) {
                            postToWebview(webviewPanel.webview, {
                                type: "whatsNewUnread",
                                unread: true,
                            });
                        }
                        break;
                    }
                    case "update":
                        if (message.content !== undefined) {
                            // Stale-update rejection: the webview serialized this
                            // against content we've since replaced (an
                            // externalUpdate landed after it read the document).
                            // The backend decides what a rejected base means
                            // (MAR-346): the default drops it and re-pushes the
                            // current authoritative state so the webview re-bases.
                            let content = message.content;
                            if (!this._flush.isAdmissibleBase(uriKey, message.baseSyncVersion)) {
                                const rejection = this._flush.rejectBase(uriKey, message.baseSyncVersion, content);
                                if (rejection.outcome !== "rebase") {
                                    this._settleBaseRejection(rejection, document, webviewPanel, uriKey);
                                    break;
                                }
                                // The backend carried the edit forward; admit its
                                // rebased content in place of the proposal.
                                content = rejection.content;
                            }
                            const newContent = this._prepareContentForSave(content, uriKey);
                            const seq = message.seq;
                            void this._enqueueEdit(uriKey, async () => {
                                // Ordering guard (checked at apply time, in queue
                                // order, and claimed even when the apply turns out
                                // to be a no-op — see claimSeq): drop an update a
                                // save-flush has already superseded, so it can
                                // never revert fresher content.
                                if (!this._flush.claimSeq(uriKey, seq)) { return; }
                                const outcome = await this._applyWebviewEdit(document, newContent);
                                if (outcome === "rejected") {
                                    // The edit exists only in the webview. It is
                                    // not lost — the save flush re-serializes at
                                    // save time — but silence here is how a
                                    // divergence goes unnoticed, so say so.
                                    reportError(
                                        "applyWebviewEdit",
                                        new Error(`applyEdit rejected for ${uriKey}`),
                                    );
                                    return;
                                }
                                // Identical to the current document (e.g. serializer no-op echo): nothing to do
                                if (outcome === "noop") { return; }
                                this._pinTabOnFirstEdit(uriKey);
                                postToWebview(webviewPanel.webview, { type: "lineMapUpdate", ...this._lineMapFor(document.getText()) });
                                // An edit that lands the buffer back on the
                                // save point — the webview's own Cmd+Z undoing
                                // to the state the file was opened or saved in
                                // — leaves VS Code claiming unsaved changes for
                                // a document that has none (MAR-364). Inside
                                // the edit queue, so no later update can slip
                                // between the settle's checks and its revert.
                                if (newContent === this._savePointText.get(uriKey)) {
                                    try {
                                        await settlePhantomDirty(
                                            document,
                                            webviewPanel,
                                            uriKey,
                                            MarkdownEditorProvider.viewType,
                                            () => this._savingDocuments.has(uriKey),
                                        );
                                    } catch (err) {
                                        // A failed settle costs a dot that stays
                                        // lit, never the edit that has already
                                        // been applied above. Report rather than
                                        // reject: the queue's recovery only runs
                                        // when a later edit arrives, so a
                                        // rejection here can go unhandled.
                                        reportError("settlePhantomDirty", err);
                                    }
                                }
                            });
                        }
                        break;
                    case "frontmatterUpdate": {
                        // Stale-update rejection (same rule as "update"): the
                        // backend judges a frontmatter edit serialized against
                        // replaced content. A `rebase` outcome is settled as a
                        // re-push here rather than admitted: this path replaces
                        // only the frontmatter block, and a backend rebases whole
                        // documents — re-basing the webview is the correct
                        // degradation either way.
                        if (!this._flush.isAdmissibleBase(uriKey, message.baseSyncVersion)) {
                            const rejection = this._flush.rejectBase(uriKey, message.baseSyncVersion, message.frontmatter);
                            this._settleBaseRejection(
                                rejection.outcome === "rebase" ? { outcome: "repush" } : rejection,
                                document,
                                webviewPanel,
                                uriKey,
                            );
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
                            // A frontmatter edit changes how many source lines
                            // precede the body, so the offset travels with the map.
                            postToWebview(webviewPanel.webview, { type: "lineMapUpdate", ...this._lineMapFor(document.getText()) });
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
                    case "whatsNewSeen":
                        // Stamp the install and drop the dot everywhere at
                        // once: it is per-install state, so a second open
                        // editor must not keep showing it.
                        void acknowledgeSeen(this.context).then(() => {
                            this.postToAll({ type: "whatsNewUnread", unread: false });
                        });
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
                    case "pickLinkTarget": {
                        await this._handlePickLinkTarget(document, webviewPanel, message.id)
                            .catch((err) => {
                                reportError("pickLinkTarget", err);
                                // The webview's browse button waits on this reply —
                                // a swallowed failure must still read as "canceled".
                                postToWebview(webviewPanel.webview, {
                                    type: "linkTargetPicked", id: message.id, path: null,
                                });
                            });
                        break;
                    }
                    case "fatalParse": {
                        // The document cannot open in the WYSIWYG editor —
                        // its format's parse is fatal on this content (MDX: a
                        // stray `{`, an unclosed tag). Surface the error and
                        // fall back to the text editor. The webview never
                        // mounted an editor, so the document is untouched and
                        // the tab cannot be dirty from this session.
                        void vscode.window.showErrorMessage(
                            fatalParseNotice(
                                message.error,
                                message.line !== undefined && message.column !== undefined
                                    ? { line: message.line, column: message.column }
                                    : undefined,
                                sourceLineCount(this._frontmatterMap.get(uriKey) ?? ""),
                            ),
                        );
                        MarkdownEditorProvider.suppressAutoSwitch.add(document.uri.toString());
                        setTimeout(() => MarkdownEditorProvider.suppressAutoSwitch.delete(document.uri.toString()), 2000);
                        const viewCol = webviewPanel.viewColumn;
                        let customTab: vscode.Tab | undefined;
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                if (
                                    tab.input instanceof vscode.TabInputCustom &&
                                    (tab.input as vscode.TabInputCustom).uri.toString() === document.uri.toString()
                                ) {
                                    customTab = tab;
                                    break;
                                }
                            }
                        }
                        if (customTab) {
                            const closed = await vscode.window.tabGroups.close(customTab);
                            if (!closed) { break; }
                        } else {
                            webviewPanel.dispose();
                        }
                        const textDoc = await vscode.workspace.openTextDocument(document.uri);
                        await vscode.window.showTextDocument(textDoc, {
                            viewColumn: viewCol,
                            preserveFocus: false,
                        });
                        break;
                    }
                    case "switchToTextEditor": {
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
                        // Columns are advisory and can only be trusted for the
                        // line the webview computed them against, so both ends
                        // are clamped to their line's real length here — the
                        // document is the authority on where a line ends.
                        const clampedPos = (line: number, column?: number): vscode.Position => {
                            const lineIndex = Math.min(line - 1, document.lineCount - 1);
                            return new vscode.Position(
                                lineIndex,
                                Math.min(column ?? 0, document.lineAt(lineIndex).text.length),
                            );
                        };
                        const active =
                            message.line && message.line > 0
                                ? clampedPos(message.line, message.column)
                                : undefined;
                        if (active) {
                            opts.selection = new vscode.Range(active, active);
                        }

                        const textDoc = await vscode.workspace.openTextDocument(document.uri);
                        const editor = await vscode.window.showTextDocument(textDoc, opts);
                        if (editor && active) {
                            // A carried selection is restored with its drag
                            // direction (anchor→active).
                            if (message.anchorLine && message.anchorLine > 0) {
                                editor.selection = new vscode.Selection(
                                    clampedPos(message.anchorLine, message.anchorColumn),
                                    active,
                                );
                            }
                            // opts.selection reveals with minimal scrolling,
                            // which parks the arriving caret at the viewport
                            // edge; center it, matching what the WYSIWYG side
                            // does for an arriving line.
                            editor.revealRange(
                                new vscode.Range(active, active),
                                vscode.TextEditorRevealType.InCenter,
                            );
                        }
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
                    case "viewState":
                        // The webview mirrors its state bag here (debounced);
                        // handed back in `init` so folds/scroll/frontmatter
                        // collapse/per-block widths survive the raw-editor
                        // round trip — and, via workspaceState, window
                        // reloads and restarts too.
                        if (message.state && typeof message.state === "object") {
                            this._storeViewState(uriKey, message.state);
                        }
                        break;
                    case "resolveEmbedMeta":
                        // Embed-card metadata (rung 1, render-only): resolve the
                        // provider's oEmbed title. Always replies — a null title
                        // on any failure or closed gate — so the webview's
                        // backstop timer rarely fires. The .catch is a backstop
                        // for a post to a disposed panel.
                        if (message.id && message.url) {
                            this._handleResolveEmbedMeta(panel, message.id, message.url)
                                .catch((err) => reportError("resolveEmbedMeta", err));
                        }
                        break;
                    case "resolveEmbedCard":
                        // Connector card (rung 2, render-only): resolve against
                        // the provider's API with the connected credential.
                        // Always replies — a null result or a named locked /
                        // expired / error state — so the webview's backstop
                        // timer rarely fires. The .catch is a backstop for a
                        // post to a disposed panel.
                        if (message.id && message.url) {
                            this._handleResolveEmbedCard(panel, message.id, message.url)
                                .catch((err) => reportError("resolveEmbedCard", err));
                        }
                        break;
                    case "connectService": {
                        // The locked card's just-in-time affordance, into the
                        // same flow the palette command runs. The connector id
                        // is validated against the known roster, so a stale or
                        // rogue message cannot name a service that does not
                        // exist.
                        const service = this._connectors;
                        const connector = typeof message.connector === "string"
                            ? asConnectorId(message.connector)
                            : null;
                        if (service && connector) {
                            runConnectFlow(service, connector, () => this.broadcastConnectorState())
                                .catch((err) => reportError("connectService", err));
                        }
                        break;
                    }
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
                            clampNumberSetting(message.width, 260, 240, 600),
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
                    case "reviewGroupByType":
                        // Persist the review sidebar's By-type/In-order mode to
                        // birta.review.groupByType; the config-change listener
                        // echoes reviewConfig to every open editor.
                        //
                        // The argument is the SETTINGS key, not the config
                        // snapshot's field name. They coincide for every flat
                        // setting, which is why this was the one site that got
                        // it wrong: `reviewGroupByType` is the field,
                        // `review.groupByType` is the key, and writing the
                        // field name addressed a setting that does not exist,
                        // so the toggle never survived a reload.
                        void updateSettingRespectingScope(
                            "review.groupByType",
                            Boolean(message.grouped),
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
                        // "Enable" affordance. Consent keys are application-
                        // scoped (MAR-199), so this writes to USER settings
                        // unconditionally — a workspace write would be ignored
                        // on read and land in a committable file.
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
                            updateUserSetting("network.enabled", message.enabled),
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
                        // Consent key (application scope, MAR-199) — user
                        // settings unconditionally, like network.enabled.
                        updateUserSetting("pasteUnfurl.autoApply", message.enabled);
                        break;
                    case "setChecklistSink":
                        // The "Move checked tasks to bottom" toggle (toolbar Lists
                        // menu / task-list block menu). Same local-gate model
                        // as calc.autoInsert.
                        updateSettingRespectingScope("checklist.sinkChecked", message.enabled);
                        break;
                    case "setNoteHighlight":
                        // The "Highlight notes" switch (Checks menu / Notes tab /
                        // palette). The config-change listener broadcasts
                        // `notesConfig`, which re-gates every open webview.
                        updateSettingRespectingScope("notes.highlightMarkers", message.enabled);
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
                        // waitUntil resolver the freshest serialized content. A reply
                        // with no parked flush (late, after the timeout resolved the
                        // save without it) still holds a baseline candidate webview-side,
                        // so it is acked as discarded rather than ignored (MAR-349).
                        if (!this._flush.resolveFlush(message.id, {
                            content: message.content,
                            baseSyncVersion: message.baseSyncVersion,
                            seq: message.seq,
                        })) {
                            this._ackFlush(webviewPanel, message.id, false);
                        }
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
                    case "editorContextResult":
                        // Reply to a getActiveEditorContext pull (src/agentBridge/).
                        // No-op if the request already timed out and was dropped.
                        this._pendingContext.get(message.id)?.(message.context);
                        break;
                    case "copyAgentReference":
                        // The selection palette's @ button: same command as the
                        // context menu, so payload and feedback stay identical.
                        vscode.commands.executeCommand("birta.copyAgentReference");
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
                // One materialization: `getText()` copies the whole document
                // out of the piece table, and the clean branch below is the
                // common one under files.autoSave.
                const text = document.getText();
                // A change that leaves the document clean (VS Code's own reload
                // of an externally written file, a revert, a git checkout) put
                // it on a new save point.
                if (!document.isDirty) { this._savePointText.set(uriKey, text); }
                const panel = this._webviewPanels.get(uriKey);
                if (!panel) { return; }
                // The document settled back to the webview's state within the debounce window
                if (text === this._lastSyncedText.get(uriKey)) { return; }
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
            // A save's participant edits bypass the edit queue (see
            // SaveFlushController), so the queue is not a total order over the
            // document's writers and the phantom-dirty settle must not run
            // inside this window: it would judge the document against bytes
            // the save is about to replace. Cleared on didSave, and re-set
            // here, so a save that never completes costs a lit dot until the
            // next one rather than wedging the settle for the session.
            this._savingDocuments.add(uriKey);
            e.waitUntil(this._flushWebviewEdits(document, uriKey));
        });
        // Settle the held applied-ack (see _pendingFlushAcks): the save is done,
        // so the saved text is the ground truth on whether the flushed bytes
        // actually reached the document.
        const didSaveSubscription = vscode.workspace.onDidSaveTextDocument((saved) => {
            if (saved.uri.toString() !== uriKey) { return; }
            // The write moved the save point; an undo back to the PREVIOUS one
            // is now a real edit. Recorded before the ack bookkeeping below,
            // which returns early when no flush was in flight.
            this._savingDocuments.delete(uriKey);
            this._savePointText.set(uriKey, saved.getText());
            const pending = this._pendingFlushAcks.get(uriKey);
            if (!pending) { return; }
            this._pendingFlushAcks.delete(uriKey);
            this._ackFlush(webviewPanel, pending.id, saved.getText() === pending.expected);
        });
        // Dispose the subscriptions when the panel closes
        webviewPanel.onDidDispose(() => {
            changeSubscription.dispose();
            willSaveSubscription.dispose();
            didSaveSubscription.dispose();
            this._pendingFlushAcks.delete(uriKey);
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
            ...this._lineMapFor(text),
            frontmatter: this._frontmatterMap.get(uriKey) || undefined,
            imageUriMap: Object.fromEntries(this._imageUriMaps.get(uriKey) ?? []),
            tableWrap,
            syncVersion: version,
        });
    }

    /**
     * Act on the backend's verdict for a proposal whose base was rejected
     * (MAR-346 inversion 3). `rebase` never reaches here — the caller admits
     * the carried-forward content instead. With the default backend only
     * `repush` ever fires; the other arms exist so a backend that answers
     * differently changes behavior HERE, not silently inside the protocol.
     */
    private _settleBaseRejection(
        rejection: Exclude<BaseRejection, { outcome: "rebase" }>,
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        uriKey: string,
    ): void {
        switch (rejection.outcome) {
            case "repush":
                // Drop the content and re-push authoritative state so the
                // webview re-bases — the host's long-standing behavior.
                this._pushExternalUpdate(document, panel, uriKey);
                break;
            case "defer":
                // The backend expects the remote to settle; push nothing. The
                // next observed external change re-bases the webview anyway.
                break;
            case "escalate":
                // Tell the user, change nothing: the same advisory surface the
                // disk-drift conflict uses.
                postToWebview(panel.webview, { type: "syncConflict", state: "conflict" });
                break;
        }
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
     * single minimal range replacement.
     *
     * `"noop"` — the document already holds this content (the common
     * serializer echo). `"applied"` — the document now holds it. `"rejected"`
     * — VS Code refused the edit (a concurrent version change, a closed or
     * read-only document); the edit lives ONLY in the webview.
     *
     * The three must stay distinct, because `"rejected"` needs its own
     * handling. `_lastSyncedText` has to be written BEFORE `applyEdit` —
     * `onDidChangeTextDocument` fires during it and must recognise the change
     * as ours — so on rejection the baseline claims content the document does
     * not have. It is rolled back there, and must be: otherwise every later
     * comparison reads as "already in sync" and the webview and the document
     * stay silently diverged with no path back. (The save flush is the backstop
     * either way: it asks the webview to serialize at save time and does not
     * consult this baseline.)
     */
    private async _applyWebviewEdit(
        document: vscode.TextDocument,
        newContent: string,
    ): Promise<"applied" | "noop" | "rejected"> {
        const uriKey = document.uri.toString();
        const before = document.getText();
        const replace = computeReplaceRange(before, newContent);
        if (!replace) { return "noop"; }
        this._armTripwire(uriKey, before, newContent, "update");
        // Record the expected text BEFORE applying: onDidChangeTextDocument
        // fires during applyEdit and must recognize this change as our own.
        const prevSynced = this._lastSyncedText.get(uriKey);
        this._lastSyncedText.set(uriKey, newContent);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(
                document.positionAt(replace.startOffset),
                document.positionAt(replace.endOffset),
            ),
            replace.replacement,
        );
        if (await vscode.workspace.applyEdit(edit)) {
            return "applied";
        }
        // Un-poison the baseline: the document never took this content.
        if (prevSynced === undefined) {
            this._lastSyncedText.delete(uriKey);
        } else {
            this._lastSyncedText.set(uriKey, prevSynced);
        }
        return "rejected";
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
        // The full text computeEdits handed to the save, for the held
        // applied-ack's didSave comparison. Set before onDecided(true) can fire.
        let preparedContent = "";
        return this._flush.flushPendingEdit(
            uriKey,
            // Throws when the panel disposed between the guard and the post; the
            // controller resolves that to "no edits".
            (id) => postToWebview(panel.webview, { type: "flushSave", id }),
            async (content) => {
                const newContent = this._prepareContentForSave(content, uriKey);
                preparedContent = newContent;
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
            // The verdict, toward the webview's parked baseline candidate
            // (MAR-349). Discarded is final and posts now. Applied is only
            // optimistic here — the edits were handed to the waitUntil, which
            // VS Code can still drop — so it is HELD and settled against the
            // saved text at onDidSaveTextDocument (see _pendingFlushAcks).
            (id, applied) => {
                if (!applied) {
                    this._ackFlush(panel, id, false);
                    return;
                }
                const prev = this._pendingFlushAcks.get(uriKey);
                if (prev) { this._ackFlush(panel, prev.id, false); }
                this._pendingFlushAcks.set(uriKey, { id, expected: preparedContent });
            },
        );
    }

    /**
     * Post a flush verdict, best-effort: a panel disposed mid-save throws
     * synchronously from postToWebview (by design — see webviewMessaging.ts)
     * and has no baseline candidate left to correct.
     */
    private _ackFlush(panel: vscode.WebviewPanel, id: string, applied: boolean): void {
        try {
            postToWebview(panel.webview, { type: "flushAck", id, applied });
        } catch {
            // panel gone — nothing to ack
        }
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
        if (WYSIWYG_EXT_REGEX.test(absPath)) {
            // A file this editor can open: open with WYSIWYG preview; the line
            // number is passed via setPendingNavigation. A non-numeric fragment
            // (file.md#some-heading, [[page#Heading]]) resolves to the matching
            // heading's line; no match just opens the file without scrolling.
            // `.mdx` routes here too and picks up MDX mode from the init
            // format, which is derived from the same URI.
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
        const workspaceRoot = this._workspaceRootFor(document) ?? null;

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
            const root = this._workspaceRootFor(document);
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
     * Link editor "browse" (pickLinkTarget): open the OS-native file picker
     * anchored at the document's folder and reply with the picked file as a
     * DOCUMENT-relative posix path — the same form the link resolver and the
     * inline autocomplete author, so the resulting link reads and resolves
     * like a hand-typed one. Cancel (or an untitled document) replies null;
     * the webview keeps its field untouched either way until a real path
     * arrives.
     */
    private async _handlePickLinkTarget(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        id: string,
    ): Promise<void> {
        const reply = (picked: string | null): void => {
            try {
                postToWebview(panel.webview, { type: "linkTargetPicked", id, path: picked });
            } catch {
                // Panel disposed while the dialog waited on the user.
            }
        };
        if (document.uri.scheme !== "file") {
            reply(null);
            return;
        }
        const docDir = path.dirname(document.uri.fsPath);
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(docDir),
            openLabel: vscode.l10n.t("Select Link Target"),
        });
        const fsPath = picked?.[0]?.fsPath;
        if (!fsPath) {
            reply(null);
            return;
        }
        reply(path.relative(docDir, fsPath).split(path.sep).join("/"));
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
        const workspaceRoot = this._workspaceRootFor(document);
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
     * Embed-card metadata: resolve and ALWAYS reply (null title on failure).
     * The fetch itself — recognition, endpoint pinning, gates, cache — lives
     * in utils/embedMetaFetcher.ts; the in-flight opt-in value is passed
     * through so the just-in-time accept's own cards resolve immediately
     * (the same bridge _fetchUnfurlTitle reads directly).
     */
    private async _handleResolveEmbedMeta(
        panel: vscode.WebviewPanel,
        id: string,
        url: string,
    ): Promise<void> {
        const title = await fetchEmbedTitle(url, {
            networkOverride: this._networkWriteInFlight ?? undefined,
        });
        postToWebview(panel.webview, { type: "embedMetaResult", id, url, title });
    }

    /**
     * Connector card resolution: resolve and ALWAYS reply. Recognition, the
     * request built from validated parts, the pinned hosts, the credential and
     * the cache all live in connectors/; this method only routes the reply.
     * With no service (unit tests, or an activate that has not run) the answer
     * is null, which leaves the rung-0 card exactly as it is.
     */
    private async _handleResolveEmbedCard(
        panel: vscode.WebviewPanel,
        id: string,
        url: string,
    ): Promise<void> {
        const result = (await this._connectors?.resolveCard(url)) ?? null;
        postToWebview(panel.webview, { type: "embedCardResult", id, url, result });
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
                const html = await readCappedText(res, UNFURL_MAX_BYTES, "</head>");
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
        const workspaceRoot = this._workspaceRootFor(document);

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
        const workspaceRoot = this._workspaceRootFor(document);
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
        const workspaceRoot = this._workspaceRootFor(document);
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
