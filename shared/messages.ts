/**
 * shared/messages.ts
 * The single source of truth for the bidirectional WebView ↔ Extension message types.
 * Both sides import from here; inlining duplicate definitions on either side is forbidden.
 */

import type { EditorCommandId } from "./editorCommands";
import type { ContentWidthMode } from "./contentWidth";
import type { BlockHandlesMode } from "./blockHandles";
import type { FoldingControlsMode } from "./foldingControls";
import type { MermaidThemeMode } from "./mermaid";

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

/** TOC dock side, matching the `birta.tocPosition` enum. */
export type TocPosition = "left" | "right";
// ToC show/hide preference. Type + normalizer live in ./tocVisibility (mirrors
// the mermaid/blockHandles enum modules); re-exported here for message typing.
export type { TocVisibility } from "./tocVisibility";
import type { TocVisibility } from "./tocVisibility";

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

/**
 * Word / character / reading-time counts for a run of text (MAR-29). Counting
 * is CJK-aware: Latin runs contribute whole words, while each CJK character
 * counts as one "word" — see webview/utils/wordCount.ts. Posted for the whole
 * document, and (when a selection exists) for the selected range as well.
 */
export interface TextCount {
    /** Latin words + CJK characters. */
    words: number;
    /** Non-whitespace characters (Unicode code points). */
    characters: number;
    /** Estimated reading time in whole minutes, rounded up (0 for empty text). */
    readingTimeMinutes: number;
}

/** A toolbar zone, or "hidden" to omit the item entirely. */
export type ToolbarZone = "left" | "right";
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
    /** Whole-bar visibility (`birta.toolbar.visible`); defaults to shown. */
    visible?: boolean;
};

/** Editor content font preset selected from the toolbar font picker. */
// "editor" inherits the VS Code editor font (editor.fontFamily) — no stack of
// its own; the other three render the corresponding user-editable stack.
export type FontPreset = "editor" | "sans" | "serif" | "mono";

/** Effective font-family stack per non-default preset (user override or built-in). */
export type FontStacks = { sans: string; serif: string; mono: string };

/**
 * Per-check style-check options (all nested under the `styleCheck` master).
 * Each maps to a `birta.styleCheck.<key>` boolean setting and to one
 * row in the toolbar's style-check dropdown.
 */
export type ProofreadOptionKey =
    // Master gate over the whole feature (spelling + grammar + style)
    | "proofreading"
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
    /**
     * Master gate over the entire proofreading feature. When false, nothing runs
     * or decorates (spelling, grammar, and style all off) regardless of the
     * per-domain switches below — and those switches keep their own values, so
     * flipping the gate back on restores exactly what was enabled before. The
     * effective state of any check is `proofreadingEnabled && <that switch>`.
     */
    proofreadingEnabled: boolean;
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
    // `seq` is a monotonic outbound-content counter (shared with flushResult). It
    // totally orders view→document content messages so the extension can drop a
    // stale `update` that would otherwise revert a fresher save-flush.
    | { type: "update"; content: string; baseSyncVersion: number; seq: number }
    | { type: "openUrl"; url: string }
    // `wiki` marks a wikilink target: the fragment (if any) is always a
    // heading, never a line number, and bare names resolve by filename
    // across the workspace instead of as document-relative paths.
    | { type: "openFile"; path: string; wiki?: true }
    | { type: "switchToTextEditor"; line?: number }
    // `query` optionally narrows the native Settings UI filter (e.g. to the
    // font settings); it must stay within this extension's namespace.
    | { type: "openSettings"; query?: string }
    | { type: "openKeybindings" }
    | { type: "uploadImage"; id: string; data: Uint8Array; mimeType: string; altText: string }
    | { type: "getProjectImages"; id: string }
    | { type: "getPathSuggestions"; id: string; query: string }
    | { type: "getLinkTargetSuggestions"; id: string; query: string }
    // Popup hint: where would this link path open right now? (same resolver
    // as openFile, no side effects)
    | { type: "resolveLinkTarget"; id: string; path: string; wiki?: true }
    | { type: "resolveImagePath"; id: string; relPath: string }
    // Bare URL pasted onto an EMPTY selection: the webview has already inserted
    // `[url](url)` optimistically and asks the extension (the only side not
    // blocked by the webview CSP/CORS) to fetch the page's Open Graph / <title>
    // so the link text can be upgraded to the real title. `id` correlates the
    // `unfurlResult` reply; `url` is the fetched target (http(s) only).
    | { type: "unfurlUrl"; id: string; url: string }
    // Just-in-time opt-in (MAR-179): the user accepted the "Enable" affordance
    // that appears when they do something requiring the network while the master
    // switch is off. The extension persists `birta.network.enabled = enabled`
    // through the config write-back seam (scope-respecting update). The webview
    // also flips its in-session gate locally so the feature works immediately.
    | { type: "setNetworkEnabled"; enabled: boolean }
    // The calc suggestion menu's "Always insert result" row: persist
    // birta.calc.autoInsert through the scope-respecting write-back.
    | { type: "setCalcAutoInsert"; enabled: boolean }
    // The unfurl offer's "Always use fetched titles" row: persist the choice so
    // future pastes apply the title on arrival instead of offering it.
    | { type: "setPasteUnfurlAutoApply"; enabled: boolean }
    // The "Move checked tasks to bottom" toggle (toolbar Lists menu / task-list
    // block menu): persist birta.checklist.sinkChecked.
    | { type: "setChecklistSink"; enabled: boolean }
    | { type: "frontmatterUpdate"; frontmatter: string; baseSyncVersion: number }
    | { type: "requestFmSuggestions"; key: string }
    // ToC resize/toggle → persisted to the birta.tocWidth / birta.tocVisibility
    // settings (like every other preference). The extension's config-change
    // listener echoes the new value back to every open editor (setTocWidth /
    // setTocVisibility), so retained webviews stay in sync — the same live path
    // tocPosition uses. (A toggle only ever reports "shown"/"hidden"; "auto" is
    // the default, set via settings.)
    | { type: "tocWidth"; width: number }
    | { type: "tocVisibility"; visibility: TocVisibility }
    | { type: "setProofreadOption"; key: ProofreadOptionKey; value: boolean }
    | { type: "spellAddWord"; word: string }
    // Font picker choice from the toolbar; the extension persists it to the
    // `fontPreset` setting, which round-trips back as a `setFontFamily` message.
    | { type: "setFontPreset"; preset: FontPreset }
    // Font-size stepper choice from the toolbar; the extension persists it to
    // the `fontSize` setting, which round-trips back as a `setFontSize` message.
    // `size` is a percentage of the VS Code editor font size.
    | { type: "setFontSize"; size: number }
    // Content-width segmented control (Auto / Narrow / Wide) from the typography
    // menu; the extension persists it to the `contentWidth` setting, which
    // round-trips back as a `setContentWidth` message.
    | { type: "setContentWidth"; mode: ContentWidthMode }
    // Resting block-handle pick from the typography menu's radio rows; the
    // extension persists it to the `blockHandles` setting, which round-trips
    // back as a `setBlockHandles` message to every open editor.
    | { type: "setBlockHandles"; mode: BlockHandlesMode }
    // Drag-and-drop layout change from customize mode. `item` is set only when
    // the dragged item changed placement (zone, or shown/hidden via the tray);
    // `order` is the left-to-right order of the visible items.
    | { type: "setToolbarLayout"; item?: { id: string; placement: ToolbarPlacement }; order: string[] }
    // Whole-bar show/hide from the gear menu, right-click menu, or expand tab;
    // the extension persists it to `toolbar.visible`, which round-trips back
    // as a `toolbarConfig` message.
    | { type: "setToolbarVisible"; visible: boolean }
    // TOC dock-side flip from the panel header button; the extension persists it
    // to `tocPosition`, which round-trips back as a `setTocPosition` message.
    | { type: "setTocPosition"; position: TocPosition }
    | { type: "lintBlocks"; id: number; blocks: LintBlock[] }
    // Reply to a `flushSave` request: the webview serialized the live document
    // immediately (bypassing its sync throttle) so a save can write the freshest
    // content. `id` correlates with the request; `content` is display-space
    // markdown; `baseSyncVersion` lets the extension drop a flush that raced an
    // external change (same stale-guard as `update`); `seq` is the shared
    // monotonic outbound-content counter (see `update`).
    | { type: "flushResult"; id: string; content: string; baseSyncVersion: number; seq: number }
    // Selection serialized in the webview (copy-as-HTML / copy-as-Markdown from
    // the right-click menu); the extension writes `data` to the system clipboard.
    | { type: "clipboardWrite"; format: "html" | "markdown"; data: string }
    // The toolbar's disk-drift badge was clicked; the extension shows the
    // native picker (reload from disk / compare with disk). The extension never
    // edits the document itself — the user chooses.
    | { type: "resolveSyncConflict" }
    // Word / character / reading-time counts computed in the webview from the
    // live editor state (MAR-29). `selection` is non-null only when a non-empty
    // selection exists. Debounced off the keystroke path; the extension renders
    // it into the status bar item for the active editor.
    | { type: "wordCount"; doc: TextCount; selection: TextCount | null }
    // Whether the webview (the iframe as a whole, not just the ProseMirror
    // editor) currently holds OS focus. The extension mirrors this into the
    // `birta.webviewFocused` when-clause context key so document-mutating
    // keybindings fire only while the editor is truly focused — not merely
    // because its tab is the active custom editor with focus parked in the
    // Explorer (MAR-104).
    | { type: "focusState"; focused: boolean }
    // An uncaught webview error (window.onerror) or unhandled promise
    // rejection, reported by the crash boundary in webview/crashReporter.ts
    // (MAR-169). Rate-limited webview-side; the extension logs it and shows a
    // single deduped notification. Decoration only — never part of the content
    // sync protocol.
    | { type: "crash"; message: string; stack?: string; source: "error" | "unhandledrejection" }
    // TEST-ONLY reply to `__getPerfMarks`: the webview's `mdw:` User-Timing marks
    // (prefix stripped), so the @vscode/test-electron suite can read real launch
    // timings from a live VS Code webview and validate the headless harness
    // against reality (MAR-191). `id` correlates the request. Never used in production.
    | { type: "__perfMarks"; id: string; marks: Record<string, number> };

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
    | { type: "requestSwitchToTextEditor" }
    | { type: "pathSuggestions"; id: string; items: PathSuggestionItem[] }
    | { type: "linkTargetSuggestions"; id: string; items: LinkTargetSuggestionItem[] }
    // Reply to resolveLinkTarget: workspace-relative display path (posix),
    // absolute when outside the workspace, null for a smart-mode miss.
    | { type: "linkTargetResolved"; id: string; resolved: string | null }
    | { type: "imagePathResolved"; id: string; webviewUri: string }
    // Reply to `unfurlUrl`: the deterministically-parsed page title, or null on
    // any failure (offline, non-200, timeout, no title in the HTML). `id`
    // correlates the request; `url` echoes the target so the webview can locate
    // the un-upgraded bare link. A null `title` means the webview keeps the
    // bare `[url](url)` it already inserted — the graceful, offline-safe default.
    | { type: "unfurlResult"; id: string; url: string; title: string | null }
    | { type: "setTableWrap"; wrap: TableWrapMode }
    // Live master-network-switch update (settings UI edit or the just-in-time
    // opt-in accepted in ANOTHER webview): flips `window.__i18n.network` so
    // every network feature gates correctly everywhere without a reload. The
    // embed plugin is composed unconditionally and re-gated on this message, so
    // cards appear and disappear in place — no reopen.
    | { type: "networkStateChanged"; enabled: boolean }
    // Live update for the boolean feature gates that read from __i18n at use
    // time (not at plugin composition): a settings-UI edit, palette toggle
    // command, or another webview's menu switch reaches every open editor.
    | { type: "featureGateChanged"; gate: "calcAutoInsert" | "checklistSinkChecked" | "pasteUnfurl" | "pasteUnfurlAutoApply" | "embedsEnabled"; enabled: boolean }
    | { type: "fmSuggestions"; key: string; values: string[] }
    | { type: "proofreadConfig"; config: ProofreadConfig }
    // Live toolbar layout update (per-item placement settings changed).
    | { type: "toolbarConfig"; config: ToolbarConfig }
    // Live editor content font update. `fontFamily` is the resolved CSS stack,
    // or null to inherit the VS Code editor font; `preset` drives the picker's
    // active state; `stacks` are the effective per-preset stacks (user
    // overrides applied) so the picker's row previews match.
    | { type: "setFontFamily"; fontFamily: string | null; preset: FontPreset; stacks: FontStacks }
    // Live content font-size update, as a percentage of the editor font size.
    | { type: "setFontSize"; size: number }
    // Live content-width update. `cssValue`/`isAuto` drive the CSS (the
    // `--editor-max-width` var and the full-width body class); `mode` drives the
    // typography menu's segmented control. Echoed after `contentWidth` changes.
    | { type: "setContentWidth"; cssValue: string; isAuto: boolean; mode: ContentWidthMode }
    // Live TOC updates echoed to every open editor after the matching setting
    // changes (dock side, show/hide, dragged width) — keeps retained webviews in
    // sync with `birta.tocPosition` / `birta.tocVisibility` / `birta.tocWidth`.
    | { type: "setTocPosition"; position: TocPosition }
    | { type: "setTocVisibility"; visibility: TocVisibility }
    | { type: "setTocWidth"; width: number }
    // Live resting block-handle visibility update, after `blockHandles` changes.
    | { type: "setBlockHandles"; mode: BlockHandlesMode }
    // Live Mermaid theme-mode update, after `birta.mermaid.theme` changes.
    | { type: "setMermaidTheme"; mode: MermaidThemeMode }
    // Live fold-affordance update after `editor.showFoldingControls` /
    // `editor.folding` changes. Resource-scoped: the extension re-resolves
    // per open document and posts per-webview (never one global broadcast).
    | { type: "setFoldingControls"; controls: FoldingControlsMode; enabled: boolean }
    | { type: "lintResults"; id: number; results: LintBlockResult[] }
    // TEST-ONLY: inserts text into the live editor at the caret. Sent only by the
    // invisible (uncontributed) `birta._test.insertText` command from the
    // integration suite, to drive the real Milkdown editor ahead of the backing
    // document and exercise the save flush end-to-end. Never used in production.
    | { type: "__testInsertText"; text: string }
    // TEST-ONLY: asks the webview to reply with its `mdw:` User-Timing marks
    // (`__perfMarks`). Sent only by the invisible `birta._test.getPerfMarks`
    // command so the integration suite can measure real launch time in a live VS
    // Code webview (MAR-191). Read-only — reads marks already stamped by
    // webview/perf.ts. Never used in production.
    | { type: "__getPerfMarks"; id: string }
    // A save is imminent (onWillSaveTextDocument): the webview must serialize the
    // live document NOW and reply with `flushResult` so the save writes the
    // freshest content instead of whatever the throttle last shipped. `id`
    // correlates the reply.
    | { type: "flushSave"; id: string }
    // Command-palette / context-menu action forwarded to the active editor; the
    // webview dispatches `command` into the editor-command registry (MAR-9).
    | { type: "editorCommand"; command: EditorCommandId; args?: unknown }
    // Disk-drift state for this document: "conflict" while the file on disk has
    // changed since the editor last agreed with it AND the editor has unsaved
    // edits (the toolbar shows a quiet advisory badge — a manual save would hit
    // VS Code's native "newer on disk" dialog); "none" once the user
    // reloads/saves or the editor and disk converge. The extension never edits
    // the document in response; it only notifies.
    | { type: "syncConflict"; state: "conflict" | "none" };
