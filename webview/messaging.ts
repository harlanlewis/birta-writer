import type { ToExtensionMessage, ToWebviewMessage, ProjectImage, TextCount } from "../shared/messages";
import { isReadOnly } from "./readOnly";

export type { ProjectImage };

// Re-exported so existing consumers (webview/index.ts, etc.) can keep referencing IncomingMessage unchanged
export type IncomingMessage = ToWebviewMessage;

declare function acquireVsCodeApi(): {
    postMessage(message: ToExtensionMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
};

// acquireVsCodeApi can only be called once
const vscode = acquireVsCodeApi();

// The syncVersion of the last init/externalUpdate the webview applied. Echoed
// back to the extension on every content update so it can drop edits the
// webview serialized against a document state it has since replaced.
let baseSyncVersion = 0;

/** Records the version of the latest authoritative content the webview applied. */
export function setBaseSyncVersion(version: number): void {
    baseSyncVersion = version;
}

export function notifyReady(): void {
    vscode.postMessage({ type: "ready" });
}

// Monotonic counter tagging every outbound content message (update + flushResult)
// so the extension can totally order them and drop a stale update that would
// revert a fresher flush.
let outSeq = 0;

export function notifyUpdate(markdown: string): void {
    vscode.postMessage({ type: "update", content: markdown, baseSyncVersion, seq: ++outSeq });
}

/**
 * Reply to a `flushSave` request with the just-serialized content, so the
 * extension's onWillSaveTextDocument participant can write the freshest bytes.
 * Carries the current `baseSyncVersion` for the same stale-guard as `update`,
 * and the next `seq` so a stale in-flight update can't supersede it.
 */
export function notifyFlushResult(id: string, content: string): void {
    vscode.postMessage({ type: "flushResult", id, content, baseSyncVersion, seq: ++outSeq });
}

// TEST-ONLY reply to `__getPerfMarks` (MAR-191): the live webview's `mdw:` marks.
export function notifyPerfMarks(id: string, marks: Record<string, number>): void {
    vscode.postMessage({ type: "__perfMarks", id, marks });
}

/**
 * Reply to `requestEditorContext` with the live file selection so a coding-agent
 * bridge (src/agentBridge/) can read what the user has open/selected. `context`
 * is null when no position can be mapped. Pull-only — see webview/agentContext.ts.
 */
export function notifyEditorContextResult(
    id: string,
    context: import("../shared/agentContext").EditorSelectionContext | null,
): void {
    vscode.postMessage({ type: "editorContextResult", id, context });
}

/**
 * The selection palette's @ button: ask the extension to run the same
 * birta.copyAgentReference command the context menu offers.
 */
export function notifyCopyAgentReference(): void {
    vscode.postMessage({ type: "copyAgentReference" });
}

/**
 * Ask Agent: hand the caret's prompt to the extension, which composes the
 * line reference in and routes it (src/agentBridge/askAgent.ts). `prompt` is
 * absent from the palette route, where the extension asks for it.
 */
export function notifyAskAgent(prompt?: string): void {
    vscode.postMessage(prompt === undefined ? { type: "askAgent" } : { type: "askAgent", prompt });
}

export function notifyOpenUrl(url: string): void {
    vscode.postMessage({ type: "openUrl", url });
}

/**
 * The settings dropdown opened, so the installed release has been looked at.
 * Fired on OPEN rather than on the What's-new row, because the dot claims only
 * that something is unseen, and the menu is where it is seen.
 */
export function notifyWhatsNewSeen(): void {
    vscode.postMessage({ type: "whatsNewSeen" });
}

/**
 * Report word / character / reading-time counts for the live document (and the
 * current selection, if any) so the extension can render its status bar item
 * (MAR-29). Called debounced, off the keystroke path.
 */
export function notifyWordCount(doc: TextCount, selection: TextCount | null): void {
    vscode.postMessage({ type: "wordCount", doc, selection });
}

/**
 * Report whether the webview holds OS focus, so the extension can gate
 * document-mutating keybindings on real editor focus (MAR-104). Tracks the
 * iframe window, not the ProseMirror editor, so focus parked on toolbar chrome
 * still counts as focused.
 */
export function notifyFocusState(focused: boolean): void {
    vscode.postMessage({ type: "focusState", focused });
}

export function notifyOpenFile(relativePath: string, opts?: { wiki?: true }): void {
    vscode.postMessage({
        type: "openFile",
        path: relativePath,
        ...(opts?.wiki ? { wiki: true as const } : {}),
    });
}

/**
 * Leave for the raw editor, carrying the source position it should open at
 * (a document line, plus a column when the caret could be mapped honestly).
 */
export function notifySwitchToTextEditor(
    target?: { line: number; column?: number; anchorLine?: number; anchorColumn?: number },
): void {
    vscode.postMessage({ type: "switchToTextEditor", ...target });
}

/**
 * The document's format cannot be parsed (fatal in MDX, impossible in
 * markdown): ask the extension to surface the error and fall back to the
 * text editor. Sent only from the init path, before any editor exists.
 *
 * `at` is the parser's position in BODY coordinates; the extension shifts it
 * by the frontmatter this side never saw before showing it to the user.
 */
export function notifyFatalParse(
    error: string,
    at?: { line: number; column: number },
): void {
    vscode.postMessage({ type: "fatalParse", error, ...at });
}

/** Opens the native Settings UI; `query` optionally narrows the filter. */
export function notifyOpenSettings(query?: string): void {
    vscode.postMessage({ type: "openSettings", ...(query ? { query } : {}) });
}

/**
 * Opens the native Keyboard Shortcuts UI filtered to this extension — the
 * one place where the user's EFFECTIVE bindings are always accurate (and
 * rebindable in place). Tooltips deliberately don't print shortcut defaults
 * for rebindable commands; this is the discoverability path instead.
 */
export function notifyOpenKeybindings(): void {
    vscode.postMessage({ type: "openKeybindings" });
}

export function notifyUploadImage(
    id: string,
    data: Uint8Array,
    mimeType: string,
    altText: string,
): void {
    vscode.postMessage({ type: "uploadImage", id, data, mimeType, altText });
}

export function notifyGetProjectImages(id: string): void {
    vscode.postMessage({ type: "getProjectImages", id });
}

export function notifyGetPathSuggestions(id: string, query: string): void {
    vscode.postMessage({ type: "getPathSuggestions", id, query });
}

export function notifyResolveLinkTarget(id: string, path: string, wiki?: true): void {
    vscode.postMessage({ type: "resolveLinkTarget", id, path, ...(wiki ? { wiki } : {}) });
}

export function notifyGetLinkTargetSuggestions(id: string, query: string): void {
    vscode.postMessage({ type: "getLinkTargetSuggestions", id, query });
}

/** Link editor "browse": open the OS file picker; reply is `linkTargetPicked`. */
export function notifyPickLinkTarget(id: string): void {
    vscode.postMessage({ type: "pickLinkTarget", id });
}

export function notifyResolveImagePath(id: string, relPath: string): void {
    vscode.postMessage({ type: "resolveImagePath", id, relPath });
}

/**
 * Paste-unfurl (MAR-178): ask the extension to fetch `url`'s page title so the
 * optimistically-inserted `[url](url)` can be upgraded to `[title](url)`. The
 * reply arrives as an `unfurlResult` correlated by `id`.
 */
export function notifyUnfurl(id: string, url: string): void {
    vscode.postMessage({ type: "unfurlUrl", id, url });
}

/**
 * Embed-card metadata (rung 1, render-only): ask the provider's own oEmbed
 * endpoint for a recognized URL's title. The reply arrives as an
 * `embedMetaResult` correlated by `id`; the title only ever decorates a card
 * caption — it is never written to the document.
 */
export function notifyResolveEmbedMeta(id: string, url: string): void {
    vscode.postMessage({ type: "resolveEmbedMeta", id, url });
}

/**
 * Link-card metadata (rung 1, render-only): ask the page a lone link names
 * for its Open Graph title and description. The reply arrives as a
 * `linkCardResult` correlated by `id`; it only ever fills a card and is never
 * written to the document.
 */
export function notifyResolveLinkCard(id: string, url: string): void {
    vscode.postMessage({ type: "resolveLinkCard", id, url });
}

/**
 * Connector card resolution (rung 2, MAR-198): ask the extension to fetch the
 * card fields a URL alone cannot know, using the credential the user connected.
 * The reply arrives as an `embedCardResult` correlated by `id`, carrying
 * sanitized fields or a named locked/expired/error state — never a credential.
 * Only posted for a connector the extension has said is connected.
 */
export function notifyResolveEmbedCard(id: string, url: string): void {
    vscode.postMessage({ type: "resolveEmbedCard", id, url });
}

/**
 * The locked card's just-in-time "Connect" affordance. The extension runs the
 * same flow the palette command runs and answers by rebroadcasting the
 * connection map; the webview never handles the credential, or hears about it.
 */
export function notifyConnectService(connector: string): void {
    vscode.postMessage({ type: "connectService", connector });
}

/**
 * Just-in-time opt-in (MAR-179): the user accepted the "Enable" affordance
 * offered when they did something that would use the network while the master
 * switch (`birta.network.enabled`) was off. The extension persists the setting
 * through the config write-back seam. Mirrors the other toolbar write-backs
 * (setContentWidth, setTocPosition): the webview posts the intent, the
 * extension owns the settings write.
 */
export function notifySetNetworkEnabled(enabled: boolean): void {
    vscode.postMessage({ type: "setNetworkEnabled", enabled });
}

/** The calc menu's "Always insert result" row → persist birta.calc.autoInsert. */
export function notifySetCalcAutoInsert(enabled: boolean): void {
    vscode.postMessage({ type: "setCalcAutoInsert", enabled });
}

/** The unfurl offer's "Always use fetched titles" row → persist birta.pasteUnfurl.autoApply. */
export function notifySetPasteUnfurlAutoApply(enabled: boolean): void {
    vscode.postMessage({ type: "setPasteUnfurlAutoApply", enabled });
}

/** The "Move checked tasks to bottom" toggle → persist birta.checklist.sinkChecked. */
export function notifySetChecklistSink(enabled: boolean): void {
    vscode.postMessage({ type: "setChecklistSink", enabled });
}

/** The "Highlight note markers" switch → persist birta.notes.highlightMarkers. */
export function notifySetNoteHighlight(enabled: boolean): void {
    vscode.postMessage({ type: "setNoteHighlight", enabled });
}

/**
 * Commit the frontmatter panel's edits.
 *
 * This is the ONE document write in the whole webview that does not go through
 * a ProseMirror transaction: the panel keeps its own undo stack and the
 * extension replaces the frontmatter byte range directly. Every other mutation
 * path is caught structurally by the read-only transaction filter
 * (plugins/readOnly.ts), which cannot see this one, so the mode is enforced
 * here instead — at the single sender, rather than in the panel's several
 * commit sites (MAR-53).
 */
export function notifyFrontmatterUpdate(frontmatter: string): void {
    if (isReadOnly()) { return; }
    vscode.postMessage({ type: "frontmatterUpdate", frontmatter, baseSyncVersion });
}

export function notifyRequestFmSuggestions(key: string): void {
    vscode.postMessage({ type: "requestFmSuggestions", key });
}

export function notifyTocWidth(width: number): void {
    vscode.postMessage({ type: "tocWidth", width });
}

export function notifyTocVisibility(
    visibility: import("../shared/messages").TocVisibility,
): void {
    vscode.postMessage({ type: "tocVisibility", visibility });
}

/** Persist the review sidebar's By-type/In-order mode (birta.review.groupByType). */
export function notifyReviewGroupByType(grouped: boolean): void {
    vscode.postMessage({ type: "reviewGroupByType", grouped });
}

export function notifySetProofreadOption(
    key: import("../shared/messages").ProofreadOptionKey,
    value: boolean,
): void {
    vscode.postMessage({ type: "setProofreadOption", key, value });
}

export function notifySpellAddWord(word: string): void {
    vscode.postMessage({ type: "spellAddWord", word });
}

export function notifySetFontPreset(preset: import("../shared/messages").FontPreset): void {
    vscode.postMessage({ type: "setFontPreset", preset });
}

/** Persist the content font size (percent of the editor font size). */
export function notifySetFontSize(size: number): void {
    vscode.postMessage({ type: "setFontSize", size });
}

/** Persist the content-width mode (auto/narrow/wide); echoes back as setContentWidth. */
export function notifySetContentWidth(mode: import("../shared/contentWidth").ContentWidthMode): void {
    vscode.postMessage({ type: "setContentWidth", mode });
}

export function notifySetToolbarLayout(
    item: { id: string; placement: import("../shared/messages").ToolbarPlacement } | undefined,
    order: string[],
): void {
    vscode.postMessage({ type: "setToolbarLayout", ...(item ? { item } : {}), order });
}

/** Persist whole-toolbar visibility (gear menu / right-click / expand tab). */
export function notifySetToolbarVisible(visible: boolean): void {
    vscode.postMessage({ type: "setToolbarVisible", visible });
}

/** Persist the TOC dock side (header flip button); echoes back as setTocPosition. */
export function notifySetTocPosition(position: import("../shared/messages").TocPosition): void {
    vscode.postMessage({ type: "setTocPosition", position });
}

export function notifyLintBlocks(id: number, blocks: import("../shared/messages").LintBlock[]): void {
    vscode.postMessage({ type: "lintBlocks", id, blocks });
}

/** Asks the extension to write serialized selection text to the system clipboard. */
export function notifyClipboardWrite(format: "html" | "markdown", data: string): void {
    vscode.postMessage({ type: "clipboardWrite", format, data });
}

/** Disk-drift badge click: asks the extension for the reload/compare picker. */
export function notifyResolveSyncConflict(): void {
    vscode.postMessage({ type: "resolveSyncConflict" });
}

/**
 * Report an uncaught error / unhandled rejection to the extension so it can
 * log it and (once) notify the user (MAR-169). Called only by the crash
 * boundary in crashReporter.ts, which owns the rate limiting.
 */
export function notifyCrash(
    message: string,
    stack: string | undefined,
    source: "error" | "unhandledrejection" | "nodeview",
): void {
    vscode.postMessage({ type: "crash", message, ...(stack ? { stack } : {}), source });
}

export function onMessage(handler: (msg: IncomingMessage) => void): void {
    window.addEventListener("message", (event: MessageEvent) => {
        handler(event.data as IncomingMessage);
    });
}

export function getWebviewState(): Record<string, unknown> | null {
    return vscode.getState() as Record<string, unknown> | null;
}

/** Debounce for the extension-side echo: scroll writes per frame; one message
 * per pause is plenty for a store that only matters across a mode switch. */
const VIEW_STATE_ECHO_DELAY_MS = 250;
let _viewStateEchoTimer: ReturnType<typeof setTimeout> | null = null;

/** Post the current bag to the extension NOW, cancelling any pending echo. */
function flushViewStateEcho(): void {
    if (_viewStateEchoTimer) {
        clearTimeout(_viewStateEchoTimer);
        _viewStateEchoTimer = null;
    }
    const latest = getWebviewState();
    if (latest) { vscode.postMessage({ type: "viewState", state: latest }); }
}

export function setWebviewState(state: Record<string, unknown>): void {
    vscode.setState(state);
    // Mirror the bag to the extension (per-URI, workspaceState-backed): VS
    // Code's own webview state does not survive the raw-editor round trip —
    // that switch CLOSES the custom tab — so folds, scroll, per-block
    // widths, and the frontmatter collapse were silently reset. The
    // extension hands the bag back in `init`.
    if (_viewStateEchoTimer) { clearTimeout(_viewStateEchoTimer); }
    _viewStateEchoTimer = setTimeout(() => {
        _viewStateEchoTimer = null;
        const latest = getWebviewState();
        if (latest) { vscode.postMessage({ type: "viewState", state: latest }); }
    }, VIEW_STATE_ECHO_DELAY_MS);
}

// Teardown flush: a write made just before the panel goes away (toggle a
// width, immediately switch to the raw editor) must not die in the 250ms
// debounce window. Best-effort — a hard-killed webview can't post, which is
// why the previous echo is already durable extension-side.
window.addEventListener("pagehide", () => {
    if (_viewStateEchoTimer) { flushViewStateEcho(); }
});
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && _viewStateEchoTimer) {
        flushViewStateEcho();
    }
});
