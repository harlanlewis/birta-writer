/**
 * shared/messages.ts
 * The single authoritative source for WebView ↔ Extension message types.
 * Both sides import from here; inline duplicate definitions are forbidden.
 */

import type { EditorCommandId } from "./editorCommands";

/** Image metadata: disk-relative path + WebView-accessible URI + file name */
export type ProjectImage = {
    relPath: string;
    webviewUri: string;
    name: string;
};

/** 路径补全建议条目 */
export type PathSuggestionItem = {
    path: string;
    isDir: boolean;
    webviewUri?: string;  // 仅图片文件时返回，供缩略图预览
};

/** Link target suggestion: one workspace file in both of its addressable forms */
export type LinkTargetSuggestionItem = {
    /** Path relative to the current document (e.g. "../notion/index.md") */
    relative: string;
    /** Workspace-root-based path with a leading slash (e.g. "/write/notion/index.md") */
    rootRelative: string;
};

/** 表格换行模式 */
export type TableWrapMode = "none" | "normal" | "aggressive";

/** One text block sent for grammar/spell linting (key = block position). */
export type LintBlock = { key: number; text: string };

/** A Harper finding mapped to plain data: char span within the block text. */
export type HarperLint = {
    start: number;
    end: number;
    /** Harper's pretty kind, e.g. "Spelling", "Grammar", "Redundancy" */
    kind: string;
    message: string;
    suggestions: string[];
};

export type LintBlockResult = { key: number; lints: HarperLint[] };

/** Proofread (style check + spell check) configuration snapshot */
export type ProofreadConfig = {
    /** Style check master switch (fillers/redundancies/clichés/repeated-word strikethrough) */
    styleCheck: boolean;
    fillers: boolean;
    redundancies: boolean;
    cliches: boolean;
    /** Phrases the style check must never flag (user's escape valve) */
    styleExceptions: string[];
    /** Spell check master switch (bundled English dictionary) */
    spellCheck: boolean;
    /** The user's personal dictionary, persisted in settings */
    userWords: string[];
};

/**
 * WebView → Extension messages.
 * Every field reflects the sender's real constraints: fields the sender must
 * provide are never optional.
 *
 * `baseSyncVersion` is the syncVersion of the last init/externalUpdate the
 * webview applied; the extension drops content updates whose base doesn't
 * match its current version (the webview serialized against stale content)
 * and re-pushes the current state instead.
 */
export type ToExtensionMessage =
    | { type: "ready" }
    | { type: "update"; content: string; baseSyncVersion: number }
    | { type: "openUrl"; url: string }
    | { type: "openFile"; path: string }
    | { type: "debug"; message: string }
    | { type: "switchToTextEditor"; line?: number }
    | { type: "openSettings" }
    | { type: "uploadImage"; id: string; data: Uint8Array; mimeType: string; altText: string }
    | { type: "getProjectImages"; id: string }
    | { type: "renameImage"; id: string; webviewUri: string; newBasename: string }
    | { type: "getPathSuggestions"; id: string; query: string }
    | { type: "getLinkTargetSuggestions"; id: string; query: string }
    | { type: "resolveImagePath"; id: string; relPath: string }
    | { type: "frontmatterUpdate"; frontmatter: string; baseSyncVersion: number }
    | { type: "requestFmSuggestions"; key: string }
    | { type: "tocWidth"; width: number }
    | { type: "setStyleCheckEnabled"; enabled: boolean }
    | { type: "setSpellCheckEnabled"; enabled: boolean }
    | { type: "spellAddWord"; word: string }
    | { type: "lintBlocks"; id: number; blocks: LintBlock[] }
    // Selection serialized in the webview (copy-as-HTML / copy-as-Markdown from
    // the right-click menu); the extension writes `data` to the system clipboard.
    | { type: "clipboardWrite"; format: "html" | "markdown"; data: string };

/**
 * Extension → WebView messages.
 *
 * `lineMap` is optional on init/revert/externalUpdate: the extension always
 * sends it, but the webview guards with `?? []` just in case.
 *
 * `syncVersion` is the extension's authoritative version counter. It is bumped
 * on every externalUpdate push (external text-editor edit, undo/redo, git,
 * hot-exit restore) and echoed back by the webview as `baseSyncVersion` on
 * update/frontmatterUpdate, so the extension can drop content the webview
 * serialized against a state it has since replaced.
 *
 * `externalUpdate` is a cursor-preserving inbound sync: unlike `revert` (a full
 * editor rebuild that loses the selection), the webview applies it as a minimal
 * ProseMirror diff so the caret and selection survive edits made elsewhere in
 * the document. The webview falls back to a full rebuild on any diff failure.
 */
export type ToWebviewMessage =
    | { type: "init"; content: string; lineMap?: number[]; scrollToLine?: number; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode; syncVersion: number }
    | { type: "revert"; content: string; lineMap?: number[]; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode }
    | { type: "externalUpdate"; content: string; lineMap?: number[]; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode; syncVersion: number }
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
    | { type: "linkTargetSuggestions"; id: string; items: LinkTargetSuggestionItem[] }
    | { type: "imagePathResolved"; id: string; webviewUri: string }
    | { type: "setTheme"; colors: Record<string, string> }
    | { type: "setTableWrap"; wrap: TableWrapMode }
    | { type: "fmSuggestions"; key: string; values: string[] }
    | { type: "proofreadConfig"; config: ProofreadConfig }
    | { type: "lintResults"; id: number; results: LintBlockResult[] }
    // Command-palette / context-menu action forwarded to the active editor; the
    // webview dispatches `command` into the editor-command registry (MAR-9).
    | { type: "editorCommand"; command: EditorCommandId; args?: unknown };
