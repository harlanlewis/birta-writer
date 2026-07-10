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
import { NodeSelection } from "@milkdown/prose/state";

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
    /** false where the text type can't be changed to a heading (table cell / code block / a selected atom). */
    readonly formatApplicable: boolean;
    /** The enclosing list type, or null. */
    readonly list: ListKind | null;
    /** The enclosing quote-family container (blockquote or callout kind), or null. */
    readonly quote: QuoteKind | null;
    /** The enclosing code-family container, or null. */
    readonly code: CodeKind | null;
    /** The caret is inside a table. */
    readonly inTable: boolean;
    /**
     * A `wiki_link` atom is node-selected. Wikilinks (like inline math) are inline
     * ATOMS, not marks — arrowing onto one selects the whole node — so a
     * `rangeHasMark` probe can never see them; the toolbar lights the Link button
     * off this instead. `marks.link` still covers real `[text](url)` links.
     */
    readonly wikiLink: boolean;
    /**
     * A `math_inline` node is node-selected OR the caret is inside its revealed
     * LaTeX source (the formula's text content — mathInlineEdit.ts).
     */
    readonly inlineMath: boolean;
    /** An `image` node is node-selected (the image button reflects this). */
    readonly imageSelected: boolean;
}

// Mark → the schema mark name(s) to probe (first that exists wins). Strikethrough
// is `strike_through` in the gfm preset; the alternates guard against drift.
const MARK_NAMES: Record<keyof ToolbarActiveState["marks"], readonly string[]> = {
    bold: ["strong"],
    italic: ["emphasis"],
    strikethrough: ["strike_through", "strikethrough"],
    highlight: ["highlight"],
    inlineCode: ["inlineCode"],
    // `link_ref` is the reference-style `[text][ref]` mark (plugins/referenceLinks.ts).
    link: ["link", "link_ref"],
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

/**
 * The "caret is somewhere the toolbar can't act on" state: nothing lit, format
 * greyed to "—". Used when focus leaves ProseMirror for a nested contenteditable
 * island (a callout title, plugins/callouts.ts) — the PM selection stays frozen
 * where it was, so without this the bar would keep asserting the stale block
 * (the "P stays active in the callout title" bug). Mirrors a table cell: neutral.
 */
export const DETACHED_STATE: ToolbarActiveState = {
    marks: {
        bold: false,
        italic: false,
        strikethrough: false,
        highlight: false,
        inlineCode: false,
        link: false,
    },
    headingLevel: 0,
    formatApplicable: false,
    list: null,
    quote: null,
    code: null,
    inTable: false,
    wikiLink: false,
    inlineMath: false,
    imageSelected: false,
};

export function computeToolbarActiveState(state: EditorState): ToolbarActiveState {
    const { selection } = state;
    const { $from } = selection;

    // A node-selected inline atom (wikilink / inline math) or image is what
    // clicking the rendered node — or arrowing onto it — produces. These aren't
    // marks and aren't ancestors of the caret, so they're read straight off the
    // selection rather than the ancestor walk below.
    const selectedNode = selection instanceof NodeSelection ? selection.node : null;
    const selectedName = selectedNode?.type.name ?? null;

    let headingLevel = 0;
    let list: ListKind | null = null;
    let quote: QuoteKind | null = null;
    let code: CodeKind | null = null;
    let inTable = false;
    let inCodeBlock = false;
    let inMathSource = false;

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
        } else if (name === "math_inline") {
            // Caret inside a formula's revealed source (math_inline holds its
            // LaTeX as text content — mathInlineEdit.ts).
            inMathSource = true;
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
        // A selected atom/image or a caret inside math source isn't a
        // heading-capable textblock, so the format control greys to "—" there
        // too (the table-cell / code-block treatment).
        formatApplicable:
            !inTable && !inCodeBlock && !inMathSource &&
            (selectedNode === null || selectedNode.isTextblock),
        list,
        quote,
        code,
        inTable,
        wikiLink: selectedName === "wiki_link",
        // Node-selected (click/drag) OR caret inside the revealed source.
        inlineMath: selectedName === "math_inline" || inMathSource,
        imageSelected: selectedName === "image",
    };
}
