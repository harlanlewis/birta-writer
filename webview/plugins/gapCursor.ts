/**
 * plugins/gapCursor.ts — the caret for positions no text selection can hold
 * (MAR-252).
 *
 * A block leaf (table, fenced code block, horizontal rule) has no text position
 * before or after it when it is the document's first/last child, or when it
 * abuts another leaf. Without a gap cursor those positions do not exist as far
 * as the editor is concerned, and the observable result is not "nothing
 * happens" — it is the caret landing INSIDE the neighbouring leaf, so the next
 * keystroke edits a block the user did not aim at: typing above a leading table
 * went into its first header cell, below a trailing table into its last cell,
 * and out of one table into the next table's header.
 *
 * `prosemirror-gapcursor` is the standard remedy: it adds a valid selection at
 * exactly those positions and captures the clicks and arrow keys that should
 * reach them. No new dependency — `@milkdown/prose` re-exports it.
 *
 * Two pieces ship here because the stock plugin alone does not cover the
 * document shapes above; both were verified against the real bundle in
 * `e2e/gapCursor/`.
 *
 * ── 1. gapCursorPlugin — the stock plugin, registered LATE ──────────────────
 * After every narrowly-guarded key handler (math boundary keys, table nav, fold
 * reveals, block keys, embed-card arrows), because those each answer a specific
 * question about the caret's current block and decline otherwise, while this is
 * the general "there is nowhere else to go" fallback. It brings the caret
 * widget, click-to-gap, `createSelectionBetween`, the IME hack, and arrow
 * handling from an existing gap cursor.
 *
 * ── 2. blockEdgeGapCursorKeymapPlugin — vertical arrows, registered EARLY ───
 * The stock plugin's own arrow handler cannot win the two cases that matter:
 *
 *   - `prosemirror-tables` (registered by the GFM preset, so it is asked first)
 *     resolves a table-edge arrow with `Selection.near(<just outside the
 *     table>)`, and `Selection.near` knows nothing about gap cursors — it walks
 *     on to the nearest TEXT position. Where that walk finds nothing the
 *     handler declines as a no-op and the stock plugin picks the key up; where
 *     it finds something the handler succeeds, so ArrowDown out of a table
 *     followed by another table lands in the second table's header cell.
 *   - It never fires for a code block at all (measured). The stock handler
 *     gates on `view.endOfTextblock()`, a layout probe that measures the
 *     textblock's DOM children against the caret's coords to decide whether
 *     another line lies that way — and the code-block NodeView's DOM is not the
 *     plain textblock the probe assumes (toolbar row, line-number gutter,
 *     highlighted spans), so it does not answer for one.
 *
 * So this keymap answers the same question from the MODEL instead, and is
 * registered before the presets. It is deliberately strict and declines
 * everywhere it is unsure — a decline just falls through to the handlers that
 * work today:
 *
 *   - the selection must be a caret at the very first/last position of its own
 *     textblock (mid-block arrows are line navigation and are none of its
 *     business);
 *   - out of a table it steps over the WHOLE table, and only from the table's
 *     first/last row — anywhere else the arrow is cell-to-cell navigation that
 *     prosemirror-tables owns;
 *   - and a gap cursor must actually be valid at the position it would land on.
 *     That last test is what keeps ordinary navigation intact: with a paragraph
 *     on the other side there is no gap, so the key falls through unchanged.
 *
 * What this deliberately does NOT change: a single ArrowDown from a paragraph
 * onto a following horizontal rule still resolves to a `NodeSelection` on the
 * rule, because the position between a paragraph and an hr is not a gap (the
 * paragraph's own text position is adjacent) and `isGapCursorPosition` rejects
 * it.
 * That is stock ProseMirror behaviour and is tracked separately.
 *
 * The caret is drawn by a widget decoration with class `.ProseMirror-gapcursor`;
 * it is themed in `webview/style.css` rather than by importing the package's
 * own stylesheet, which hardcodes a black caret.
 */
import { $prose } from "@milkdown/utils";
import {
    GapCursor,
    TextSelection,
    gapCursor,
    isGapCursorPosition,
    keymap,
    type Command,
} from "../pm";

export const gapCursorPlugin = $prose(() => gapCursor());

/**
 * Step out of the caret's block (or its enclosing table) onto a gap cursor,
 * when the position on the other side is one. See the header for the guards.
 */
function blockEdgeGapCursor(dir: 1 | -1): Command {
    return (state, dispatch) => {
        const sel = state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty) {
            return false;
        }
        const $pos = sel.$head;
        if (!$pos.parent.isTextblock) {
            return false;
        }
        // The very first / last position of the textblock, model-wise.
        if (dir > 0 ? $pos.parentOffset < $pos.parent.content.size : $pos.parentOffset > 0) {
            return false;
        }
        // What to step over: the innermost enclosing table if there is one (a
        // caret at a cell's edge is not at the TABLE's edge), else the caret's
        // own textblock. GFM cells hold a single paragraph, so a cell edge in
        // the first/last row is a table edge.
        let depth = $pos.depth;
        for (let d = $pos.depth - 1; d > 0; d--) {
            const node = $pos.node(d);
            if (node.type.name !== "table") {
                continue;
            }
            if (dir > 0 ? $pos.index(d) < node.childCount - 1 : $pos.index(d) > 0) {
                return false; // not the table's first/last row
            }
            depth = d;
            break;
        }
        const $outside = state.doc.resolve(dir > 0 ? $pos.after(depth) : $pos.before(depth));
        if (!isGapCursorPosition($outside)) {
            return false;
        }
        dispatch?.(state.tr.setSelection(new GapCursor($outside)).scrollIntoView());
        return true;
    };
}

export const blockEdgeGapCursorKeymapPlugin = $prose(() =>
    keymap({
        ArrowUp: blockEdgeGapCursor(-1),
        ArrowDown: blockEdgeGapCursor(1),
    }),
);
