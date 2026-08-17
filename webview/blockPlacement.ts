/**
 * webview/blockPlacement.ts
 *
 * "Can this command's block land HERE?" — the contextual half of conversion
 * legality (MAR-115), sibling to webview/blockCapabilities.ts.
 *
 * blockCapabilities answers a question about two node TYPES ("can a callout
 * become a quote"). This module answers a question about a POSITION: the
 * caret sits inside a table cell, a list item, a footnote definition, and the
 * surface has to know whether the row it is about to offer would do anything.
 * Both halves are needed, and only this one has to consult the live schema.
 *
 * Two facts combine, and neither is guessed:
 *
 *   1. What the command puts in the document, and HOW — COMMAND_BLOCK_REACH,
 *      a `Record<EditorCommandId, BlockReach>`, so a new editor command fails
 *      to compile until someone says (the webview/readOnly.ts idiom, and the
 *      same reason: a surface rule that is an omission rather than a decision
 *      is what MAR-109 was written about).
 *   2. Whether the schema admits that node there — `canPlaceBlock`, a walk
 *      out from the caret's own block. No node-type list, no per-surface
 *      blocklist: the walk reads `content` expressions and `isolating`, so a
 *      new node type is covered on the day its schema lands.
 *
 * Why the three reaches differ, which is the whole content of the module:
 *
 *   retype — the command replaces the caret's own block (a heading, a list, a
 *     fence). Its structural machinery can lift out of a list item, so the
 *     walk continues outward past ancestors that refuse the type; it cannot
 *     climb out of an `isolating` node, which is ProseMirror's own word for a
 *     boundary structure does not cross, so the walk stops there.
 *   wrap — the command adds a level AROUND the outermost block range it can
 *     reach (editing/wrapBlocks). It never dismantles the ancestor it escapes,
 *     so `isolating` does not stop it: a quote picked from inside a table cell
 *     legitimately quotes the whole table, which is shipped behavior
 *     (webview/__tests__/quoteAnyBlock.test.ts).
 *   insert — the command drops a sibling next to the caret's block. Its reach
 *     is exactly the caret's own parent: a divider picked from inside a cell
 *     would land after the entire table, which reads as an accident rather
 *     than an insertion, so a parent that cannot hold the node is the answer.
 *
 * No runtime imports. Every conversion surface reaches this module, including
 * plugins/slashMenu.ts, which cannot import editorCommands.ts or
 * blockCapabilities.ts without a cycle.
 */
import type { EditorCommandId } from "../shared/editorCommands";
import type { ResolvedPos } from "./pm";

/**
 * What a command puts into the document, and how far its mechanism reaches.
 * `none` is the answer for every command that edits marks, moves blocks,
 * drives chrome, or touches nothing at all.
 */
export type BlockReach =
    | { readonly effect: "retype"; readonly type: string }
    | { readonly effect: "wrap"; readonly type: string }
    | { readonly effect: "insert"; readonly type: string }
    | { readonly effect: "none" };

const NONE: BlockReach = { effect: "none" };

/**
 * Every editor command, classified. Exhaustive by construction: the type is
 * `Record<EditorCommandId, BlockReach>`, so a new command in
 * shared/editorCommands.ts is a compile error until it is classified, and
 * blockPlacement.test.ts asserts the partition's size against the shared
 * command list rather than trusting it.
 *
 * `none` is the honest default for anything that does not place a block node:
 * offering such a row is never a structural mistake, so nothing here filters
 * it. Reach for one of the other three only when the command's result is a
 * block node the schema can refuse.
 */
export const COMMAND_BLOCK_REACH: Record<EditorCommandId, BlockReach> = {
    // ── Inline marks ────────────────────────────────────────────────────────
    toggleBold: NONE,
    toggleItalic: NONE,
    toggleStrikethrough: NONE,
    toggleHighlight: NONE,
    toggleInlineCode: NONE,
    clearFormatting: NONE,

    // ── Block type: retype the caret's own block ────────────────────────────
    setParagraph: { effect: "retype", type: "paragraph" },
    setHeading1: { effect: "retype", type: "heading" },
    setHeading2: { effect: "retype", type: "heading" },
    setHeading3: { effect: "retype", type: "heading" },
    setHeading4: { effect: "retype", type: "heading" },
    setHeading5: { effect: "retype", type: "heading" },
    setHeading6: { effect: "retype", type: "heading" },
    // A task list is a bullet list whose items carry `checked`, so all three
    // list rows stand or fall on the same two node types.
    toggleBulletList: { effect: "retype", type: "bullet_list" },
    toggleOrderedList: { effect: "retype", type: "ordered_list" },
    toggleTaskList: { effect: "retype", type: "bullet_list" },
    // The fence rows (plain, Mermaid, Math Block, Calculation Block) all run
    // insertCodeBlock with a different language arg; the placement question is
    // the same for every one of them.
    insertCodeBlock: { effect: "retype", type: "code_block" },

    // ── Block type: wrap the outermost reachable range ──────────────────────
    toggleBlockquote: { effect: "wrap", type: "blockquote" },
    insertCallout: { effect: "wrap", type: "callout" },
    toggleCallout: { effect: "wrap", type: "callout" },

    // ── Block type: insert a sibling ────────────────────────────────────────
    insertHorizontalRule: { effect: "insert", type: "hr" },
    insertTable: { effect: "insert", type: "table" },

    // ── Inline inserts: an inline node or a host panel, never a block ───────
    insertLink: NONE,
    insertSectionLink: NONE,
    insertImage: NONE,
    insertMath: NONE,
    insertFootnote: NONE,
    openLink: NONE,
    editBlockSource: NONE,

    // ── Find ────────────────────────────────────────────────────────────────
    openFind: NONE,
    openFindReplace: NONE,
    findNext: NONE,
    findPrevious: NONE,
    findSelection: NONE,
    selectAllOccurrences: NONE,

    // ── Document chrome and panels ──────────────────────────────────────────
    toggleToc: NONE,
    editFrontmatter: NONE,
    swapTocSide: NONE,
    focusReviewSidebar: NONE,

    // ── Table cell operations (already scoped to a live table) ──────────────
    tableInsertRowAbove: NONE,
    tableInsertRowBelow: NONE,
    tableInsertColumnLeft: NONE,
    tableInsertColumnRight: NONE,
    tableAlignColumnLeft: NONE,
    tableAlignColumnCenter: NONE,
    tableAlignColumnRight: NONE,
    tableDeleteRow: NONE,
    tableDeleteColumn: NONE,
    tableDeleteTable: NONE,

    // ── Clipboard ───────────────────────────────────────────────────────────
    copyAsHtml: NONE,
    copyAsMarkdown: NONE,
    copyAsRichText: NONE,
    pasteAsPlainText: NONE,

    // ── Editor and host chrome ──────────────────────────────────────────────
    editRawMarkdown: NONE,
    customizeToolbar: NONE,
    hideToolbar: NONE,
    showToolbar: NONE,
    toggleToolbar: NONE,
    openShortcutsHelp: NONE,
    openKeyboardShortcuts: NONE,
    openExtensionSettings: NONE,
    openWhatsNew: NONE,
    toggleReadOnly: NONE,

    // ── Typography preferences ──────────────────────────────────────────────
    fontEditor: NONE,
    fontSans: NONE,
    fontSerif: NONE,
    fontMono: NONE,
    increaseFontSize: NONE,
    decreaseFontSize: NONE,

    // ── Proofreading toggles ────────────────────────────────────────────────
    toggleSpellCheck: NONE,
    toggleGrammarCheck: NONE,
    toggleStyleCheck: NONE,
    toggleNoteHighlights: NONE,

    // ── Block moves and edits: they carry an existing block, never make one ─
    duplicateBlockUp: NONE,
    duplicateBlockDown: NONE,
    moveBlockUp: NONE,
    moveBlockDown: NONE,
    indentBlock: NONE,
    outdentBlock: NONE,
    deleteBlock: NONE,
    joinLines: NONE,
    openBlockMenu: NONE,
    // A new paragraph goes where the caret's own paragraph already is, so the
    // schema can never refuse it.
    insertParagraphAfter: NONE,
    insertParagraphBefore: NONE,
    uncheckAllTasks: NONE,

    // ── Selection and case ──────────────────────────────────────────────────
    transformToUppercase: NONE,
    transformToLowercase: NONE,
    transformToTitleCase: NONE,
    expandSelection: NONE,
    shrinkSelection: NONE,

    // ── Folding (plugin state and decorations, never a doc change) ──────────
    fold: NONE,
    unfold: NONE,
    foldAll: NONE,
    unfoldAll: NONE,
    foldLevel1: NONE,
    foldLevel2: NONE,
    foldLevel3: NONE,
    foldLevel4: NONE,
    foldLevel5: NONE,
    foldLevel6: NONE,
    foldLevel7: NONE,
};

/**
 * The depth of the caret's innermost BLOCK ancestor. Usually `$pos.depth`
 * (the caret sits in a paragraph); less when the caret is inside an inline
 * node's revealed source, where `$pos.parent` is `math_inline` or `wiki_link`
 * and the block the surfaces mean is the paragraph holding it.
 */
function blockDepth($pos: ResolvedPos): number {
    for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).isBlock) {
            return depth;
        }
    }
    return 0;
}

/**
 * Whether a node of `typeName` can land at `$pos` under the given reach.
 * A schema the type is absent from answers false: an unregistered node can
 * never be placed, so the row is dead wherever the plugin is not loaded.
 */
export function canPlaceBlock($pos: ResolvedPos, reach: BlockReach): boolean {
    if (reach.effect === "none") {
        return true;
    }
    const type = $pos.parent.type.schema.nodes[reach.type];
    if (!type) {
        return false;
    }
    const start = blockDepth($pos);
    if (reach.effect === "insert") {
        // A sibling of the caret's own block, in the caret's own parent.
        if (start === 0) {
            return false; // the caret's block IS the doc; nothing to sit beside
        }
        const parent = $pos.node(start - 1);
        const index = $pos.index(start - 1) + 1;
        return parent.canReplaceWith(index, index, type);
    }
    // A verbatim block's content is uninterpreted text, so no structural
    // retype carries it anywhere: the bytes inside a fence are not prose that
    // can become a heading or a list. Same fact the capability registry
    // spells `code_block.source: false`, read here off the schema so this
    // module stays import-free. A WRAP is unaffected — a fence goes inside a
    // quote whole.
    if (reach.effect === "retype" && $pos.node(start).type.spec.code) {
        return false;
    }
    // retype and wrap walk outward from the caret's block. They differ only in
    // where they stop: a retype cannot cross an isolating boundary, a wrap
    // encloses it.
    for (let depth = start - 1; depth >= 0; depth--) {
        const parent = $pos.node(depth);
        const index = $pos.index(depth);
        if (parent.canReplaceWith(index, index + 1, type)) {
            return true;
        }
        if (reach.effect === "retype" && parent.type.spec.isolating) {
            return false;
        }
    }
    return false;
}

/** Whether the command's block can land at `$pos`. */
export function canPlaceCommandBlock($pos: ResolvedPos, id: EditorCommandId): boolean {
    return canPlaceBlock($pos, COMMAND_BLOCK_REACH[id]);
}
