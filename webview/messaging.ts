import type { ToExtensionMessage, ToWebviewMessage, ProjectImage } from "../shared/messages";

export type { ProjectImage };

// Re-export 以保持现有消费者（webview/index.ts 等）对 IncomingMessage 的引用不变
export type IncomingMessage = ToWebviewMessage;

declare function acquireVsCodeApi(): {
    postMessage(message: ToExtensionMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
};

// acquireVsCodeApi 只能调用一次
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

export function notifyOpenFile(relativePath: string): void {
    vscode.postMessage({ type: "openFile", path: relativePath });
}

export function notifySwitchToTextEditor(line?: number): void {
    vscode.postMessage({ type: "switchToTextEditor", ...(line !== undefined ? { line } : {}) });
}

export function notifyOpenSettings(): void {
    vscode.postMessage({ type: "openSettings" });
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

export function notifySetStyleCheckEnabled(enabled: boolean): void {
    vscode.postMessage({ type: "setStyleCheckEnabled", enabled });
}

export function notifySetSpellCheckEnabled(enabled: boolean): void {
    vscode.postMessage({ type: "setSpellCheckEnabled", enabled });
}

export function notifySpellAddWord(word: string): void {
    vscode.postMessage({ type: "spellAddWord", word });
}

export function notifyLintBlocks(id: number, blocks: import("../shared/messages").LintBlock[]): void {
    vscode.postMessage({ type: "lintBlocks", id, blocks });
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
