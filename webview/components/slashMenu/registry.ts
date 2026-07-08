/**
 * components/slashMenu/registry.ts
 *
 * The slash-command item registry and its filter — pure data + pure
 * functions, no DOM (unit-tested directly, like toolbar/registry.ts).
 *
 * Every item maps 1:1 onto an existing editor action from
 * shared/editorCommands.ts, so the menu can never drift from what the
 * toolbar/command palette can do: `commandId` is typed against
 * EditorCommandId (a misspelled id is a compile error) and a drift test
 * asserts membership at runtime.
 */
import type { EditorCommandId } from "../../../shared/editorCommands";
import type { FontPreset } from "../../../shared/messages";
import { t } from "@/i18n";
import {
    IconAlertCircle,
    IconBold,
    IconCheckSquare,
    IconCode,
    IconEraser,
    IconFileCode,
    IconFootnote,
    IconHighlighter,
    IconImage,
    IconItalic,
    IconKeyboard,
    IconLink,
    IconList,
    IconListOrdered,
    IconMath,
    IconMinus,
    IconNetwork,
    IconPanelTop,
    IconPencil,
    IconPilcrow,
    IconQuote,
    IconSearch,
    IconSettings,
    IconSpellCheck,
    IconStrikethrough,
    IconStyleCheck,
    IconTable,
    IconTerminal,
} from "@/ui/icons";

export type SlashMenuGroup = "basic" | "advanced" | "formatting" | "actions";

/**
 * A toolbar behavior that is NOT an EditorCommandId — it lives on the toolbar
 * controller (font picker, size stepper, proofread toggles) and is reached
 * through the slash host's runAction. Args are baked into each variant so a
 * registry row stays pure data.
 */
export type SlashMenuAction =
    | { readonly type: "fontPreset"; readonly preset: FontPreset }
    | { readonly type: "fontSizeStep"; readonly delta: 1 | -1 }
    | { readonly type: "proofreadToggle"; readonly key: "spellCheck" | "grammarCheck" | "styleCheck" };

interface SlashMenuItemBase {
    /** Stable id — aria row ids (`md-slash-item-<id>`) and test hooks. */
    readonly id: string;
    readonly group: SlashMenuGroup;
    /**
     * Display label (English literal through t(), like the toolbar). Bare
     * block nouns ("Table", not the palette's "Insert Table") — a slash menu
     * names what the block IS; the verb is implied by the menu itself.
     */
    readonly label: string;
    /** Inline SVG markup, or "" when `badge` renders instead. */
    readonly icon: string;
    /** Short text badge in the icon slot (headings: "H1".."H6"). */
    readonly badge?: string;
    /** Right-aligned markdown-shortcut hint — literal syntax, untranslated. */
    readonly hint?: string;
    /** Lowercase aliases the filter matches in addition to the label. */
    readonly keywords: readonly string[];
    /**
     * Hidden from the unfiltered list, surfaced only by type-to-filter
     * (Notion's pattern for rarely used entries). Full toolbar parity lives
     * behind this flag so the default menu stays the same scannable list.
     */
    readonly searchOnly?: true;
}

/** Every row dispatches exactly one way: a registry command or a host action. */
export type SlashMenuItem =
    | (SlashMenuItemBase & {
        readonly commandId: EditorCommandId;
        readonly args?: unknown;
        readonly action?: undefined;
    })
    | (SlashMenuItemBase & {
        readonly action: SlashMenuAction;
        readonly commandId?: undefined;
        readonly args?: undefined;
    });

/** Group display order + labels (headers shown only for unfiltered view). */
export const SLASH_GROUPS: ReadonlyArray<{ id: SlashMenuGroup; label: string }> = [
    { id: "basic", label: t("Basic blocks") },
    { id: "advanced", label: t("Advanced") },
    { id: "formatting", label: t("Formatting") },
    { id: "actions", label: t("Actions") },
];

/**
 * Registry order is display order within a group. The unfiltered menu shows
 * only the non-searchOnly rows (the original scannable list — H1–H3, like
 * Notion); everything else the toolbar can do is reachable by typing, and a
 * parity drift test asserts full toolbar coverage.
 */
export const SLASH_MENU_ITEMS: readonly SlashMenuItem[] = [
    { id: "paragraph", group: "basic", label: t("Paragraph"), icon: IconPilcrow, keywords: ["text", "plain", "p", "body"], commandId: "setParagraph" },
    { id: "heading1", group: "basic", label: t("Heading 1"), icon: "", badge: "H1", hint: "#", keywords: ["h1", "title", "heading"], commandId: "setHeading1" },
    { id: "heading2", group: "basic", label: t("Heading 2"), icon: "", badge: "H2", hint: "##", keywords: ["h2", "subtitle", "heading"], commandId: "setHeading2" },
    { id: "heading3", group: "basic", label: t("Heading 3"), icon: "", badge: "H3", hint: "###", keywords: ["h3", "heading"], commandId: "setHeading3" },
    { id: "heading4", group: "basic", label: t("Heading 4"), icon: "", badge: "H4", hint: "####", keywords: ["h4", "heading"], commandId: "setHeading4", searchOnly: true },
    { id: "heading5", group: "basic", label: t("Heading 5"), icon: "", badge: "H5", hint: "#####", keywords: ["h5", "heading"], commandId: "setHeading5", searchOnly: true },
    { id: "heading6", group: "basic", label: t("Heading 6"), icon: "", badge: "H6", hint: "######", keywords: ["h6", "heading"], commandId: "setHeading6", searchOnly: true },
    { id: "bulletList", group: "basic", label: t("Bullet List"), icon: IconList, hint: "-", keywords: ["ul", "unordered", "list"], commandId: "toggleBulletList" },
    { id: "orderedList", group: "basic", label: t("Ordered List"), icon: IconListOrdered, hint: "1.", keywords: ["ol", "numbered", "list"], commandId: "toggleOrderedList" },
    { id: "taskList", group: "basic", label: t("Task List"), icon: IconCheckSquare, hint: "[ ]", keywords: ["todo", "checkbox", "check", "list"], commandId: "toggleTaskList" },
    { id: "blockquote", group: "basic", label: t("Blockquote"), icon: IconQuote, hint: ">", keywords: ["quote", "cite"], commandId: "toggleBlockquote" },
    { id: "callout", group: "basic", label: t("Callout"), icon: IconAlertCircle, hint: "> [!]", keywords: ["callout", "admonition", "alert", "note", "warning", "tip", "aside"], commandId: "insertCallout" },
    { id: "divider", group: "basic", label: t("Horizontal Rule"), icon: IconMinus, hint: "---", keywords: ["hr", "divider", "rule", "line", "separator"], commandId: "insertHorizontalRule" },
    { id: "codeBlock", group: "advanced", label: t("Code Block"), icon: IconTerminal, hint: "```", keywords: ["code", "fence", "snippet", "pre"], commandId: "insertCodeBlock" },
    { id: "mermaid", group: "advanced", label: t("Mermaid Diagram"), icon: IconNetwork, keywords: ["mermaid", "diagram", "flowchart", "graph", "chart"], commandId: "insertCodeBlock", args: "mermaid" },
    { id: "table", group: "advanced", label: t("Table"), icon: IconTable, keywords: ["table", "grid", "rows", "columns"], commandId: "insertTable" },
    { id: "image", group: "advanced", label: t("Image"), icon: IconImage, hint: "![]", keywords: ["image", "picture", "photo", "figure"], commandId: "insertImage" },
    { id: "link", group: "advanced", label: t("Link"), icon: IconLink, hint: "[]()", keywords: ["link", "url", "anchor"], commandId: "insertLink" },
    { id: "math", group: "advanced", label: t("Math"), icon: IconMath, hint: "$", keywords: ["math", "latex", "katex", "equation", "formula"], commandId: "insertMath" },
    { id: "footnote", group: "advanced", label: t("Footnote"), icon: IconFootnote, hint: "[^]", keywords: ["footnote", "reference", "note"], commandId: "insertFootnote" },
    // ── Inline formatting (toolbar parity; all search-revealed) ──
    // With no selection these set the stored mark for the text typed next,
    // exactly like clicking the toolbar button at a bare caret.
    { id: "bold", group: "formatting", label: t("Bold"), icon: IconBold, hint: "**", keywords: ["bold", "strong", "b"], commandId: "toggleBold", searchOnly: true },
    { id: "italic", group: "formatting", label: t("Italic"), icon: IconItalic, hint: "*", keywords: ["italic", "emphasis", "em", "i"], commandId: "toggleItalic", searchOnly: true },
    { id: "strikethrough", group: "formatting", label: t("Strikethrough"), icon: IconStrikethrough, hint: "~~", keywords: ["strikethrough", "strike", "del", "s"], commandId: "toggleStrikethrough", searchOnly: true },
    { id: "highlight", group: "formatting", label: t("Highlight"), icon: IconHighlighter, hint: "==", keywords: ["highlight", "mark", "marker"], commandId: "toggleHighlight", searchOnly: true },
    { id: "inlineCode", group: "formatting", label: t("Inline Code"), icon: IconCode, hint: "`", keywords: ["code", "inline", "mono", "monospace"], commandId: "toggleInlineCode", searchOnly: true },
    { id: "clearFormatting", group: "formatting", label: t("Clear Formatting"), icon: IconEraser, keywords: ["clear", "formatting", "remove", "plain", "unformat"], commandId: "clearFormatting", searchOnly: true },
    // ── App actions (toolbar parity; all search-revealed) ──
    { id: "find", group: "actions", label: t("Find"), icon: IconSearch, keywords: ["find", "search"], commandId: "openFind", searchOnly: true },
    { id: "viewSource", group: "actions", label: t("Edit Raw Markdown"), icon: IconFileCode, keywords: ["source", "raw", "markdown", "text", "code"], commandId: "editRawMarkdown", searchOnly: true },
    { id: "hideToolbar", group: "actions", label: t("Hide Toolbar"), icon: IconPanelTop, keywords: ["toolbar", "hide", "bar"], commandId: "hideToolbar", searchOnly: true },
    { id: "showToolbar", group: "actions", label: t("Show Toolbar"), icon: IconPanelTop, keywords: ["toolbar", "show", "bar"], commandId: "showToolbar", searchOnly: true },
    { id: "customizeToolbar", group: "actions", label: t("Customize Toolbar"), icon: IconPencil, keywords: ["customize", "toolbar", "layout", "arrange"], commandId: "customizeToolbar", searchOnly: true },
    { id: "keyboardShortcuts", group: "actions", label: t("Keyboard Shortcuts"), icon: IconKeyboard, keywords: ["keyboard", "shortcuts", "keys", "bindings", "keybindings"], commandId: "openKeyboardShortcuts", searchOnly: true },
    { id: "settings", group: "actions", label: t("Settings"), icon: IconSettings, keywords: ["settings", "preferences", "options", "configure"], commandId: "openExtensionSettings", searchOnly: true },
    // Font picker parity: the same four presets and the size stepper.
    { id: "fontEditor", group: "actions", label: t("Editor font"), icon: "", badge: "A", keywords: ["font", "default", "typeface"], action: { type: "fontPreset", preset: "editor" }, searchOnly: true },
    { id: "fontSans", group: "actions", label: t("Sans serif"), icon: "", badge: "A", keywords: ["font", "sans", "typeface"], action: { type: "fontPreset", preset: "sans" }, searchOnly: true },
    { id: "fontSerif", group: "actions", label: t("Serif"), icon: "", badge: "A", keywords: ["font", "serif", "typeface"], action: { type: "fontPreset", preset: "serif" }, searchOnly: true },
    { id: "fontMono", group: "actions", label: t("Monospace"), icon: "", badge: "A", keywords: ["font", "mono", "monospace", "typeface"], action: { type: "fontPreset", preset: "mono" }, searchOnly: true },
    { id: "fontSizeIncrease", group: "actions", label: t("Increase font size"), icon: "", badge: "A+", keywords: ["font", "size", "bigger", "larger", "zoom"], action: { type: "fontSizeStep", delta: 1 }, searchOnly: true },
    { id: "fontSizeDecrease", group: "actions", label: t("Decrease font size"), icon: "", badge: "A−", keywords: ["font", "size", "smaller"], action: { type: "fontSizeStep", delta: -1 }, searchOnly: true },
    // Checks-menu parity: the three master toggles (the per-style sub-checks
    // stay in the Checks dropdown — configuration detail, not a toolbar item).
    { id: "spellCheck", group: "actions", label: t("Check spelling"), icon: IconSpellCheck, keywords: ["spell", "spelling", "spellcheck", "proofread", "toggle"], action: { type: "proofreadToggle", key: "spellCheck" }, searchOnly: true },
    { id: "grammarCheck", group: "actions", label: t("Check grammar"), icon: IconSpellCheck, keywords: ["grammar", "proofread", "toggle"], action: { type: "proofreadToggle", key: "grammarCheck" }, searchOnly: true },
    { id: "styleCheck", group: "actions", label: t("Check style"), icon: IconStyleCheck, keywords: ["style", "prose", "checks", "proofread", "toggle"], action: { type: "proofreadToggle", key: "styleCheck" }, searchOnly: true },
];

/**
 * Case-insensitive filter with prefix-first ranking. Three tiers, stable
 * registry order within each: label prefix, then keyword prefix, then
 * label/keyword substring. Substring matching is the project convention
 * (lang picker, frontmatter suggest); the tiers only fix ORDERING so that
 * e.g. "ta" ranks Table above items merely containing "ta". Empty query
 * returns everything in registry (grouped) order.
 */
export function filterSlashItems(
    items: readonly SlashMenuItem[],
    query: string,
): SlashMenuItem[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        // The browsable list: search-only rows exist for parity, not scanning.
        return items.filter((item) => !item.searchOnly);
    }
    const labelPrefix: SlashMenuItem[] = [];
    const keywordPrefix: SlashMenuItem[] = [];
    const substring: SlashMenuItem[] = [];
    for (const item of items) {
        const label = item.label.toLowerCase();
        if (label.startsWith(q)) {
            labelPrefix.push(item);
        } else if (item.keywords.some((k) => k.startsWith(q))) {
            keywordPrefix.push(item);
        } else if (label.includes(q) || item.keywords.some((k) => k.includes(q))) {
            substring.push(item);
        }
    }
    return [...labelPrefix, ...keywordPrefix, ...substring];
}
