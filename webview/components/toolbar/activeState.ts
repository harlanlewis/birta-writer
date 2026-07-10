/**
 * webview/components/toolbar/activeState.ts
 *
 * Pure derivation of "what state is the caret in" for the toolbar to reflect —
 * which inline marks are active, the current text-block level, and which block
 * container (list / quote / callout / code / table) the caret sits inside. Kept
 * DOM-free and unit-tested (like registry.ts); index.ts turns the result into
 * class toggles in onSelectionChange.
 *
 * The indicator STYLE is index.ts's concern; this module only answers "what is
 * true right now."
 */
import type { EditorState } from "@milkdown/prose/state";

export type ListKind = "bullet" | "ordered" | "task";
/** "blockquote" for a plain quote, otherwise the callout kind (note/tip/…). */
export type QuoteKind = "blockquote" | string;
export type CodeKind = "code" | "mermaid" | "math";

export interface ToolbarActiveState {
    /** Inline marks present on the selection/caret. */
    readonly marks: {
        readonly bold: boolean;
        readonly italic: boolean;
        readonly strikethrough: boolean;
        readonly highlight: boolean;
        readonly inlineCode: boolean;
        readonly link: boolean;
    };
    /** 0 = paragraph, 1–6 = heading, -1 = not a heading-capable textblock (code block). */
    readonly headingLevel: number;
    /** false where the text type can't be changed to a heading (table cell / code block). */
    readonly formatApplicable: boolean;
    /** The enclosing list type, or null. */
    readonly list: ListKind | null;
    /** The enclosing quote-family container (blockquote or callout kind), or null. */
    readonly quote: QuoteKind | null;
    /** The enclosing code-family container, or null. */
    readonly code: CodeKind | null;
    /** The caret is inside a table. */
    readonly inTable: boolean;
}

// Mark → the schema mark name(s) to probe (first that exists wins). Strikethrough
// is `strike_through` in the gfm preset; the alternates guard against drift.
const MARK_NAMES: Record<keyof ToolbarActiveState["marks"], readonly string[]> = {
    bold: ["strong"],
    italic: ["emphasis"],
    strikethrough: ["strike_through", "strikethrough"],
    highlight: ["highlight"],
    inlineCode: ["inlineCode"],
    link: ["link"],
};

/** True if any of the named marks is active on the current selection/caret. */
function anyMarkActive(state: EditorState, names: readonly string[]): boolean {
    const sel = state.selection;
    for (const name of names) {
        const type = state.schema.marks[name];
        if (!type) {
            continue;
        }
        if (sel.empty) {
            const marks = state.storedMarks ?? sel.$from.marks();
            if (type.isInSet(marks)) {
                return true;
            }
        } else if (state.doc.rangeHasMark(sel.from, sel.to, type)) {
            return true;
        }
    }
    return false;
}

/** Map a code block's `language` attr to the toolbar's Code-menu kind. */
function codeKindFromLanguage(language: unknown): CodeKind {
    const lang = String(language ?? "").toLowerCase();
    if (lang === "mermaid") {
        return "mermaid";
    }
    if (lang === "latex") {
        return "math";
    }
    return "code";
}

export function computeToolbarActiveState(state: EditorState): ToolbarActiveState {
    const { $from } = state.selection;

    let headingLevel = 0;
    let list: ListKind | null = null;
    let quote: QuoteKind | null = null;
    let code: CodeKind | null = null;
    let inTable = false;
    let inCodeBlock = false;

    // Walk the ancestor chain innermost→outermost. Each container is recorded the
    // first (innermost) time it's seen; a task item (list_item with a `checked`
    // attr) wins over the bullet_list wrapping it.
    for (let depth = $from.depth; depth >= 0; depth--) {
        const name = $from.node(depth).type.name;
        const attrs = $from.node(depth).attrs;
        if (name === "table" || name === "table_cell" || name === "table_header") {
            inTable = true;
        } else if (name === "code_block") {
            inCodeBlock = true;
            code = codeKindFromLanguage(attrs["language"]);
            headingLevel = -1;
        } else if (name === "heading" && headingLevel === 0) {
            headingLevel = typeof attrs["level"] === "number" ? attrs["level"] : 1;
        } else if (name === "list_item" && attrs["checked"] != null && list === null) {
            list = "task";
        } else if (name === "bullet_list" && list === null) {
            list = "bullet";
        } else if (name === "ordered_list" && list === null) {
            list = "ordered";
        } else if (name === "callout" && quote === null) {
            quote = typeof attrs["kind"] === "string" ? attrs["kind"] : "note";
        } else if (name === "blockquote" && quote === null) {
            quote = "blockquote";
        }
    }

    return {
        marks: {
            bold: anyMarkActive(state, MARK_NAMES.bold),
            italic: anyMarkActive(state, MARK_NAMES.italic),
            strikethrough: anyMarkActive(state, MARK_NAMES.strikethrough),
            highlight: anyMarkActive(state, MARK_NAMES.highlight),
            inlineCode: anyMarkActive(state, MARK_NAMES.inlineCode),
            link: anyMarkActive(state, MARK_NAMES.link),
        },
        headingLevel,
        formatApplicable: !inTable && !inCodeBlock,
        list,
        quote,
        code,
        inTable,
    };
}
