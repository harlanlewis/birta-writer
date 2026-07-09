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
import { t } from "@/i18n";
import { CALLOUT_ICONS } from "../callout";
import {
    IconAlertCircle,
    IconArrowLeftRight,
    IconBold,
    IconCheckSquare,
    IconClipboardList,
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

/**
 * Groups double as the browse-view section headers. The content groups
 * (text/lists/insert) are what a reader scans; the remaining groups are
 * search-only (revealed by typing or "Show all commands") and never render a
 * header on the default list — they organize the registry and describe the
 * intent behind each row.
 */
export type SlashMenuGroup =
    | "text"
    | "lists"
    | "insert"
    | "formatting"
    | "view"
    | "actions";

/**
 * A snapshot of the toggleable UI state, captured when the menu opens. Rows
 * whose one command flips a binary state (TOC visibility/side, toolbar
 * visibility) read it to show the label for what the pick will DO, so a single
 * row replaces a redundant show/hide pair.
 */
export interface SlashMenuState {
    readonly tocOpen: boolean;
    readonly tocRight: boolean;
    readonly toolbarVisible: boolean;
}

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
    /**
     * Optional state-dependent display label for toggle rows (e.g. "Hide
     * Table of Contents" vs "Show Table of Contents"). Display-only: the pure
     * filter still matches against `label` + `keywords`, so keywords must cover
     * both directions. Resolved once per open from a `SlashMenuState` snapshot.
     */
    readonly dynamicLabel?: (state: SlashMenuState) => string;
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

/**
 * Every row dispatches the same way: exactly one editor command (with optional
 * baked-in args). Font/proofread/TOC controls used to dispatch through a
 * bespoke host "action"; they are now real editor commands like everything
 * else, so the menu maps 1:1 onto shared/editorCommands.ts with no exceptions.
 */
export type SlashMenuItem = SlashMenuItemBase & {
    readonly commandId: EditorCommandId;
    readonly args?: unknown;
};

/** Group display order + labels (headers shown only for unfiltered view). */
export const SLASH_GROUPS: ReadonlyArray<{ id: SlashMenuGroup; label: string }> = [
    { id: "text", label: t("Text") },
    { id: "lists", label: t("Lists") },
    { id: "insert", label: t("Insert") },
    { id: "formatting", label: t("Formatting") },
    { id: "view", label: t("View") },
    { id: "actions", label: t("Actions") },
];

/**
 * Registry order is display order within a group. The unfiltered menu shows
 * only the non-searchOnly rows (the original scannable list — H1–H3, like
 * Notion); everything else the toolbar can do is reachable by typing, and a
 * parity drift test asserts full toolbar coverage.
 */
export const SLASH_MENU_ITEMS: readonly SlashMenuItem[] = [
    // ── Text: paragraph + headings (H4–H6 search-revealed) ──
    { id: "paragraph", group: "text", label: t("Paragraph"), icon: IconPilcrow, keywords: ["text", "plain", "p", "body"], commandId: "setParagraph" },
    { id: "heading1", group: "text", label: t("Heading 1"), icon: "", badge: "H1", hint: "#", keywords: ["h1", "title", "heading"], commandId: "setHeading1" },
    { id: "heading2", group: "text", label: t("Heading 2"), icon: "", badge: "H2", hint: "##", keywords: ["h2", "subtitle", "heading"], commandId: "setHeading2" },
    { id: "heading3", group: "text", label: t("Heading 3"), icon: "", badge: "H3", hint: "###", keywords: ["h3", "heading"], commandId: "setHeading3" },
    { id: "heading4", group: "text", label: t("Heading 4"), icon: "", badge: "H4", hint: "####", keywords: ["h4", "heading"], commandId: "setHeading4", searchOnly: true },
    { id: "heading5", group: "text", label: t("Heading 5"), icon: "", badge: "H5", hint: "#####", keywords: ["h5", "heading"], commandId: "setHeading5", searchOnly: true },
    { id: "heading6", group: "text", label: t("Heading 6"), icon: "", badge: "H6", hint: "######", keywords: ["h6", "heading"], commandId: "setHeading6", searchOnly: true },
    // ── Lists ──
    { id: "bulletList", group: "lists", label: t("Bullet List"), icon: IconList, hint: "-", keywords: ["ul", "unordered", "list"], commandId: "toggleBulletList" },
    { id: "orderedList", group: "lists", label: t("Ordered List"), icon: IconListOrdered, hint: "1.", keywords: ["ol", "numbered", "list"], commandId: "toggleOrderedList" },
    { id: "taskList", group: "lists", label: t("Task List"), icon: IconCheckSquare, hint: "[ ]", keywords: ["todo", "checkbox", "check", "list"], commandId: "toggleTaskList" },
    // ── Insert: everything you add — containers, embeds, references, dividers.
    // (Not "Blocks": every node is a block; this names what you DO with the row.) ──
    { id: "table", group: "insert", label: t("Table"), icon: IconTable, keywords: ["table", "grid", "rows", "columns"], commandId: "insertTable" },
    { id: "image", group: "insert", label: t("Image"), icon: IconImage, hint: "![]", keywords: ["image", "picture", "photo", "figure"], commandId: "insertImage" },
    { id: "codeBlock", group: "insert", label: t("Code Block"), icon: IconTerminal, hint: "```", keywords: ["code", "fence", "snippet", "pre"], commandId: "insertCodeBlock" },
    { id: "blockquote", group: "insert", label: t("Blockquote"), icon: IconQuote, hint: ">", keywords: ["quote", "cite"], commandId: "toggleBlockquote" },
    // Generic row keeps only generic synonyms; the specific type names (note,
    // warning, tip, …) live on their dedicated search-only rows below, so
    // filtering by a type surfaces just that type, not the generic row too.
    { id: "callout", group: "insert", label: t("Callout"), icon: IconAlertCircle, hint: "> [!]", keywords: ["callout", "admonition", "alert", "aside"], commandId: "insertCallout" },
    // The five GitHub callout TYPES — search-only so they surface when you type
    // a type name (or "callout") without cluttering the browse list. Each bakes
    // in its kind arg; keywords carry the type name, "callout", and Obsidian
    // aliases (KIND_ALIASES in plugins/callouts.ts) where one exists.
    { id: "callout-note", group: "insert", label: t("Note"), icon: CALLOUT_ICONS.note, keywords: ["note", "callout", "admonition", "alert"], commandId: "insertCallout", args: "note", searchOnly: true },
    { id: "callout-tip", group: "insert", label: t("Tip"), icon: CALLOUT_ICONS.tip, keywords: ["tip", "hint", "callout", "admonition"], commandId: "insertCallout", args: "tip", searchOnly: true },
    { id: "callout-important", group: "insert", label: t("Important"), icon: CALLOUT_ICONS.important, keywords: ["important", "callout", "admonition"], commandId: "insertCallout", args: "important", searchOnly: true },
    { id: "callout-warning", group: "insert", label: t("Warning"), icon: CALLOUT_ICONS.warning, keywords: ["warning", "attention", "callout", "admonition", "alert"], commandId: "insertCallout", args: "warning", searchOnly: true },
    { id: "callout-caution", group: "insert", label: t("Caution"), icon: CALLOUT_ICONS.caution, keywords: ["caution", "callout", "admonition", "alert"], commandId: "insertCallout", args: "caution", searchOnly: true },
    { id: "mermaid", group: "insert", label: t("Mermaid Diagram"), icon: IconNetwork, keywords: ["mermaid", "diagram", "flowchart", "graph", "chart"], commandId: "insertCodeBlock", args: "mermaid" },
    // Inline math is a real node; a math BLOCK is a LaTeX-language code block
    // (same mechanism as Mermaid), otherwise reachable only by typing "$$ ".
    { id: "math", group: "insert", label: t("Inline Math"), icon: IconMath, hint: "$", keywords: ["math", "latex", "katex", "equation", "formula", "inline"], commandId: "insertMath" },
    { id: "mathBlock", group: "insert", label: t("Math Block"), icon: IconMath, hint: "$$", keywords: ["math", "latex", "katex", "equation", "formula", "block", "display"], commandId: "insertCodeBlock", args: "LaTeX" },
    { id: "link", group: "insert", label: t("Link"), icon: IconLink, hint: "[]()", keywords: ["link", "url", "anchor"], commandId: "insertLink" },
    { id: "footnote", group: "insert", label: t("Footnote"), icon: IconFootnote, hint: "[^]", keywords: ["footnote", "reference", "note"], commandId: "insertFootnote" },
    { id: "divider", group: "insert", label: t("Horizontal Rule"), icon: IconMinus, hint: "---", keywords: ["hr", "divider", "rule", "line", "separator"], commandId: "insertHorizontalRule" },
    // ── Inline formatting (toolbar parity; all search-revealed) ──
    // With no selection these set the stored mark for the text typed next,
    // exactly like clicking the toolbar button at a bare caret.
    { id: "bold", group: "formatting", label: t("Bold"), icon: IconBold, hint: "**", keywords: ["bold", "strong", "b"], commandId: "toggleBold", searchOnly: true },
    { id: "italic", group: "formatting", label: t("Italic"), icon: IconItalic, hint: "*", keywords: ["italic", "emphasis", "em", "i"], commandId: "toggleItalic", searchOnly: true },
    { id: "strikethrough", group: "formatting", label: t("Strikethrough"), icon: IconStrikethrough, hint: "~~", keywords: ["strikethrough", "strike", "del", "s"], commandId: "toggleStrikethrough", searchOnly: true },
    { id: "highlight", group: "formatting", label: t("Highlight"), icon: IconHighlighter, hint: "==", keywords: ["highlight", "mark", "marker"], commandId: "toggleHighlight", searchOnly: true },
    { id: "inlineCode", group: "formatting", label: t("Inline Code"), icon: IconCode, hint: "`", keywords: ["code", "inline", "mono", "monospace"], commandId: "toggleInlineCode", searchOnly: true },
    { id: "clearFormatting", group: "formatting", label: t("Clear Formatting"), icon: IconEraser, keywords: ["clear", "formatting", "remove", "plain", "unformat"], commandId: "clearFormatting", searchOnly: true },
    // ── View: how the document is displayed — TOC, fonts, toolbar (search-
    // revealed; these act on chrome, not content, and are also in the palette).
    // The toggles carry a state-dependent label so one row replaces a show/hide
    // pair; keywords cover both directions since the filter matches `label`. ──
    { id: "tocToggle", group: "view", label: t("Toggle Table of Contents"), dynamicLabel: (s) => (s.tocOpen ? t("Hide Table of Contents") : t("Show Table of Contents")), icon: IconClipboardList, keywords: ["toc", "contents", "table of contents", "outline", "show", "hide", "toggle", "open", "close"], commandId: "toggleToc", searchOnly: true },
    { id: "tocSwap", group: "view", label: t("Swap Table of Contents Side"), dynamicLabel: (s) => (s.tocRight ? t("Move Table of Contents Left") : t("Move Table of Contents Right")), icon: IconArrowLeftRight, keywords: ["toc", "contents", "table of contents", "side", "swap", "move", "left", "right"], commandId: "swapTocSide", searchOnly: true },
    { id: "toolbarToggle", group: "view", label: t("Toggle Toolbar"), dynamicLabel: (s) => (s.toolbarVisible ? t("Hide Toolbar") : t("Show Toolbar")), icon: IconPanelTop, keywords: ["toolbar", "show", "hide", "toggle", "bar"], commandId: "toggleToolbar", searchOnly: true },
    { id: "fontEditor", group: "view", label: t("Editor font"), icon: "", badge: "A", keywords: ["font", "default", "typeface"], commandId: "fontEditor", searchOnly: true },
    { id: "fontSans", group: "view", label: t("Sans serif"), icon: "", badge: "A", keywords: ["font", "sans", "typeface"], commandId: "fontSans", searchOnly: true },
    { id: "fontSerif", group: "view", label: t("Serif"), icon: "", badge: "A", keywords: ["font", "serif", "typeface"], commandId: "fontSerif", searchOnly: true },
    { id: "fontMono", group: "view", label: t("Monospace"), icon: "", badge: "A", keywords: ["font", "mono", "monospace", "typeface"], commandId: "fontMono", searchOnly: true },
    { id: "fontSizeIncrease", group: "view", label: t("Increase font size"), icon: "", badge: "A+", keywords: ["font", "size", "bigger", "larger", "zoom"], commandId: "increaseFontSize", searchOnly: true },
    { id: "fontSizeDecrease", group: "view", label: t("Decrease font size"), icon: "", badge: "A−", keywords: ["font", "size", "smaller"], commandId: "decreaseFontSize", searchOnly: true },
    // ── Actions: commands and tools (toolbar parity; all search-revealed) ──
    { id: "find", group: "actions", label: t("Find"), icon: IconSearch, keywords: ["find", "search"], commandId: "openFind", searchOnly: true },
    { id: "viewSource", group: "actions", label: t("Edit Raw Markdown"), icon: IconFileCode, keywords: ["source", "raw", "markdown", "text", "code"], commandId: "editRawMarkdown", searchOnly: true },
    { id: "customizeToolbar", group: "actions", label: t("Customize Toolbar"), icon: IconPencil, keywords: ["customize", "toolbar", "layout", "arrange"], commandId: "customizeToolbar", searchOnly: true },
    { id: "keyboardShortcuts", group: "actions", label: t("Keyboard Shortcuts"), icon: IconKeyboard, keywords: ["keyboard", "shortcuts", "keys", "bindings", "keybindings"], commandId: "openKeyboardShortcuts", searchOnly: true },
    { id: "settings", group: "actions", label: t("Settings"), icon: IconSettings, keywords: ["settings", "preferences", "options", "configure"], commandId: "openExtensionSettings", searchOnly: true },
    // Checks-menu parity: the three master toggles (the per-style sub-checks
    // stay in the Checks dropdown — configuration detail, not a toolbar item).
    { id: "spellCheck", group: "actions", label: t("Check spelling"), icon: IconSpellCheck, keywords: ["spell", "spelling", "spellcheck", "proofread", "toggle"], commandId: "toggleSpellCheck", searchOnly: true },
    { id: "grammarCheck", group: "actions", label: t("Check grammar"), icon: IconSpellCheck, keywords: ["grammar", "proofread", "toggle"], commandId: "toggleGrammarCheck", searchOnly: true },
    { id: "styleCheck", group: "actions", label: t("Check style"), icon: IconStyleCheck, keywords: ["style", "prose", "checks", "proofread", "toggle"], commandId: "toggleStyleCheck", searchOnly: true },
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
