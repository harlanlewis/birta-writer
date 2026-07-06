/**
 * shared/messages.ts
 * The single source of truth for the bidirectional WebView ↔ Extension message types.
 * Both sides import from here; inlining duplicate definitions on either side is forbidden.
 */

import type { EditorCommandId } from "./editorCommands";

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

/** Link target suggestion: one workspace file in both of its addressable forms */
export type LinkTargetSuggestionItem = {
    /** Path relative to the current document (e.g. "../notion/index.md") */
    relative: string;
    /** Workspace-root-based path with a leading slash (e.g. "/write/notion/index.md") */
    rootRelative: string;
};

/** Table line-wrapping mode */
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

/** A toolbar zone, or "hidden" to omit the item entirely. */
export type ToolbarZone = "left" | "center" | "right";
export type ToolbarPlacement = ToolbarZone | "hidden";

/** Per-item placement map keyed by toolbar item id (see the webview registry). */
export type ToolbarPlacements = Record<string, ToolbarPlacement>;

/**
 * Full toolbar layout config.
 * `placements` maps each item id to its zone (or "hidden").
 * `order` is an optional left-to-right ordering hint of item ids: within a
 * zone, listed items come first in this order, the rest follow in the built-in
 * (registry) order.
 */
export type ToolbarConfig = {
    placements: ToolbarPlacements;
    order: string[];
};

/** Editor content font preset selected from the toolbar font picker. */
export type FontPreset = "default" | "sans" | "serif" | "mono";

/**
 * Per-check style-check options (all nested under the `styleCheck` master).
 * Each maps to a `markdownWriter.styleCheck.<key>` boolean setting and to one
 * row in the toolbar's style-check dropdown.
 */
export type ProofreadOptionKey =
    // Masters
    | "styleCheck"
    | "spellCheck"
    | "grammarCheck"
    // Phrase lists
    | "fillers"
    | "redundancies"
    | "cliches"
    | "wordiness"
    | "aiVocabulary"
    | "aiArtifacts"
    // Structural checks
    | "passive"
    | "longSentences"
    | "negativeParallelism"
    | "ruleOfThree"
    | "emDash"
    | "nonAsciiPunct";

/** Proofread (style check + spell check) configuration snapshot */
export type ProofreadConfig = {
    /** Style check master switch (gates every option below + repeated words) */
    styleCheck: boolean;
    // ── Phrase categories ──
    fillers: boolean;
    redundancies: boolean;
    cliches: boolean;
    /** Wordy/expletive constructions ("there is", "the fact that") */
    wordiness: boolean;
    /** LLM-ism: over-reached vocabulary ("delve", "tapestry", "leverage") */
    aiVocabulary: boolean;
    /** LLM-ism: leaked boilerplate ("as an AI", "it's important to note") */
    aiArtifacts: boolean;
    // ── Structural checks ──
    /** Passive voice ("was written") */
    passive: boolean;
    /** Sentences over the word threshold */
    longSentences: boolean;
    /** LLM-ism: "not just X, but Y" / "it's not X, it's Y" */
    negativeParallelism: boolean;
    /** LLM-ism: three stacked adjectives for artificial emphasis */
    ruleOfThree: boolean;
    /** Em/en dash glyphs (the author's voice uses a spaced ASCII hyphen) */
    emDash: boolean;
    /** Curly quotes, ellipsis glyph, and invisible spaces (normalize to ASCII) */
    nonAsciiPunct: boolean;
    /** Phrases the style check must never flag (user's escape valve) */
    styleExceptions: string[];
    /** Spelling switch (Harper "Spelling" findings; bundled English dictionary) */
    spellCheck: boolean;
    /** Grammar switch (Harper non-spelling findings) */
    grammarCheck: boolean;
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
    | { type: "setProofreadOption"; key: ProofreadOptionKey; value: boolean }
    | { type: "spellAddWord"; word: string }
    // Font picker choice from the toolbar; the extension persists it to the
    // `fontPreset` setting, which round-trips back as a `setFontFamily` message.
    | { type: "setFontPreset"; preset: FontPreset }
    // Drag-and-drop layout change from customize mode. `item` is set only when
    // the dragged item changed placement (zone, or shown/hidden via the tray);
    // `order` is the left-to-right order of the visible items.
    | { type: "setToolbarLayout"; item?: { id: string; placement: ToolbarPlacement }; order: string[] }
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
    // Live toolbar layout update (per-item placement settings changed).
    | { type: "toolbarConfig"; config: ToolbarConfig }
    // Live editor content font update. `fontFamily` is the resolved CSS stack,
    // or null to inherit the VS Code editor font; `preset` drives the picker's
    // active state.
    | { type: "setFontFamily"; fontFamily: string | null; preset: FontPreset }
    | { type: "lintResults"; id: number; results: LintBlockResult[] }
    // Command-palette / context-menu action forwarded to the active editor; the
    // webview dispatches `command` into the editor-command registry (MAR-9).
    | { type: "editorCommand"; command: EditorCommandId; args?: unknown };
