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
import { sourceSelectionEnds } from "./utils/sourceCaret";

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
    const ends = sourceSelectionEnds(doc, lineMap, sourceLines, selection);
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
