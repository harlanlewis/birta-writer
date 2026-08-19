/**
 * webview/agentContext.ts
 *
 * Produces the canonical selection context (shared/agentContext.ts) from the
 * live ProseMirror view, for the coding-agent bridge on the extension side
 * (src/agentBridge/). This is the one place the webview maps its selection into
 * document coordinates for an external consumer.
 *
 * Pull-only: it is called only when an agent asks (never on the editor's own
 * selection-change path), it walks only the two blocks the anchor and head sit
 * in via the existing block-level source-caret machinery
 * (webview/utils/sourceCaret.ts), and it reads the cached `lineMap` and the
 * cached markdown source (split into lines per call, the same pattern as the
 * mode-switch caret) — it never serializes the document.
 */

import type { EditorView } from "./pm";
import type { DocSelection, EditorSelectionContext } from "../shared/agentContext";
import { sourceEndOfBlock, sourceSelectionEnds } from "./utils/sourceCaret";

/**
 * Build the selection context, or null when the position can't be placed (an
 * empty line map before the first sync).
 *
 * `lineOffset` is how many source lines the frontmatter occupies; it converts
 * the BODY lines the source mapping returns into the DOCUMENT lines every
 * consumer expects — the same conversion the mode-switch caret handoff makes.
 * The mapping itself is shared with that handoff (sourceSelectionEnds), so a
 * block-range selection reports whole source lines here too instead of
 * spilling into the neighbouring block.
 */
export function buildSelectionContext(
    view: EditorView,
    lineMap: number[],
    sourceLines: string[],
    lineOffset: number,
): EditorSelectionContext | null {
    const { doc, selection } = view.state;
    const span = outerSpan(selection);
    const ends = emptyParagraphCaret(view, lineMap, sourceLines)
        ?? sourceSelectionEnds(doc, lineMap, sourceLines, span);
    if (!ends) { return null; }
    const { anchor, head: active } = ends;

    // Plain text of the selection (markup stripped, same extraction as the word
    // counter); the line span carries the precise source pointer.
    const text = span.empty
        ? ""
        : doc.textBetween(span.from, span.to, "\n", "\n");

    const sel: DocSelection = {
        anchor: { line: anchor.line + lineOffset, column: anchor.column },
        active: { line: active.line + lineOffset, column: active.column },
        text,
    };
    return { selections: [sel], primary: 0, isEmpty: span.empty };
}

/**
 * The selection's OUTER span: the lowest start and the highest end across
 * every range it holds, with `anchor`/`head` kept so direction survives.
 *
 * A `Selection`'s own `from`/`to` are its FIRST range's. For a text run or a
 * block range that IS the whole selection, so this is the identity. A table
 * `CellSelection` holds one range PER CELL, and a reference to it answered
 * with the first range names a single cell: a column dragged down four rows
 * reported one row, and the quoted text was one cell's. What the writer
 * selected is what the agent has to be pointed at.
 */
function outerSpan(selection: {
    ranges: readonly { $from: { pos: number }; $to: { pos: number } }[];
    anchor: number;
    head: number;
}): { from: number; to: number; anchor: number; head: number; empty: boolean } {
    let from = Infinity;
    let to = -Infinity;
    for (const range of selection.ranges) {
        from = Math.min(from, range.$from.pos);
        to = Math.max(to, range.$to.pos);
    }
    // A selection always has at least one range; the guard is for a stand-in
    // with none rather than for anything the editor produces.
    if (from > to) { return { from: selection.anchor, to: selection.head, anchor: selection.anchor, head: selection.head, empty: true }; }
    // Direction is the selection's own, not the span's: which END the caret is
    // at is what tells a consumer where the writer was reading from.
    const forward = selection.head >= selection.anchor;
    return {
        from,
        to,
        anchor: forward ? from : to,
        head: forward ? to : from,
        empty: from === to,
    };
}

/**
 * A caret in an EMPTY top-level paragraph below other content: Enter for a
 * fresh line, then `/ai <request>` on it (MAR-376). An empty paragraph
 * serializes to nothing, so the block-index line map has no line for it and
 * the generic mapping names whatever block FOLLOWS. What the writer means is
 * the blank line after the block before it: the separator every block pair
 * has in the source, or one past the last line when the paragraph ends the
 * document. Either way it is the line an agent inserts at. Undefined
 * (defer to the generic mapping) for anything else.
 */
function emptyParagraphCaret(
    view: EditorView,
    lineMap: number[],
    sourceLines: string[],
): { anchor: { line: number; column: number }; head: { line: number; column: number } } | undefined {
    const { doc, selection } = view.state;
    if (!selection.empty || !lineMap.length) { return undefined; }
    const $head = doc.resolve(selection.head);
    if ($head.depth !== 1) { return undefined; }
    const block = $head.parent;
    if (!block.isTextblock || block.content.size !== 0) { return undefined; }
    // Two Enters make two empty paragraphs; the block "before" is the last
    // one that has any source at all.
    let index = $head.index(0);
    while (index > 0 && doc.child(index - 1).isTextblock && doc.child(index - 1).content.size === 0) { index--; }
    if (index === 0) { return undefined; }
    const before = sourceEndOfBlock(doc, lineMap, sourceLines, index - 1);
    if (!before) { return undefined; }
    const caret = { line: before.line + 1, column: 0 };
    return { anchor: caret, head: caret };
}
