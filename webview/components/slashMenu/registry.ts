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
import {
    IconCheckSquare,
    IconFootnote,
    IconImage,
    IconLink,
    IconList,
    IconListOrdered,
    IconMath,
    IconMinus,
    IconPilcrow,
    IconQuote,
    IconTable,
    IconTerminal,
} from "@/ui/icons";

export type SlashMenuGroup = "basic" | "advanced";

export interface SlashMenuItem {
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
    /** Short text badge in the icon slot (headings: "H1".."H3"). */
    readonly badge?: string;
    /** Right-aligned markdown-shortcut hint — literal syntax, untranslated. */
    readonly hint?: string;
    /** Lowercase aliases the filter matches in addition to the label. */
    readonly keywords: readonly string[];
    readonly commandId: EditorCommandId;
    readonly args?: unknown;
}

/** Group display order + labels (headers shown only for unfiltered view). */
export const SLASH_GROUPS: ReadonlyArray<{ id: SlashMenuGroup; label: string }> = [
    { id: "basic", label: t("Basic blocks") },
    { id: "advanced", label: t("Advanced") },
];

/**
 * Registry order is display order within a group. H4–H6 are deliberately
 * omitted (the menu stays scannable; `####` input rules and the toolbar's
 * format dropdown cover them — Notion offers H1–H3 the same way).
 */
export const SLASH_MENU_ITEMS: readonly SlashMenuItem[] = [
    { id: "paragraph", group: "basic", label: t("Paragraph"), icon: IconPilcrow, keywords: ["text", "plain", "p", "body"], commandId: "setParagraph" },
    { id: "heading1", group: "basic", label: t("Heading 1"), icon: "", badge: "H1", hint: "#", keywords: ["h1", "title", "heading"], commandId: "setHeading1" },
    { id: "heading2", group: "basic", label: t("Heading 2"), icon: "", badge: "H2", hint: "##", keywords: ["h2", "subtitle", "heading"], commandId: "setHeading2" },
    { id: "heading3", group: "basic", label: t("Heading 3"), icon: "", badge: "H3", hint: "###", keywords: ["h3", "heading"], commandId: "setHeading3" },
    { id: "bulletList", group: "basic", label: t("Bullet List"), icon: IconList, hint: "-", keywords: ["ul", "unordered", "list"], commandId: "toggleBulletList" },
    { id: "orderedList", group: "basic", label: t("Ordered List"), icon: IconListOrdered, hint: "1.", keywords: ["ol", "numbered", "list"], commandId: "toggleOrderedList" },
    { id: "taskList", group: "basic", label: t("Task List"), icon: IconCheckSquare, hint: "[ ]", keywords: ["todo", "checkbox", "check", "list"], commandId: "toggleTaskList" },
    { id: "blockquote", group: "basic", label: t("Blockquote"), icon: IconQuote, hint: ">", keywords: ["quote", "cite"], commandId: "toggleBlockquote" },
    { id: "divider", group: "basic", label: t("Horizontal Rule"), icon: IconMinus, hint: "---", keywords: ["hr", "divider", "rule", "line", "separator"], commandId: "insertHorizontalRule" },
    { id: "codeBlock", group: "advanced", label: t("Code Block"), icon: IconTerminal, hint: "```", keywords: ["code", "fence", "snippet", "pre"], commandId: "insertCodeBlock" },
    { id: "table", group: "advanced", label: t("Table"), icon: IconTable, keywords: ["table", "grid", "rows", "columns"], commandId: "insertTable" },
    { id: "image", group: "advanced", label: t("Image"), icon: IconImage, hint: "![]", keywords: ["image", "picture", "photo", "figure"], commandId: "insertImage" },
    { id: "link", group: "advanced", label: t("Link"), icon: IconLink, hint: "[]()", keywords: ["link", "url", "anchor"], commandId: "insertLink" },
    { id: "math", group: "advanced", label: t("Math"), icon: IconMath, hint: "$", keywords: ["math", "latex", "katex", "equation", "formula"], commandId: "insertMath" },
    { id: "footnote", group: "advanced", label: t("Footnote"), icon: IconFootnote, hint: "[^]", keywords: ["footnote", "reference", "note"], commandId: "insertFootnote" },
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
        return [...items];
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
