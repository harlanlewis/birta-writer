/**
 * plugins/blockKeys.ts
 *
 * The block-level keyboard model (MAR-22 move keys + MAR-82's keyboard
 * remainder), built on the same cover machinery the gutter uses — so the
 * keyboard, the marquee, and the drag handles all speak one selection
 * language:
 *
 *   - Escape        caret → select the caret's whole top-level block;
 *                   a block-spanning selection → back to a caret (toggle).
 *                   (The Notion/Editor.js chord. Bound LAST so every popup's
 *                   own capture-phase Escape wins first.)
 *   - Shift+↑/↓     with a block-spanning selection, extend/shrink it one
 *                   block at a time (never intercepts normal text selection).
 *   - Alt+↑/↓ and   move the covered blocks (or the caret's block) one unit
 *   Cmd+Shift+↑/↓   — the menu's Move rows and the drag handle share the
 *                   exact same moveBlockTo, so fold state, the landing
 *                   flash, and single-step undo all apply.
 *
 * Commands are exported for direct unit testing; the keymap is thin wiring.
 */
import { keymap } from "@milkdown/prose/keymap";
import { TextSelection, type EditorState, type Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import { moveBlockAt, moveBlockTo } from "../components/blockMenu";
import { selectionCoverRange } from "../components/blockMenu/drag";

type Command = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => boolean;

/** The top-level block containing `pos`: [start, end) or null at doc edges. */
function blockAt(state: EditorState, pos: number): { from: number; to: number } | null {
    const $pos = state.doc.resolve(pos);
    if ($pos.depth === 0) {
        const after = $pos.nodeAfter;
        return after ? { from: pos, to: pos + after.nodeSize } : null;
    }
    return { from: $pos.before(1), to: $pos.after(1) };
}

/**
 * True when the selection spans WHOLE top-level blocks (the state Escape and
 * the marquee produce) — the gate that keeps Shift+arrows' normal text
 * behavior untouched.
 */
export function isBlockSpanning(state: EditorState): boolean {
    const sel = state.selection;
    if (sel.empty) {
        return false;
    }
    const first = blockAt(state, sel.from);
    const last = blockAt(state, sel.to);
    if (!first || !last) {
        return false;
    }
    // Snapped-to-text spans: from at the first block's first text position,
    // to at the last block's last one.
    const $start = state.doc.resolve(Math.min(first.from + 1, state.doc.content.size));
    const $end = state.doc.resolve(Math.max(0, last.to - 1));
    const span = TextSelection.between($start, $end);
    return sel.from <= span.from && sel.to >= span.to;
}

/** Escape: caret ↔ whole-block selection toggle. */
export const toggleBlockSelection: Command = (state, dispatch) => {
    const sel = state.selection;
    if (isBlockSpanning(state)) {
        // Back to a caret at the start of the (first) selected block.
        if (dispatch) {
            dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(sel.from))));
        }
        return true;
    }
    if (!sel.empty) {
        return false; // a partial text selection keeps its own Escape meaning
    }
    const block = blockAt(state, sel.from);
    if (!block) {
        return false;
    }
    const $from = state.doc.resolve(Math.min(block.from + 1, state.doc.content.size));
    const $to = state.doc.resolve(Math.max(0, block.to - 1));
    const span = TextSelection.between($from, $to);
    if (span.empty) {
        return false; // leaf-ish block with no text — nothing to show
    }
    if (dispatch) {
        dispatch(state.tr.setSelection(span));
    }
    return true;
};

/** Shift+↑/↓ on a block-spanning selection: grow/shrink one block. */
export function extendBlockSelection(dir: -1 | 1): Command {
    return (state, dispatch) => {
        if (!isBlockSpanning(state)) {
            return false;
        }
        const sel = state.selection;
        const first = blockAt(state, sel.from)!;
        const last = blockAt(state, sel.to)!;
        let from = first.from;
        let to = last.to;
        if (dir === 1) {
            const next = blockAt(state, last.to);
            if (next) {
                to = next.to;
            } else if (first.from !== last.from) {
                from = blockAt(state, first.to)?.from ?? from; // shrink from top
            } else {
                return true; // single block at doc end — nothing to do
            }
        } else {
            const $first = state.doc.resolve(first.from);
            const prev = $first.nodeBefore ? { from: first.from - $first.nodeBefore.nodeSize } : null;
            if (prev) {
                from = prev.from;
            } else if (first.from !== last.from) {
                const $last = state.doc.resolve(last.from);
                to = $last.pos; // shrink from bottom
            } else {
                return true;
            }
        }
        if (dispatch) {
            const $from = state.doc.resolve(Math.min(from + 1, state.doc.content.size));
            const $to = state.doc.resolve(Math.max(0, to - 1));
            dispatch(state.tr.setSelection(TextSelection.between($from, $to)));
        }
        return true;
    };
}

/** Alt+↑/↓ / Cmd+Shift+↑/↓: move the covered blocks (or the caret's block). */
export function moveSelectedBlocks(dir: -1 | 1): Command {
    return (state, dispatch, view) => {
        if (!view || !dispatch) {
            return false;
        }
        const cover = selectionCoverRange(view);
        if (cover) {
            let target: number | null;
            if (dir === -1) {
                const before = state.doc.resolve(cover.from).nodeBefore;
                target = before ? cover.from - before.nodeSize : null;
            } else {
                target = blockAt(state, cover.to)?.to ?? null;
            }
            if (target === null) {
                return true; // at a document edge — consume, no-op
            }
            return moveBlockTo(view, cover, target, { selectRun: true });
        }
        // Single block (caret or Esc-selected): moveBlockAt carries heading
        // sections and hops neighboring units, exactly like the menu rows.
        const block = blockAt(state, state.selection.from);
        if (!block) {
            return false;
        }
        moveBlockAt(view, block.from, dir);
        return true;
    };
}

export const blockKeysPlugin = $prose(() =>
    keymap({
        "Escape": toggleBlockSelection,
        "Shift-ArrowDown": extendBlockSelection(1),
        "Shift-ArrowUp": extendBlockSelection(-1),
        "Alt-ArrowDown": moveSelectedBlocks(1),
        "Alt-ArrowUp": moveSelectedBlocks(-1),
        "Mod-Shift-ArrowDown": moveSelectedBlocks(1),
        "Mod-Shift-ArrowUp": moveSelectedBlocks(-1),
    }),
);
