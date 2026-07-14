import type { ToExtensionMessage, ToWebviewMessage, ProjectImage } from "../shared/messages";

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

export function notifyOpenUrl(url: string): void {
    vscode.postMessage({ type: "openUrl", url });
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

export function notifyResolveImagePath(id: string, relPath: string): void {
    vscode.postMessage({ type: "resolveImagePath", id, relPath });
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
