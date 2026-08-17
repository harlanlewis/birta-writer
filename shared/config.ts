/**
 * shared/config.ts
 *
 * The single source of truth for the `birta.*` settings surface: the snapshot
 * shape (`BirtaConfig`), each field's setting key, and each field's default.
 *
 * Defaults are declared in TWO places — package.json's contributed setting
 * defaults (what the Settings UI shows, and what a real VS Code returns when
 * the user hasn't set a value) and this table (what the code falls back to
 * when a read fails, and what unit tests see under the vscode mock). They must
 * agree, or the Settings UI lies; shared/__tests__/configDefaultsContributions
 * .test.ts pins every key. Existing per-domain DEFAULT_* constants stay the
 * canonical value and are referenced here, never duplicated.
 *
 * The extension reads this shape via src/config.ts (`readBirtaConfig` /
 * `readBirtaSetting`) — the only module that touches
 * `vscode.workspace.getConfiguration("birta")`. The webview consumes the same
 * values via the init bootstrap and live update messages.
 */

import type { ProofreadConfig, LogseqMode, TableWrapMode, TocPosition, ToolbarPlacements, FontPreset } from "./messages";
import { type TocVisibility, DEFAULT_TOC_VISIBILITY } from "./tocVisibility";
import { DEFAULT_FONT_PRESET, DEFAULT_FONT_SIZE_PERCENT, FONT_PRESET_STACKS } from "./fontPresets";
import { DEFAULT_CONTENT_WIDTH_MODE, DEFAULT_MAX_WIDTH_CH } from "./contentWidth";
import { DEFAULT_BLOCK_HANDLES_MODE } from "./blockHandles";
import { DEFAULT_MERMAID_THEME_MODE } from "./mermaid";
import { DEFAULT_PLANTUML_THEME_MODE } from "./plantuml";

/**
 * Snapshot of every `birta.*` setting the extension reads. Fields whose values
 * are user-normalized at the use site (blockHandles, mermaidTheme,
 * contentWidth, fontSize clamping) carry the RAW setting value here; the
 * normalizers stay where the value is consumed.
 */
export interface BirtaConfig extends ProofreadConfig {
    /** Which editor opens a markdown file by default. */
    defaultMode: "preview" | "markdown";
    /**
     * Open documents with edits locked (birta.readOnly), so the rendered editor
     * can be used as a reader without a stray keystroke changing the file.
     * Every reading affordance still works; only the ways to change the
     * document are refused. The toolbar's Edit/Read-only toggle overrides this
     * for the session, and the underlying file stays editable elsewhere — this
     * prevents accidents, it is not a permission.
     *
     * Ships OFF (editable). A reading-first default is a change the owner makes
     * later on evidence, never a launch guess: this is a WYSIWYG editor, and a
     * user who opens one and cannot type has no way to know why.
     *
     * Distinct from `defaultMode`, which chooses WHICH editor opens a file.
     */
    readOnly: boolean;
    debugMode: boolean;
    /**
     * Show a quiet unread dot on the settings gear when releases the user has
     * not looked at contain something significant (birta.whatsNew.indicator).
     * Default ON, because the dot is gated hard enough to stay rare; see
     * shared/whatsNew.ts for what clears the bar and why. Turning it off is
     * honored forever: no prompt, no nag, nothing re-enables it.
     */
    whatsNewIndicator: boolean;
    tableWrap: TableWrapMode;
    codeBlockMaxHeight: number;
    codeBlockAutoConvert: boolean;
    codeBlockWordWrap: "inherit" | "on" | "off";
    /** Raw `blockHandles` value; normalize with normalizeBlockHandlesMode. */
    blockHandles: string;
    /**
     * Show source line numbers along the viewport's start edge
     * (birta.lineNumbers). Default OFF: the rendered document is the point of
     * this editor, and a permanent number column is a text-editor affordance
     * most readers do not want. It exists for the times a rendered document has
     * to be reconciled against something that speaks in line numbers — a diff,
     * a compiler error, a review comment, an agent.
     *
     * Numbers are display only (no click target) and their spacing is
     * deliberately irregular: each one sits at the y of the content it labels,
     * so a source line that renders tall gets room and one that renders nothing
     * is placed by interpolation. A code block's interior is left to the code
     * block's own gutter. See webview/components/lineNumbers/.
     */
    lineNumbers: boolean;
    /** Raw `mermaid.theme` value; normalize with normalizeMermaidThemeMode. */
    mermaidTheme: string;
    /** Raw `plantuml.theme` value; normalize with normalizePlantUmlThemeMode. */
    plantumlTheme: string;
    /** Raw `contentWidth` value; normalize with normalizeContentWidthMode. */
    contentWidth: string;
    maxContentWidth: number;
    tocContentGap: number;
    tocPosition: TocPosition;
    tocAutoHideThreshold: number;
    /** Dragged panel width in px; clamp with clampNumberSetting (240–600). */
    tocWidth: number;
    /** Raw show/hide preference ("auto" defers to tocAutoHideThreshold);
     *  normalize with normalizeTocVisibility (a settings.json typo → "auto"). */
    tocVisibility: TocVisibility;
    frontmatterExpanded: boolean;
    /** Show the Add-metadata button on documents without frontmatter
     *  (birta.frontmatterAddButton). Off — the default — hides the empty state
     *  entirely; the Edit Frontmatter command still reaches the same flow. */
    frontmatterAddButton: boolean;
    /**
     * What a native copy (Cmd+C / the Copy menu) puts on the clipboard's
     * plain-text flavor (birta.copyFormat): "markdown" (default) serializes the
     * selection back to Markdown source, "richText" keeps the editor's plain
     * rendition. The rich HTML flavor is written either way, so pasting into
     * rich-text apps (and back into the editor) keeps formatting in both modes.
     * Settings-file values are free text — normalize with normalizeCopyFormat
     * before they cross into the webview.
     */
    copyFormat: "markdown" | "richText";
    /**
     * How a native paste (Cmd+V / the Paste menu) reads the clipboard's
     * plain-text flavor (birta.pasteFormat): "markdown" (default) parses it as
     * Markdown source, so pasted syntax becomes real headings/lists/emphasis;
     * "plainText" inserts it literally, letting the serializer escape the
     * syntax back out. Rich (HTML) clipboards and code blocks take the same
     * path in both modes, and Shift+Cmd+V is a per-paste literal override.
     * Settings-file values are free text — normalize with normalizePasteFormat
     * before they cross into the webview.
     */
    pasteFormat: "markdown" | "plainText";
    customCss: string[];
    customJs: string[];
    fontPreset: FontPreset;
    fontFamilySans: string;
    fontFamilySerif: string;
    fontFamilyMono: string;
    /** Raw `fontSize` percentage; clamp with clampFontSizePercent. */
    fontSize: number;
    toolbarVisible: boolean;
    toolbarOrder: string[];
    /**
     * Nested `toolbar.items` read. The contributed per-item defaults are merged
     * in by VS Code itself, so the code default is the empty map (per-item
     * drift is pinned by toolbarDefaultsContributions.test.ts).
     */
    toolbarPlacements: ToolbarPlacements;
    floatingToolbarEnabled: boolean;
    /** Nested `floatingToolbar.items` read; same merge rule as toolbarPlacements. */
    floatingToolbarItems: Record<string, boolean>;
    smartLinks: boolean;
    /**
     * Logseq handling (birta.logseq), off by default. `auto` detects whether
     * the document belongs to a Logseq graph (src/utils/logseqDetect.ts);
     * `on` forces the treatment for a page opened outside its graph. With
     * `off` no detection runs at all.
     */
    logseq: LogseqMode;
    /**
     * Master network switch (birta.network.enabled) — offline by default
     * (MAR-179). Birta's positioning is "nothing leaves your machine", so this
     * is the single knob that is OFF by default and gates EVERY feature that
     * contacts the network (paste-unfurl, URL embeds). Nothing reaches the
     * network unless this is on; when it is, each feature is additionally
     * gated by its own per-feature key (both default ON), so turning the
     * master on gives the full experience and a user can still disable one
     * feature. The per-feature affordances offer a just-in-time opt-in the
     * moment the user does the thing that would use the network.
     */
    networkEnabled: boolean;
    /**
     * Paste-unfurl feature gate (birta.pasteUnfurl.enabled): pasting a bare URL
     * onto an empty selection fetches the page's Open Graph title and inserts
     * `[title](url)`. Gated by `networkEnabled && pasteUnfurlEnabled` — the
     * fetch fires only when BOTH are on. When the master is off, a bare-URL
     * paste inserts a plain link (no fetch, no `unfurlUrl` message) and offers a
     * just-in-time "Enable" affordance instead. Default ON, so the master is the
     * only thing off by default.
     */
    pasteUnfurlEnabled: boolean;
    /**
     * Apply a fetched title without asking (birta.pasteUnfurl.autoApply).
     *
     * Default OFF, which is the consent rule from docs/DESIGN_PRINCIPLES.md —
     * "nothing changes the file without consent". A fetched title is offered as
     * a suggestion at the link (Tab accepts) and the document is untouched until
     * the user takes it. Turning this on restores the silent upgrade: the title
     * replaces the link text on arrival, seconds after the paste. Mirrors the
     * calc advisory/`calc.autoInsert` split exactly.
     */
    pasteUnfurlAutoApply: boolean;
    /**
     * Inline (unfenced) calc gate (birta.calc.enabled): the `=` and `=>`
     * caret suggestions and the auto-insert rule in ordinary prose. Fenced
     * ```calc blocks are governed by `calcBlocksEnabled`, deliberately
     * independent — a worksheet the user typed into a calc fence should keep
     * computing even when they've silenced calc in prose.
     */
    calcEnabled: boolean;
    /** Fenced ```calc block gate (birta.calc.blocks.enabled): the live ledger
     * preview. Off, a calc fence is just an ordinary code block. */
    calcBlocksEnabled: boolean;
    /**
     * URL-embed feature gate (birta.embeds.enabled): a bare provider link
     * (YouTube) on its own line renders as an inline facade card — a static
     * thumbnail that loads the player only on click. Render-only: the on-disk
     * markdown stays the plain bare link, so this NEVER changes the file.
     * Gated by `networkEnabled && embedsEnabled` — the card renders and the
     * thumbnail loads only when BOTH are on. Default ON, so the master is the
     * only thing off by default.
     *
     * A provider URL is owned by this feature, not paste-unfurl: with embeds on,
     * pasting one inserts the bare link and fetches no title, because unfurl
     * would rewrite the link text and the card only renders while text === href.
     */
    embedsEnabled: boolean;
    /**
     * Per-provider embed roster (birta.embeds.providers.<kind>), read as one
     * nested map like `toolbar.items`. The contributed per-provider defaults
     * are merged in by VS Code itself, so the code default is the empty map
     * and an absent entry means ON (embedProviderEnabled owns that rule).
     *
     * The roster sits BENEATH the two consent gates and relaxes neither: a
     * provider switched on still renders nothing unless `embedsEnabled`, and
     * still fetches nothing unless `networkEnabled`. What it adds is the
     * choice the master switch cannot express — running YouTube without
     * handing Google, Miro or Figma the ids a document happens to reference.
     * That choice is consent, so these keys are application-scope like the
     * gates above them (MAR-199); settingsScope.test.ts pins it.
     */
    embedProviders: Record<string, boolean>;
    /** Insert the result on `=` instead of suggesting it (birta.calc.autoInsert). */
    calcAutoInsert: boolean;
    /**
     * Auto-update in-note anchor links on heading rename
     * (birta.autoUpdateAnchors): when a heading is renamed, every same-document
     * `[…](#old-slug)` link pointing at it is rewritten to the new slug in the
     * same undo step. On by default; turn it off to leave anchor links exactly
     * as typed when a heading's text changes.
     */
    autoUpdateAnchors: boolean;
    /**
     * Self-sinking checklists (birta.checklist.sinkChecked): when a task item is
     * checked it drops below the still-unchecked siblings in its list, and
     * unchecking floats it back up. Opt-in, default OFF — a plain in-place flip
     * otherwise.
     */
    checklistSinkChecked: boolean;
    /**
     * Extra literal strings the Notes review tab treats as editor-note markers
     * (birta.notes.customMarkers), on top of the built-in set (`[TK]`, `TODO:`,
     * `FIXME:`, HTML comments, unchecked checkboxes). Each is matched as a
     * literal substring; a bare alphanumeric token is auto word-boundaried at
     * the scan site so `TK` can't light up inside `networks`. Default empty.
     */
    notesCustomMarkers: string[];
    /**
     * Highlight editor-note markers in the text (birta.notes.highlightMarkers):
     * `[TK]`, `TODO:`, `FIXME:` and any custom markers get a quiet chip where
     * they sit, so a draft's unresolved bits are visible without opening the
     * review sidebar. On by default; off leaves the Notes tab's navigation
     * exactly as it was and costs nothing (no scan, no decoration pass).
     */
    notesHighlightMarkers: boolean;
    /**
     * Review sidebar (Proofreading + Notes tabs) organizes rows by type under
     * collapsible group headers when true (birta.review.groupByType), or as a
     * flat document-ordered list when false. Default true. Persisted so the
     * choice survives the webview being disposed on tab switch-away.
     */
    reviewGroupByType: boolean;
    imageLocalPath: string;
}

/** Field → setting key under the `birta.` prefix. */
/** A settings.json typo (the enum constrains only the Settings UI) → the default. */
export function normalizeCopyFormat(value: unknown): "markdown" | "richText" {
    return value === "richText" ? "richText" : "markdown";
}

/** A settings.json typo (the enum constrains only the Settings UI) → the default. */
export function normalizePasteFormat(value: unknown): "markdown" | "plainText" {
    return value === "plainText" ? "plainText" : "markdown";
}

export const BIRTA_SETTING_KEYS: { readonly [K in keyof BirtaConfig]: string } = {
    // Proofreading (ProofreadConfig fields)
    proofreadingEnabled: "proofreading.enabled",
    styleCheck: "styleCheck.enabled",
    fillers: "styleCheck.fillers",
    redundancies: "styleCheck.redundancies",
    cliches: "styleCheck.cliches",
    wordiness: "styleCheck.wordiness",
    aiVocabulary: "styleCheck.aiVocabulary",
    aiArtifacts: "styleCheck.aiArtifacts",
    passive: "styleCheck.passive",
    negativeParallelism: "styleCheck.negativeParallelism",
    longSentences: "styleCheck.longSentences",
    ruleOfThree: "styleCheck.ruleOfThree",
    emDash: "styleCheck.emDash",
    nonAsciiPunct: "styleCheck.nonAsciiPunct",
    absolutePerf: "styleCheck.absolutePerf",
    styleExceptions: "styleCheck.exceptions",
    spellCheck: "spellCheck.enabled",
    grammarCheck: "grammarCheck.enabled",
    userWords: "spellCheck.userWords",
    // Editor surface
    defaultMode: "defaultMode",
    debugMode: "debugMode",
    readOnly: "readOnly",
    whatsNewIndicator: "whatsNew.indicator",
    tableWrap: "tableWrap",
    codeBlockMaxHeight: "codeBlockMaxHeight",
    codeBlockAutoConvert: "codeBlockAutoConvert",
    codeBlockWordWrap: "codeBlockWordWrap",
    blockHandles: "blockHandles",
    lineNumbers: "lineNumbers",
    mermaidTheme: "mermaid.theme",
    plantumlTheme: "plantuml.theme",
    contentWidth: "contentWidth",
    maxContentWidth: "maxContentWidth",
    tocContentGap: "tocContentGap",
    tocPosition: "tocPosition",
    tocAutoHideThreshold: "tocAutoHideThreshold",
    tocWidth: "tocWidth",
    tocVisibility: "tocVisibility",
    frontmatterExpanded: "frontmatterExpanded",
    frontmatterAddButton: "frontmatterAddButton",
    copyFormat: "copyFormat",
    pasteFormat: "pasteFormat",
    customCss: "customCss",
    customJs: "customJs",
    fontPreset: "fontPreset",
    fontFamilySans: "fontFamilySans",
    fontFamilySerif: "fontFamilySerif",
    fontFamilyMono: "fontFamilyMono",
    fontSize: "fontSize",
    toolbarVisible: "toolbar.visible",
    toolbarOrder: "toolbar.order",
    toolbarPlacements: "toolbar.items",
    floatingToolbarEnabled: "floatingToolbar.enabled",
    floatingToolbarItems: "floatingToolbar.items",
    smartLinks: "smartLinks",
    logseq: "logseq",
    networkEnabled: "network.enabled",
    pasteUnfurlEnabled: "pasteUnfurl.enabled",
    pasteUnfurlAutoApply: "pasteUnfurl.autoApply",
    calcEnabled: "calc.enabled",
    calcBlocksEnabled: "calc.blocks.enabled",
    calcAutoInsert: "calc.autoInsert",
    autoUpdateAnchors: "autoUpdateAnchors",
    embedsEnabled: "embeds.enabled",
    embedProviders: "embeds.providers",
    checklistSinkChecked: "checklist.sinkChecked",
    notesCustomMarkers: "notes.customMarkers",
    notesHighlightMarkers: "notes.highlightMarkers",
    reviewGroupByType: "review.groupByType",
    imageLocalPath: "imageLocalPath",
};

/**
 * The one defaults table, pinned against package.json. A default belongs here,
 * never inline as a `get(key, fallback)` literal at a call site.
 */
export const BIRTA_CONFIG_DEFAULTS: BirtaConfig = {
    // Proofreading: every check ships ON; the escape hatch is the master gate.
    proofreadingEnabled: true,
    styleCheck: true,
    fillers: true,
    redundancies: true,
    cliches: true,
    wordiness: true,
    aiVocabulary: true,
    aiArtifacts: true,
    passive: true,
    negativeParallelism: true,
    longSentences: true,
    ruleOfThree: true,
    emDash: true,
    nonAsciiPunct: true,
    absolutePerf: true,
    styleExceptions: [],
    spellCheck: true,
    grammarCheck: true,
    userWords: [],
    // Editor surface
    defaultMode: "preview",
    debugMode: false,
    // Edits ship UNLOCKED: see the field's doc for why a reading-first default
    // is a decision for evidence rather than for launch.
    readOnly: false,
    whatsNewIndicator: true,
    tableWrap: "normal",
    codeBlockMaxHeight: 600,
    codeBlockAutoConvert: true,
    codeBlockWordWrap: "inherit",
    blockHandles: DEFAULT_BLOCK_HANDLES_MODE,
    lineNumbers: false,
    mermaidTheme: DEFAULT_MERMAID_THEME_MODE,
    plantumlTheme: DEFAULT_PLANTUML_THEME_MODE,
    contentWidth: DEFAULT_CONTENT_WIDTH_MODE,
    maxContentWidth: DEFAULT_MAX_WIDTH_CH,
    tocContentGap: 100,
    tocPosition: "right",
    tocAutoHideThreshold: 3,
    tocWidth: 260,
    tocVisibility: DEFAULT_TOC_VISIBILITY,
    frontmatterExpanded: true,
    // Off by default: on a document that will never carry metadata the button
    // is permanent chrome for a rare action, and it insets the content by a
    // button row. Opt in with the setting or Toggle Add Metadata Button; Edit
    // Frontmatter starts the same flow either way.
    frontmatterAddButton: false,
    // Native copy yields Markdown source by default — pasting into any
    // plain-text target keeps the syntax; "richText" restores the plain
    // rendition (the rich HTML flavor rides along in both modes).
    copyFormat: "markdown",
    // The symmetric default: a plain-text paste is parsed as Markdown, so
    // syntax the editor itself copies out can be pasted back in. "plainText"
    // restores the literal insert (Shift+Cmd+V does it for one paste).
    pasteFormat: "markdown",
    customCss: [],
    customJs: [],
    fontPreset: DEFAULT_FONT_PRESET,
    // The built-in stacks are also the contributed defaults, so the Settings UI
    // shows the real stack rather than an empty field (resolveFontStacks treats
    // a blank override the same way).
    fontFamilySans: FONT_PRESET_STACKS.sans,
    fontFamilySerif: FONT_PRESET_STACKS.serif,
    fontFamilyMono: FONT_PRESET_STACKS.mono,
    fontSize: DEFAULT_FONT_SIZE_PERCENT,
    toolbarVisible: true,
    toolbarOrder: [],
    toolbarPlacements: {},
    floatingToolbarEnabled: true,
    floatingToolbarItems: {},
    smartLinks: true,
    // Logseq handling ships OFF: a user who does not keep a Logseq graph pays
    // nothing for it, not even the ancestor stat walk that `auto` runs on open.
    logseq: "off",
    // Master network switch ships OFF (MAR-179): Birta is offline by default,
    // so NO network feature runs until the user turns this on. This is the one
    // setting whose default is off; the per-feature keys below stay ON so
    // flipping the master on gives the full experience. Turning it on is
    // offered just-in-time, the moment the user does something that would use
    // the network (see webview/components/networkOptIn).
    networkEnabled: false,
    // Paste-unfurl the FEATURE ships ON, but it's gated behind the master
    // switch: with the master off, a bare-URL paste inserts a plain link and
    // offers the opt-in; only `networkEnabled && pasteUnfurlEnabled` fetches the
    // page title. Leaving this on keeps the master the single off-by-default.
    pasteUnfurlEnabled: true,
    // …and, like calc, it is ADVISORY by default: the fetched title is offered
    // at the link and the document is untouched until accepted. A network reply
    // silently rewriting text seconds after the paste — and dirtying the file
    // for autosave — is exactly what "nothing changes the file without consent"
    // forbids. Turn this on to get the old silent upgrade back.
    pasteUnfurlAutoApply: false,
    // Calc: the feature ships on, but advisory (no silent mutation) by default.
    // The inline and block gates are independent — see the interface docs.
    calcEnabled: true,
    calcBlocksEnabled: true,
    calcAutoInsert: false,
    // Auto-update anchor links on heading rename ships ON — the maintainer
    // wants it automatic ("magical"); the gate is the escape hatch for anyone
    // who prefers links left exactly as typed.
    autoUpdateAnchors: true,
    // URL embeds the FEATURE ships ON, but gated behind the master switch: a
    // bare YouTube link renders as an inline facade card only when
    // `networkEnabled && embedsEnabled`. Render-only, so the file is unchanged;
    // with the master off there is no card and no thumbnail network load.
    embedsEnabled: true,
    // Every provider ships ON, so the master switch stays the only thing off
    // by default and turning it on still gives the full roster. The empty map
    // is the CODE default only: VS Code merges the contributed per-provider
    // defaults into a real read, and an absent entry reads as ON either way.
    embedProviders: {},
    // Self-sinking checklists ship OFF: reordering on a checkbox click is a
    // surprising motion until asked for, so the default is a plain in-place flip.
    checklistSinkChecked: false,
    // No extra markers by default — the Notes tab ships with the built-in set
    // ([TK], TODO:, FIXME:, HTML comments, unchecked checkboxes); this is the
    // personalization hook.
    notesCustomMarkers: [],
    // Marker highlighting ships ON: a note the writer can't see is a note they
    // publish. The gate is the escape hatch for anyone who wants an undecorated
    // canvas and is happy driving notes from the sidebar.
    notesHighlightMarkers: true,
    // Grouped-by-type is the default: it fixes long category names truncating in
    // a flat per-row chip, and reads more scannably ("14 em-dash, 3 spelling").
    reviewGroupByType: true,
    imageLocalPath: "",
};
