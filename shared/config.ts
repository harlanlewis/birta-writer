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

import type { ProofreadConfig, TableWrapMode, TocPosition, ToolbarPlacements, FontPreset } from "./messages";
import { DEFAULT_FONT_PRESET, DEFAULT_FONT_SIZE_PERCENT, FONT_PRESET_STACKS } from "./fontPresets";
import { DEFAULT_CONTENT_WIDTH_MODE, DEFAULT_MAX_WIDTH_CH } from "./contentWidth";
import { DEFAULT_BLOCK_HANDLES_MODE } from "./blockHandles";
import { DEFAULT_MERMAID_THEME_MODE } from "./mermaid";

/**
 * Snapshot of every `birta.*` setting the extension reads. Fields whose values
 * are user-normalized at the use site (blockHandles, mermaidTheme,
 * contentWidth, fontSize clamping) carry the RAW setting value here; the
 * normalizers stay where the value is consumed.
 */
export interface BirtaConfig extends ProofreadConfig {
    /** Which editor opens a markdown file by default. */
    defaultMode: "preview" | "markdown";
    debugMode: boolean;
    tableWrap: TableWrapMode;
    codeBlockMaxHeight: number;
    codeBlockAutoConvert: boolean;
    codeBlockWordWrap: "inherit" | "on" | "off";
    /** Raw `blockHandles` value; normalize with normalizeBlockHandlesMode. */
    blockHandles: string;
    /** Raw `mermaid.theme` value; normalize with normalizeMermaidThemeMode. */
    mermaidTheme: string;
    /** Raw `contentWidth` value; normalize with normalizeContentWidthMode. */
    contentWidth: string;
    maxContentWidth: number;
    tocContentGap: number;
    tocPosition: TocPosition;
    tocAutoHideThreshold: number;
    frontmatterExpanded: boolean;
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
    /** Inline calc-on-`=` master gate (birta.calc.enabled). */
    calcEnabled: boolean;
    /** Insert the result on `=` instead of suggesting it (birta.calc.autoInsert). */
    calcAutoInsert: boolean;
    /**
     * Self-sinking checklists (birta.checklist.sinkChecked): when a task item is
     * checked it drops below the still-unchecked siblings in its list, and
     * unchecking floats it back up. Opt-in, default OFF — a plain in-place flip
     * otherwise.
     */
    checklistSinkChecked: boolean;
    imageLocalPath: string;
}

/** Field → setting key under the `birta.` prefix. */
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
    styleExceptions: "styleCheck.exceptions",
    spellCheck: "spellCheck.enabled",
    grammarCheck: "grammarCheck.enabled",
    userWords: "spellCheck.userWords",
    // Editor surface
    defaultMode: "defaultMode",
    debugMode: "debugMode",
    tableWrap: "tableWrap",
    codeBlockMaxHeight: "codeBlockMaxHeight",
    codeBlockAutoConvert: "codeBlockAutoConvert",
    codeBlockWordWrap: "codeBlockWordWrap",
    blockHandles: "blockHandles",
    mermaidTheme: "mermaid.theme",
    contentWidth: "contentWidth",
    maxContentWidth: "maxContentWidth",
    tocContentGap: "tocContentGap",
    tocPosition: "tocPosition",
    tocAutoHideThreshold: "tocAutoHideThreshold",
    frontmatterExpanded: "frontmatterExpanded",
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
    calcEnabled: "calc.enabled",
    calcAutoInsert: "calc.autoInsert",
    checklistSinkChecked: "checklist.sinkChecked",
    imageLocalPath: "imageLocalPath",
};

/**
 * The one defaults table. Every inline `get(key, fallback)` literal the
 * extension used to carry lives here instead, pinned against package.json.
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
    styleExceptions: [],
    spellCheck: true,
    grammarCheck: true,
    userWords: [],
    // Editor surface
    defaultMode: "preview",
    debugMode: false,
    tableWrap: "normal",
    codeBlockMaxHeight: 600,
    codeBlockAutoConvert: true,
    codeBlockWordWrap: "inherit",
    blockHandles: DEFAULT_BLOCK_HANDLES_MODE,
    mermaidTheme: DEFAULT_MERMAID_THEME_MODE,
    contentWidth: DEFAULT_CONTENT_WIDTH_MODE,
    maxContentWidth: DEFAULT_MAX_WIDTH_CH,
    tocContentGap: 100,
    tocPosition: "right",
    tocAutoHideThreshold: 3,
    frontmatterExpanded: true,
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
    // Calc: the feature ships on, but advisory (no silent mutation) by default.
    calcEnabled: true,
    calcAutoInsert: false,
    // Self-sinking checklists ship OFF: reordering on a checkbox click is a
    // surprising motion until asked for, so the default is a plain in-place flip.
    checklistSinkChecked: false,
    imageLocalPath: "",
};
