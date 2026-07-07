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

export function notifyUpdate(markdown: string): void {
    vscode.postMessage({ type: "update", content: markdown, baseSyncVersion });
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

export function notifyRenameImage(
    id: string,
    webviewUri: string,
    newBasename: string,
): void {
    vscode.postMessage({ type: "renameImage", id, webviewUri, newBasename });
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

export function notifySetToolbarLayout(
    item: { id: string; placement: import("../shared/messages").ToolbarPlacement } | undefined,
    order: string[],
): void {
    vscode.postMessage({ type: "setToolbarLayout", ...(item ? { item } : {}), order });
}

export function notifyLintBlocks(id: number, blocks: import("../shared/messages").LintBlock[]): void {
    vscode.postMessage({ type: "lintBlocks", id, blocks });
}

/** Asks the extension to write serialized selection text to the system clipboard. */
export function notifyClipboardWrite(format: "html" | "markdown", data: string): void {
    vscode.postMessage({ type: "clipboardWrite", format, data });
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
