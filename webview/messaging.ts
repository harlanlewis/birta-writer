import type { ToExtensionMessage, ToWebviewMessage, ProjectImage, TextCount } from "../shared/messages";

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

export function notifyOpenUrl(url: string): void {
    vscode.postMessage({ type: "openUrl", url });
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

export function notifySwitchToTextEditor(line?: number): void {
    vscode.postMessage({ type: "switchToTextEditor", ...(line !== undefined ? { line } : {}) });
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

export function notifyFrontmatterUpdate(frontmatter: string): void {
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

/** Persist the resting block-handles mode; echoes back as setBlockHandles. */
export function notifySetBlockHandles(mode: import("../shared/blockHandles").BlockHandlesMode): void {
    vscode.postMessage({ type: "setBlockHandles", mode });
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
    source: "error" | "unhandledrejection",
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

export function setWebviewState(state: Record<string, unknown>): void {
    vscode.setState(state);
}
