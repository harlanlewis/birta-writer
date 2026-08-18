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
    const ends = emptyParagraphCaret(view, lineMap, sourceLines)
        ?? sourceSelectionEnds(doc, lineMap, sourceLines, selection);
    if (!ends) { return null; }
    const { anchor, head: active } = ends;

    // Plain text of the selection (markup stripped, same extraction as the word
    // counter); the line span carries the precise source pointer.
    const text = selection.empty
        ? ""
        : doc.textBetween(selection.from, selection.to, "\n", "\n");

    const sel: DocSelection = {
        anchor: { line: anchor.line + lineOffset, column: anchor.column },
        active: { line: active.line + lineOffset, column: active.column },
        text,
    };
    return { selections: [sel], primary: 0, isEmpty: selection.empty };
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
    const index = $head.index(0);
    if (index === 0) { return undefined; }
    const before = sourceEndOfBlock(doc, lineMap, sourceLines, index - 1);
    if (!before) { return undefined; }
    const caret = { line: before.line + 1, column: 0 };
    return { anchor: caret, head: caret };
}
