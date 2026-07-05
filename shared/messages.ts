/**
 * shared/messages.ts
 * The single source of truth for the bidirectional WebView ↔ Extension
 * message types. Both sides import from here; neither may redefine them inline.
 */

/** Image metadata: disk-relative path + WebView-accessible URI + file name */
export type ProjectImage = {
    relPath: string;
    webviewUri: string;
    name: string;
};

/** Path-completion suggestion entry */
export type PathSuggestionItem = {
    path: string;
    isDir: boolean;
    webviewUri?: string;  // returned only for image files, for thumbnail preview
};

/** Table cell wrapping mode */
export type TableWrapMode = "none" | "normal" | "aggressive";

/**
 * Messages sent WebView → Extension.
 * Every field reflects the sender's real constraints: a field the sender must
 * always provide is not declared optional.
 */
export type ToExtensionMessage =
    | { type: "ready" }
    | { type: "update"; content: string }
    | { type: "openUrl"; url: string }
    | { type: "openFile"; path: string }
    | { type: "debug"; message: string }
    | { type: "sendToClaudeChat"; text: string; startLine: number; endLine: number }
    | { type: "switchToTextEditor"; line?: number }
    | { type: "openSettings" }
    | { type: "saveImage"; id: string; data: Uint8Array; mimeType: string; altText: string }
    | { type: "getProjectImages"; id: string }
    | { type: "renameImage"; id: string; webviewUri: string; newBasename: string }
    | { type: "getPathSuggestions"; id: string; query: string }
    | { type: "resolveImagePath"; id: string; relPath: string }
    | { type: "frontmatterUpdate"; frontmatter: string }
    | { type: "tocWidth"; width: number };

/**
 * Messages sent Extension → WebView.
 * lineMap is optional on init/revert: the Extension always sends it, but the
 * WebView side guards with `?? []` just in case.
 */
export type ToWebviewMessage =
    | { type: "init"; content: string; lineMap?: number[]; scrollToLine?: number; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode }
    | { type: "revert"; content: string; lineMap?: number[]; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode }
    | { type: "scrollToLine"; line: number }
    | { type: "lineMapUpdate"; lineMap: number[] }
    | { type: "setDebugMode"; enabled: boolean }
    | { type: "imageSaved"; id: string; url: string }
    | { type: "imageSaveError"; id: string; error: string }
    | { type: "projectImagesList"; id: string; images: ProjectImage[] }
    | { type: "imageRenamed"; id: string; oldWebviewUri: string; newWebviewUri: string }
    | { type: "imageRenameError"; id: string; error: string }
    | { type: "requestSwitchToTextEditor" }
    | { type: "pathSuggestions"; id: string; items: PathSuggestionItem[] }
    | { type: "imagePathResolved"; id: string; webviewUri: string }
    | { type: "setTheme"; colors: Record<string, string> }
    | { type: "setTableWrap"; wrap: TableWrapMode };
