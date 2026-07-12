/**
 * plugins/blockKeys.ts
 *
 * The block-level keyboard model (MAR-22 move keys + MAR-82's keyboard
 * layer), built on BlockRangeSelection — the same selection the marquee
 * commits and the drag handles read, so the keyboard, the marquee, and the
 * gutter grabbers all speak one selection language:
 *
 *   - Escape        escalate: a caret, text selection, or node selection
 *                   becomes a block range over the block(s) it touches; a
 *                   block range collapses back to a caret. (Every popup's
 *                   own capture-phase Escape wins first.)
 *   - Shift+↑/↓     grow/shrink a block range one block at a time, honoring
 *                   the anchor direction. Never touches a plain text
 *                   selection — those keep native character extension.
 *   - Mod+A         the Notion ladder: in-block text → the block → every
 *                   block. Tables and code blocks keep their own semantics
 *                   (tables bail to native; codeBlockSelectAll's capture
 *                   handler preempts inside fences).
 *   - Alt+↑/↓ and   move the selected block range (staying selected) or the
 *   Cmd+Shift+↑/↓   caret's block (headings carry their section) — the same
 *                   moveBlockTo the menu and drag use, so fold state, the
 *                   landing flash, and single-step undo all apply.
 *
 * Commands are exported for direct unit testing; the keymap is thin wiring.
 * ProseMirror's baseKeymap is appended AFTER user plugins by Milkdown core,
 * so these bindings run first and fall through (return false) cleanly.
 */
import { keymap } from "@milkdown/prose/keymap";
import { Selection, TextSelection, type EditorState, type Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import { moveBlockAt, moveBlockTo } from "../components/blockMenu";
import { selectionCoverRange } from "../components/blockMenu/drag";
import { BlockRangeSelection } from "./blockRange";

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
 * True when the selection covers WHOLE top-level blocks — a real
 * BlockRangeSelection, or a text selection that happens to span them (the
 * shape keyboard-selecting from block start to block end produces).
 */
export function isBlockSpanning(state: EditorState): boolean {
    const sel = state.selection;
    if (sel instanceof BlockRangeSelection) {
        return true;
    }
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

/**
 * Escape: escalate to a block range, or collapse one back to a caret.
 * Works on empty paragraphs and leaf blocks too — a block range needs no
 * text to select.
 */
export const toggleBlockSelection: Command = (state, dispatch) => {
    const sel = state.selection;
    if (sel instanceof BlockRangeSelection) {
        if (dispatch) {
            dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(sel.from), 1)));
        }
        return true;
    }
    const range = BlockRangeSelection.tryCreate(state.doc, sel.from, sel.to);
    if (!range) {
        return false;
    }
    if (dispatch) {
        dispatch(state.tr.setSelection(range));
    }
    return true;
};

/**
 * Shift+↑/↓ on a block range: move the HEAD one block, anchor fixed — a
 * downward-grown range shrinks from the bottom, an upward-grown one from
 * the top, like character-level shift-selection; a single-block range
 * pressed the other way flips around its block (which always stays
 * selected, the Notion contract). A block-spanning text selection is
 * promoted first (keeping its direction); a plain text selection falls
 * through untouched.
 */
export function extendBlockSelection(dir: -1 | 1): Command {
    return (state, dispatch) => {
        const sel = state.selection;
        let range: BlockRangeSelection | null = null;
        if (sel instanceof BlockRangeSelection) {
            range = sel;
        } else if (!sel.empty && isBlockSpanning(state)) {
            range = BlockRangeSelection.tryCreate(state.doc, sel.anchor, sel.head);
        }
        if (!range) {
            return false;
        }
        const { doc } = state;
        let { anchor, head } = range;
        const backward = head < anchor;
        if (!backward) {
            // Head at the range's end boundary.
            const $head = doc.resolve(head);
            if (dir === 1) {
                if (!$head.nodeAfter) {
                    return true; // doc end — consume, no change
                }
                head += $head.nodeAfter.nodeSize;
            } else {
                const shrunk = $head.nodeBefore ? head - $head.nodeBefore.nodeSize : head;
                if (shrunk > anchor) {
                    head = shrunk;
                } else {
                    // One block left and shift points the other way: FLIP
                    // around the anchor block (it always stays selected) —
                    // the range grows upward from its start instead.
                    const $from = doc.resolve(range.from);
                    if (!$from.nodeBefore) {
                        return true;
                    }
                    anchor = range.to;
                    head = range.from - $from.nodeBefore.nodeSize;
                }
            }
        } else {
            // Head at the range's start boundary.
            const $head = doc.resolve(head);
            if (dir === -1) {
                if (!$head.nodeBefore) {
                    return true;
                }
                head -= $head.nodeBefore.nodeSize;
            } else {
                const shrunk = $head.nodeAfter ? head + $head.nodeAfter.nodeSize : head;
                if (shrunk < anchor) {
                    head = shrunk;
                } else {
                    // Mirror flip: grow downward from the range's end.
                    const $to = doc.resolve(range.to);
                    if (!$to.nodeAfter) {
                        return true;
                    }
                    anchor = range.from;
                    head = range.to + $to.nodeAfter.nodeSize;
                }
            }
        }
        if (dispatch) {
            dispatch(state.tr.setSelection(
                new BlockRangeSelection(doc.resolve(anchor), doc.resolve(head)),
            ));
        }
        return true;
    };
}

/**
 * Mod+A escalation (the Notion ladder): select the caret's block text →
 * the block itself → every block. Bails to native select-all inside
 * tables (cell semantics belong to the table plugin); code blocks never
 * reach here (codeBlockSelectAll intercepts at document capture).
 */
export const escalateSelectAll: Command = (state, dispatch) => {
    const sel = state.selection;
    const { doc } = state;
    for (let depth = sel.$from.depth; depth > 0; depth--) {
        if (sel.$from.node(depth).type.name === "table") {
            return false;
        }
    }
    const all = BlockRangeSelection.tryCreate(doc, 0, doc.content.size);
    if (!all) {
        return false;
    }
    if (sel instanceof BlockRangeSelection) {
        if (!sel.eq(all) && dispatch) {
            dispatch(state.tr.setSelection(all));
        }
        return true; // already everything — consume, stable
    }
    const first = blockAt(state, sel.from);
    const last = blockAt(state, sel.to);
    if (!first || !last) {
        return false;
    }
    if (first.from !== last.from) {
        // Already spanning blocks — go straight to everything.
        if (dispatch) {
            dispatch(state.tr.setSelection(all));
        }
        return true;
    }
    // One block: select its text; if that's already selected (or it has
    // none), step up to the block itself.
    const $start = doc.resolve(Math.min(first.from + 1, doc.content.size));
    const $end = doc.resolve(Math.max(0, first.to - 1));
    const blockText = TextSelection.between($start, $end);
    const hasAllText = blockText.empty || (sel.from <= blockText.from && sel.to >= blockText.to);
    if (dispatch) {
        dispatch(state.tr.setSelection(
            hasAllText
                ? (BlockRangeSelection.tryCreate(doc, first.from, first.to) ?? all)
                : blockText,
        ));
    }
    return true;
};

/** Alt+↑/↓ / Cmd+Shift+↑/↓: move the covered blocks (or the caret's block). */
export function moveSelectedBlocks(dir: -1 | 1): Command {
    return (state, dispatch, view) => {
        if (!view || !dispatch) {
            return false;
        }
        // An explicit selection moves exactly what it covers (a selected
        // heading moves alone); only a bare caret gets unit semantics.
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
        // Bare caret in a list: move the ITEM among its siblings (innermost
        // item wins for nesting), never the whole list.
        const $from = state.selection.$from;
        for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name === "list_item") {
                moveBlockAt(view, $from.before(depth), dir);
                return true;
            }
        }
        // Bare caret elsewhere: moveBlockAt carries heading sections and
        // hops neighboring units, exactly like the menu rows.
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
        "Mod-a": escalateSelectAll,
        "Alt-ArrowDown": moveSelectedBlocks(1),
        "Alt-ArrowUp": moveSelectedBlocks(-1),
        "Mod-Shift-ArrowDown": moveSelectedBlocks(1),
        "Mod-Shift-ArrowUp": moveSelectedBlocks(-1),
    }),
);
