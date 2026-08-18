/**
 * shared/messages.ts
 * The single source of truth for the bidirectional WebView ↔ Extension message types.
 * Both sides import from here; inlining duplicate definitions on either side is forbidden.
 */

import type { EditorCommandId } from "./editorCommands";
import type { EditorSelectionContext } from "./agentContext";
import type { ContentWidthMode } from "./contentWidth";
import type { BlockHandlesMode } from "./blockHandles";
import type { FoldingControlsMode } from "./foldingControls";
import type { MermaidThemeMode } from "./mermaid";
import type { PlantUmlThemeMode } from "./plantuml";
import type { EmbedCardResult } from "./connectors";

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

/**
 * The document's file format, derived extension-side from the URI (`.mdx` →
 * "mdx", everything else markdown) and carried on `init` so the webview can
 * select the matching FormatModule (webview/format/loader.ts). A document's
 * format never changes while it is open, so only `init` carries it.
 */
export type DocumentFormat = "markdown" | "mdx";

/**
 * Logseq handling, matching the `birta.logseq` enum. `off` runs no detection
 * at all; `auto` decides per document; `on` forces the treatment for a page
 * opened outside its graph.
 */
export type LogseqMode = "off" | "auto" | "on";

/**
 * Why a document is being handled as Logseq. Carried on `logseqState` because
 * the badge's tooltip has to say which of the three it is: a user who sees the
 * badge on a file they did not expect needs to know whether the graph, the
 * file's own content, or their own setting put it there.
 */
export type LogseqReason = "graph" | "content" | "forced";

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
 * What a link card shows: the page's own Open Graph title and description,
 * each already sanitized to one plain line (src/utils/openGraph.ts) and each
 * absent when the page did not carry it. The site is derived from the URL
 * in the webview and is not part of the fetched payload.
 */
export type LinkCardMeta = { title: string | null; description: string | null };

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
    | "nonAsciiPunct"
    | "absolutePerf"
    | "rhythm";

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
    /** Absolute claim about a performance cost ("no longer stalls") with no before and after */
    absolutePerf: boolean;
    /** A paragraph whose sentences all run to about the same length (machine cadence) */
    rhythm: boolean;
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
    /**
     * The settings dropdown was opened, so the installed release counts as
     * looked at. Opening the menu is the gesture, not clicking the What's-new
     * row: the dot claims "there is something you have not seen", and the menu
     * is where it is seen.
     */
    | { type: "whatsNewSeen" }
    // `wiki` marks a wikilink target: the fragment (if any) is always a
    // heading, never a line number, and bare names resolve by filename
    // across the workspace instead of as document-relative paths.
    | { type: "openFile"; path: string; wiki?: true }
    // The source position the raw editor should open at (MAR-23). `line` is a
    // DOCUMENT line (frontmatter included); `column` is only present when the
    // webview could map it honestly — see webview/utils/sourceCaret.ts.
    // `line`/`column` is the caret (the selection's ACTIVE end); when a real
    // selection exists, `anchorLine`/`anchorColumn` carry its other end so the
    // raw editor restores the selection, drag direction included (MAR-23).
    | { type: "switchToTextEditor"; line?: number; column?: number; anchorLine?: number; anchorColumn?: number }
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
    // Link editor "browse" button: open the OS-native file picker and reply
    // (`linkTargetPicked`) with the chosen file as a document-relative path —
    // or null when the user cancels the dialog.
    | { type: "pickLinkTarget"; id: string }
    | { type: "resolveImagePath"; id: string; relPath: string }
    // Bare URL pasted onto an EMPTY selection: the webview has already inserted
    // `[url](url)` optimistically and asks the extension (the only side not
    // blocked by the webview CSP/CORS) to fetch the page's Open Graph / <title>
    // so the link text can be upgraded to the real title. `id` correlates the
    // `unfurlResult` reply; `url` is the fetched target (http(s) only).
    | { type: "unfurlUrl"; id: string; url: string }
    // Embed-card metadata (rung 1, render-only): ask the provider's own oEmbed
    // endpoint for the page title of a RECOGNIZED provider URL. The extension
    // re-recognizes `url` itself and rebuilds the request from validated parts
    // — the raw string only selects the provider — then ALWAYS replies with
    // `embedMetaResult` (null title on any failure/gate). Nothing fetched here
    // is ever written to the document; it decorates the card's caption.
    | { type: "resolveEmbedMeta"; id: string; url: string }
    // Link-card metadata (rung 1, render-only): ask the page a link names,
    // and no other host, for its Open Graph title and description, so a link
    // sitting alone on its own line can render as a quiet card. The webview
    // posts this only for a link the user chose to show as a card (the
    // linkCards default or a per-link choice); the extension re-gates on the
    // master switch and ALWAYS replies with `linkCardResult` (null on any
    // failure/gate). Nothing fetched here is ever written to the document.
    | { type: "resolveLinkCard"; id: string; url: string }
    // Embed-card CONNECTOR resolution (rung 2, render-only; MAR-198): ask the
    // provider's own API, with the credential the user connected, for the card
    // fields a URL alone cannot know. Same discipline as resolveEmbedMeta and
    // one step stricter: `url` only SELECTS a connector, the request is rebuilt
    // from validated parts, and the credential never crosses back — the reply
    // carries sanitized card fields or a named locked/expired/error state.
    // The webview only posts this for a connector it has been told is
    // connected, so a disconnected service costs no message and no fetch.
    | { type: "resolveEmbedCard"; id: string; url: string }
    // The locked card's just-in-time "Connect" affordance, and the palette
    // command's twin: run the connect flow for one service. No credential is
    // named here and none comes back; the extension replies by rebroadcasting
    // `connectorStateChanged`.
    | { type: "connectService"; connector: string }
    // The webview's per-document view-state bag (fold anchors, scroll,
    // frontmatter collapse), mirrored to the extension so it survives the
    // raw-editor round trip (see the init message's viewState note). Never
    // touches settings or disk — an in-memory, per-URI, session-scoped echo.
    | { type: "viewState"; state: Record<string, unknown> }
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
    // The "Highlight note markers" switch (toolbar Checks menu / review sidebar's Notes
    // tab / palette): persist birta.notes.highlightMarkers. The config-change
    // listener echoes it back as `notesConfig`, so every open editor re-gates.
    | { type: "setNoteHighlight"; enabled: boolean }
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
    // Review sidebar By-type/In-order mode → persisted to birta.review.groupByType;
    // the config-change listener echoes reviewConfig back to every open editor.
    | { type: "reviewGroupByType"; grouped: boolean }
    | { type: "setProofreadOption"; key: ProofreadOptionKey; value: boolean }
    | { type: "spellAddWord"; word: string }
    // "Keep this phrase" on a style hit (MAR-236): the flagged text joins the
    // user's protect-list, birta.styleCheck.exceptions, in GLOBAL settings, so
    // no check ever flags it again. The persisted list round-trips back through
    // the proofread config message and recompiles the matcher.
    | { type: "styleAddException"; phrase: string }
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
    // Persisted by the extension (settings write-back), which echoes it
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
    // Export as HTML: the webview rendered the live document into one
    // self-contained HTML string; the extension asks where to save it, writes
    // it, and offers to open it in the browser (MAR-32). `suggestedName` is
    // the default file name, derived from the document's own name.
    | { type: "exportHtml"; html: string; suggestedName: string }
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
    // An uncaught webview error (window.onerror), unhandled promise
    // rejection, or a NodeView failure the per-node crash boundary contained
    // (webview/crashReporter.ts, webview/nodeViewBoundary.ts; MAR-169).
    // Rate-limited webview-side; the extension logs it and shows a single
    // deduped notification. Decoration only — never part of the content sync
    // protocol.
    | { type: "crash"; message: string; stack?: string; source: "error" | "unhandledrejection" | "nodeview" }
    // TEST-ONLY reply to `__getPerfMarks`: the webview's `mdw:` User-Timing marks
    // (prefix stripped), so the @vscode/test-electron suite can read real launch
    // timings from a live VS Code webview and validate the headless harness
    // against reality (MAR-191). `id` correlates the request. Never used in production.
    | { type: "__perfMarks"; id: string; marks: Record<string, number> }
    // Reply to `requestEditorContext`: the live file selection, mapped to
    // document coordinates, so a coding-agent bridge can read what the user has
    // open/selected in the WYSIWYG editor (which vscode.window.activeTextEditor
    // cannot see). Pull-only — computed on request, never on the editor's own
    // selection path — so the feature costs the editor nothing until an agent
    // asks. `context` is null when no position can be mapped. See
    // shared/agentContext.ts and src/agentBridge/.
    | { type: "editorContextResult"; id: string; context: EditorSelectionContext | null }
    // The selection palette's @ button: run the same birta.copyAgentReference
    // command the context menu offers, so the one-click path and the menu path
    // share behavior (clipboard payload, status-bar feedback) exactly.
    | { type: "copyAgentReference" }
    // Ask Agent (MAR-371, MAR-272): the prompt typed after `/ai`, or absent
    // when invoked from the palette (the extension then asks for it). The
    // extension composes the caret's line reference in and routes the line
    // per `birta.agent.command`; the webview never invokes anything itself.
    | { type: "askAgent"; prompt?: string; requestId?: string }
    // Cancel a background agent run from its gutter marker (plugins/agentPending).
    | { type: "agentCancel"; requestId: string }
    // The document cannot open in the WYSIWYG editor because its format's
    // parse is fatal on this content (MDX: a stray `{`, an unclosed tag —
    // unlike markdown, where every byte sequence is valid). The extension
    // surfaces `error` and falls back to the text editor. The webview has not
    // modified anything: the editor never mounted.
    //
    // `line` and `column` are the parser's position and are in BODY
    // coordinates, like every other line on this wire: the webview renders the
    // body, and the extension adds its own frontmatter offset before showing a
    // number to the user. Absent when the parser reported no position.
    | { type: "fatalParse"; error: string; line?: number; column?: number };

/**
 * Extension → WebView messages.
 *
 * `lineMap` is optional on init/externalUpdate: the extension always
 * sends it, but the webview guards with `?? []` just in case.
 *
 * `lineMap` describes the BODY the webview renders — the document minus its
 * frontmatter, which lives in its own panel and never enters the ProseMirror
 * doc. `lineOffset` is how many source lines that frontmatter occupies, and it
 * is what converts between the two numbering schemes: every `line` on the wire
 * is a document line (what a text editor shows), while `lineMap` entry `i`
 * describes `doc.child(i)`. Without it, navigation into a document with
 * frontmatter lands a block off (MAR-23).
 *
 * `column` (scrollToLine/scrollToColumn) is optional throughout: a global
 * search hit knows only a line, while a mode switch also carries the caret.
 *
 * `syncVersion` is the extension's authoritative version counter. It is bumped
 * on every externalUpdate push (external text-editor edit, undo/redo, git,
 * hot-exit restore) and echoed back by the webview as `baseSyncVersion` on
 * update/frontmatterUpdate, so the extension can drop content the webview
 * serialized against a state it has since replaced.
 *
 * `externalUpdate` is a cursor-preserving inbound sync: unlike a full
 * editor rebuild that loses the selection), the webview applies it as a minimal
 * ProseMirror diff so the caret and selection survive edits made elsewhere in
 * the document. The webview falls back to a full rebuild on any diff failure.
 */
/**
 * A background agent run's life, keyed by the webview's own request id:
 * `running` (the marker shows), `done` (settle; `text` is the file's bytes
 * when the document was dirty at exit, so the reload VS Code refused is
 * merged around the user's edits), `failed` (the marker turns to an error
 * with the message), `cancelled`, or `handedOff` (a route the editor cannot
 * follow: terminal, Chat view, clipboard, or a request that never ran; the
 * marker is dropped silently).
 */
export type AgentRunMessage = {
    type: "agentRun";
    requestId: string;
    status: "running" | "done" | "failed" | "cancelled" | "handedOff";
    text?: string;
    message?: string;
};

export type ToWebviewMessage =
    | AgentRunMessage
    // `viewState` carries the per-document VIEW state (fold anchors, scroll,
    // frontmatter collapse — the webview state bag) across webview recreation:
    // switching to the raw editor CLOSES the custom tab, so VS Code's own
    // per-webview state does not survive the round trip. The extension keeps
    // the last bag per URI (in memory, session-scoped) and hands it back here;
    // the webview seeds its bag from it only when the bag is empty.
    | { type: "init"; content: string; format?: DocumentFormat; lineMap?: number[]; lineOffset?: number; scrollToLine?: number; scrollToColumn?: number; scrollToAnchorLine?: number; scrollToAnchorColumn?: number; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode; syncVersion: number; viewState?: Record<string, unknown> }
    | { type: "externalUpdate"; content: string; lineMap?: number[]; lineOffset?: number; frontmatter?: string; imageUriMap?: Record<string, string>; tableWrap?: TableWrapMode; syncVersion: number }
    // `line`/`column` is the caret; `anchorLine`/`anchorColumn`, when present,
    // carry the raw editor's selection anchor so the WYSIWYG editor restores
    // the whole selection rather than a bare caret (MAR-23).
    | { type: "scrollToLine"; line: number; column?: number; anchorLine?: number; anchorColumn?: number }
    | { type: "lineMapUpdate"; lineMap: number[]; lineOffset?: number }
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
    // Reply to pickLinkTarget: the picked file, document-relative (posix
    // separators), or null when the native dialog was canceled.
    | { type: "linkTargetPicked"; id: string; path: string | null }
    | { type: "imagePathResolved"; id: string; webviewUri: string }
    // Reply to `unfurlUrl`: the deterministically-parsed page title, or null on
    // any failure (offline, non-200, timeout, no title in the HTML). `id`
    // correlates the request; `url` echoes the target so the webview can locate
    // the un-upgraded bare link. A null `title` means the webview keeps the
    // bare `[url](url)` it already inserted — the graceful, offline-safe default.
    | { type: "unfurlResult"; id: string; url: string; title: string | null }
    // Reply to `resolveEmbedMeta`: the sanitized oEmbed title, or null on any
    // failure (gates off, unrecognized URL, offline, non-JSON, timeout). `url`
    // echoes the request target; `id` correlates. Render-only — the webview
    // caches it for card captions and never touches the document with it.
    | { type: "embedMetaResult"; id: string; url: string; title: string | null }
    // Reply to `resolveLinkCard`: the page's sanitized title and description
    // (either may be null; `card` itself is null when nothing usable came
    // back, or a gate was off). Render-only, cached in the webview for the
    // session, and never written into the document.
    | { type: "linkCardResult"; id: string; url: string; card: LinkCardMeta | null }
    // Reply to `resolveEmbedCard`: sanitized card fields, or the named state
    // that says why there are none. `result` is null when the URL has no
    // authenticated rung at all (unrecognized, no connector, a shape the API
    // cannot improve on, or a closed gate), which means "leave the rung-0 card
    // alone". Render-only: nothing here reaches the document.
    | { type: "embedCardResult"; id: string; url: string; result: EmbedCardResult | null }
    // Which services the user has connected, as a connector id to boolean map.
    // Sent once when a webview reports ready and again after every connect or
    // disconnect, so a card that was locked a moment ago unlocks in place. It
    // is the webview's whole picture of connection state: no credential, and
    // no way to derive one.
    | { type: "connectorStateChanged"; connectors: Record<string, boolean> }
    // Whether this document is handled as Logseq, and why (`reason` is null
    // when it is not). Sent after `init` for the same reason
    // connectorStateChanged is: detection stats the document's ancestor
    // directories, which is async, while `init` is on the path to first paint.
    // The webview's default is "not Logseq", so the wait costs a badge that
    // appears a beat late, never a wrong claim about the file. Re-sent to every
    // open editor when `birta.logseq` changes.
    //
    // A consumer that needs the flag while PARSING the init content (MAR-131's
    // round-trip handling) cannot read it here — it arrives after. Moving
    // detection ahead of `init` is that ticket's call to make, and it buys the
    // earlier flag at the cost of an await on the open path.
    | { type: "logseqState"; reason: LogseqReason | null }
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
    | { type: "featureGateChanged"; gate: "calcEnabled" | "calcAutoInsert" | "checklistSinkChecked" | "pasteUnfurl" | "pasteUnfurlAutoApply" | "embedsEnabled" | "linkCardsEnabled" | "frontmatterAddButton"; enabled: boolean }
    // Live update for the per-provider embed roster. A map rather than a
    // featureGateChanged boolean because the whole roster arrives at once:
    // VS Code reports "birta.embeds.providers" changed without saying which
    // provider, so the current map is what there is to send.
    | { type: "embedProvidersChanged"; providers: Record<string, boolean> }
    // Live update for birta.copyFormat (a string gate, read at copy time).
    | { type: "copyFormatChanged"; format: "markdown" | "richText" }
    // Live update for birta.pasteFormat (a string gate, read at paste time).
    | { type: "pasteFormatChanged"; format: "markdown" | "plainText" }
    | { type: "fmSuggestions"; key: string; values: string[] }
    | { type: "proofreadConfig"; config: ProofreadConfig }
    // Live update of the Notes-tab custom markers (birta.notes.customMarkers changed).
    | { type: "notesConfig"; customMarkers: string[]; highlightMarkers: boolean }
    // Live update of the review sidebar's By-type/In-order mode (birta.review.groupByType).
    | { type: "reviewConfig"; groupByType: boolean }
    // Live toolbar layout update (per-item placement settings changed).
    | { type: "toolbarConfig"; config: ToolbarConfig }
    /**
     * Light or clear the settings gear's unread dot. Advisory only: it appears,
     * waits, and does nothing on its own. Sent after activation computes it and
     * again whenever the setting changes, never as part of `init`, so the
     * CHANGELOG read stays off the mount path.
     */
    | { type: "whatsNewUnread"; unread: boolean }
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
    | { type: "setBlockHandles"; mode: BlockHandlesMode }
    // Live TOC updates echoed to every open editor after the matching setting
    // changes (dock side, show/hide, dragged width) — keeps retained webviews in
    // sync with `birta.tocPosition` / `birta.tocVisibility` / `birta.tocWidth`.
    | { type: "setTocPosition"; position: TocPosition }
    | { type: "setTocVisibility"; visibility: TocVisibility }
    | { type: "setTocWidth"; width: number }
    // Live resting block-handle visibility update, after `blockHandles` changes.
    // Live source line-number gutter toggle, after `birta.lineNumbers` changes.
    // Enabling loads the gutter's module on demand; disabling removes it from
    // the DOM entirely, so a webview that never enables it never pays for it.
    | { type: "setLineNumbers"; enabled: boolean }
    // Live read-only update, after `birta.readOnly` changes (MAR-53). The
    // setting is the DEFAULT, so this re-seeds the mode wholesale: a user who
    // changes the global preference means it, and the session override they
    // may have made with the toolbar toggle was about the old default.
    | { type: "setReadOnly"; readOnly: boolean }
    // Live Mermaid theme-mode update, after `birta.mermaid.theme` changes.
    | { type: "setMermaidTheme"; mode: MermaidThemeMode }
    // Live PlantUML theme-mode update, after `birta.plantuml.theme` changes.
    | { type: "setPlantUmlTheme"; mode: PlantUmlThemeMode }
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
    // The extension's verdict on a `flushResult`: `applied: true` means the
    // completed save CONFIRMED the document holds those bytes (settled at
    // onDidSaveTextDocument against the saved text, never at edit-computation
    // time — VS Code can drop a participant's edits after they are returned);
    // `false` means the reply was discarded (stale version, superseded seq,
    // late after the flush timeout, the edit computation failed, or the save
    // finished without the bytes). The webview may advance its save baseline
    // only on `true` — an unacknowledged flush is not a committed write
    // (MAR-349). A reply the extension saw gets at least one ack once a save
    // for the document completes; a write that fails outright leaves the
    // reply unacked and its candidate parked until something supersedes it,
    // which is the safe direction. Duplicate discarded-acks are possible on
    // teardown races and land idempotently on an already-cleared candidate.
    | { type: "flushAck"; id: string; applied: boolean }
    // Command-palette / context-menu action forwarded to the active editor; the
    // webview dispatches `command` into the editor-command registry (MAR-9).
    | { type: "editorCommand"; command: EditorCommandId; args?: unknown }
    // A coding-agent bridge asked for the live file selection (src/agentBridge/).
    // The webview computes it from the current editor state and replies with
    // `editorContextResult` correlated by `id`. Read-only — never mutates the
    // document and never runs unless an agent requests it.
    | { type: "requestEditorContext"; id: string }
    // Disk-drift state for this document: "conflict" while the file on disk has
    // changed since the editor last agreed with it AND the editor has unsaved
    // edits (the toolbar shows a quiet advisory badge — a manual save would hit
    // VS Code's native "newer on disk" dialog); "none" once the user
    // reloads/saves or the editor and disk converge. The extension never edits
    // the document in response; it only notifies.
    | { type: "syncConflict"; state: "conflict" | "none" };
