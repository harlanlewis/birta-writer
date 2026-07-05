/**
 * shared/messages.ts
 * The single source of truth for the bidirectional WebView ↔ Extension message types.
 * Both sides import from here; inlining duplicate definitions on either side is forbidden.
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
    webviewUri?: string;  // Returned only for image files, for thumbnail preview
};

/** Table line-wrapping mode */
export type TableWrapMode = "none" | "normal" | "aggressive";

/**
 * Messages in the WebView → Extension direction.
 * Every field reflects the sender's actual constraints: fields the sender must
 * always provide must not be declared optional.
 */
export type ToExtensionMessage =
    | { type: "ready" }
    | { type: "update"; content: string }
    | { type: "openUrl"; url: string }
    | { type: "openFile"; path: string }
    | { type: "debug"; message: string }
    | { type: "switchToTextEditor"; line?: number }
    | { type: "openSettings" }
    | { type: "uploadImage"; id: string; data: Uint8Array; mimeType: string; altText: string }
    | { type: "getProjectImages"; id: string }
    | { type: "renameImage"; id: string; webviewUri: string; newBasename: string }
    | { type: "getPathSuggestions"; id: string; query: string }
    | { type: "resolveImagePath"; id: string; relPath: string }
    | { type: "frontmatterUpdate"; frontmatter: string }
    | { type: "tocWidth"; width: number };

/**
 * Messages in the Extension → WebView direction.
 * lineMap is optional in init/revert: the Extension always sends it, but the
 * WebView side falls back to `?? []` just in case.
 */
export type ToWebviewMessage =
    | { type: "init"; content: string; lineMap?: number[]; scrollToLine?: number; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode }
    | { type: "revert"; content: string; lineMap?: number[]; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode }
    | { type: "scrollToLine"; line: number }
    | { type: "lineMapUpdate"; lineMap: number[] }
    | { type: "setDebugMode"; enabled: boolean }
    | { type: "imageUploaded"; id: string; url: string }
    | { type: "imageUploadError"; id: string; error: string }
    | { type: "projectImagesList"; id: string; images: ProjectImage[] }
    | { type: "imageRenamed"; id: string; oldWebviewUri: string; newWebviewUri: string }
    | { type: "imageRenameError"; id: string; error: string }
    | { type: "requestSwitchToTextEditor" }
    | { type: "pathSuggestions"; id: string; items: PathSuggestionItem[] }
    | { type: "imagePathResolved"; id: string; webviewUri: string }
    | { type: "setTheme"; colors: Record<string, string> }
    | { type: "setTableWrap"; wrap: TableWrapMode };
