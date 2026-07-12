/**
 * plugins/blockKeys.ts
 *
 * The block-level keyboard model (MAR-22 move keys + MAR-82's keyboard
 * layer), built on BlockRangeSelection — the same selection the marquee
 * commits and the drag handles read, so the keyboard, the marquee, and the
 * gutter grabbers all speak one selection language:
 *
 *   - Escape        FIRST closes the topmost open transient surface (find
 *                   bar, pinned link popup, hover menu, lightbox — the
 *                   ui/escapeLayers.ts stack), consuming the key. Only with
 *                   no surface open does it escalate: a caret, text
 *                   selection, or node selection becomes a block range over
 *                   the block(s) it touches; a block range collapses back
 *                   to a caret. (Popups that claim Escape at capture phase
 *                   — slash menu, block menu — still win before this.)
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
 *   - Shift+Alt+↑/↓ duplicate the selected block range or the caret's block
 *                   (MAR-103, VS Code copy-line semantics) — the same
 *                   primitive the menu's Duplicate row uses. Delete Block
 *                   (contributed Cmd+Shift+K) shares the range logic but has
 *                   no ProseMirror binding here.
 *
 * Commands are exported for direct unit testing; the keymap is thin wiring.
 * ProseMirror's baseKeymap is appended AFTER user plugins by Milkdown core,
 * so these bindings run first and fall through (return false) cleanly.
 */
import { keydownHandler } from "@milkdown/prose/keymap";
import { Plugin, Selection, TextSelection, type EditorState, type Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import { closeTopmostLayer } from "../ui/escapeLayers";
import {
    deleteBlockRange,
    duplicateBlockRange,
    moveBlockAt,
    moveBlockTo,
} from "../components/blockMenu";
import { selectionCoverRange } from "../components/blockMenu/drag";
import { BlockRangeSelection } from "./blockRange";
import {
    foldHiddenRange,
    foldPluginKey,
    foldedSectionEnds,
    type FoldMeta,
} from "./headingFold";

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
 * The document as VISIBLE units: one entry per top-level block, except that
 * a collapsed heading and its hidden section are ONE unit — the keyboard
 * must never split them (selecting/moving the heading alone would orphan
 * invisible content) nor extend into them one hidden block at a time.
 */
export function unitBoundaries(state: EditorState): { from: number; to: number }[] {
    const sectionEnds = foldedSectionEnds(state); // one doc pass, not one per fold
    const units: { from: number; to: number }[] = [];
    let skipUntil = 0;
    state.doc.forEach((node, offset) => {
        if (offset < skipUntil) {
            return; // hidden inside a collapsed section — part of its unit
        }
        const end = sectionEnds.get(offset) ?? offset + node.nodeSize;
        units.push({ from: offset, to: end });
        skipUntil = end;
    });
    return units;
}

/** Snap [from, to] outward to whole visible units. */
function snapToUnits(
    units: { from: number; to: number }[],
    from: number,
    to: number,
): { from: number; to: number } {
    let start = from;
    let end = to;
    for (const unit of units) {
        if (unit.from <= from && from < unit.to) {
            start = unit.from;
        }
        if (unit.from < to && to <= unit.to) {
            end = unit.to;
        }
    }
    return { from: start, to: end };
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
    const raw = BlockRangeSelection.tryCreate(state.doc, sel.from, sel.to);
    if (!raw) {
        return false;
    }
    // Unit-snap: a collapsed heading selects WITH its hidden section.
    const unit = snapToUnits(unitBoundaries(state), raw.from, raw.to);
    const range = BlockRangeSelection.tryCreate(state.doc, unit.from, unit.to) ?? raw;
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
        const units = unitBoundaries(state);
        // Work on unit indices: a collapsed heading + hidden section is one
        // step, so the head never lands inside invisible content.
        const snapped = snapToUnits(units, range.from, range.to);
        const backward = range.head < range.anchor;
        const first = units.findIndex((u) => u.from === snapped.from);
        const last = units.findIndex((u) => u.to === snapped.to);
        if (first < 0 || last < 0) {
            return true; // unit map out of sync — consume rather than misfire
        }
        let anchor: number;
        let head: number;
        if (!backward) {
            if (dir === 1) {
                if (last + 1 >= units.length) {
                    return true; // doc end — consume, no change
                }
                anchor = snapped.from;
                head = units[last + 1]!.to;
            } else if (last > first) {
                anchor = snapped.from;
                head = units[last - 1]!.to;
            } else {
                // One unit left and shift points the other way: FLIP around
                // the anchor unit (it always stays selected, the Notion
                // contract) — the range grows upward from its start instead.
                if (first === 0) {
                    return true;
                }
                anchor = snapped.to;
                head = units[first - 1]!.from;
            }
        } else {
            if (dir === -1) {
                if (first === 0) {
                    return true;
                }
                anchor = snapped.to;
                head = units[first - 1]!.from;
            } else if (first < last) {
                anchor = snapped.to;
                head = units[first + 1]!.from;
            } else {
                // Mirror flip: grow downward from the range's end.
                if (last + 1 >= units.length) {
                    return true;
                }
                anchor = snapped.from;
                head = units[last + 1]!.to;
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
    // The unit(s) the selection touches. tryCreate handles every selection
    // shape (caret, text, NodeSelection on a leaf like an HR) uniformly.
    const raw = BlockRangeSelection.tryCreate(doc, sel.from, sel.to);
    if (!raw) {
        return false;
    }
    const units = unitBoundaries(state);
    const unit = snapToUnits(units, raw.from, raw.to);
    const isOneUnit = units.some((u) => u.from === unit.from && u.to === unit.to);
    if (!isOneUnit) {
        // Already spanning units — go straight to everything.
        if (dispatch) {
            dispatch(state.tr.setSelection(all));
        }
        return true;
    }
    // One unit: select its text; if that's already selected (or it has
    // none), step up to the unit itself (a collapsed heading brings its
    // hidden section).
    const $start = doc.resolve(Math.min(raw.from + 1, doc.content.size));
    const $end = doc.resolve(Math.max(0, raw.to - 1));
    const blockText = TextSelection.between($start, $end);
    const hasAllText = blockText.empty || (sel.from <= blockText.from && sel.to >= blockText.to);
    if (dispatch) {
        dispatch(state.tr.setSelection(
            hasAllText
                ? (BlockRangeSelection.tryCreate(doc, unit.from, unit.to) ?? all)
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
        // The cover is fold-expanded by selectionCoverRange (a collapsed
        // heading carries its hidden section); targets hop whole visible
        // UNITS so a move never lands inside another collapsed section.
        const rawCover = selectionCoverRange(view);
        if (rawCover) {
            const units = unitBoundaries(state);
            const cover = snapToUnits(units, rawCover.from, rawCover.to);
            const first = units.findIndex((u) => u.from === cover.from);
            const last = units.findIndex((u) => u.to === cover.to);
            if (first < 0 || last < 0) {
                return true; // unit map out of sync — consume rather than misfire
            }
            let target: number | null;
            if (dir === -1) {
                target = first > 0 ? units[first - 1]!.from : null;
            } else {
                target = last + 1 < units.length ? units[last + 1]!.to : null;
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

/**
 * The blocks a duplicate/delete acts on: an explicit block-spanning
 * selection covers exactly what it shows (unit-snapped — a collapsed
 * heading carries its hidden section); a bare caret gets the block menu's
 * unit semantics — the innermost list ITEM inside a list, otherwise the
 * caret's top-level block. Like the menu rows, a caret on a collapsed
 * heading targets the heading LINE alone (duplicate inserts past the hidden
 * section; delete simply reveals it).
 */
function actionRange(state: EditorState, view: EditorView): { from: number; to: number } | null {
    const rawCover = selectionCoverRange(view);
    if (rawCover) {
        return snapToUnits(unitBoundaries(state), rawCover.from, rawCover.to);
    }
    const $from = state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === "list_item") {
            const pos = $from.before(depth);
            return { from: pos, to: pos + $from.node(depth).nodeSize };
        }
    }
    return blockAt(state, state.selection.from);
}

/**
 * Shift+Alt+↑/↓ / palette Duplicate Block Up/Down (MAR-103). VS Code
 * copy-line semantics: down puts the copy after and the selection lands on
 * the copy; up puts the copy before and the selection stays on the earlier
 * copy. One undo step (duplicateBlockRange dispatches a single transaction).
 */
export function duplicateSelectedBlocks(dir: -1 | 1): Command {
    return (state, dispatch, view) => {
        if (!view || !dispatch) {
            return false;
        }
        const range = actionRange(state, view);
        if (!range) {
            return false;
        }
        return duplicateBlockRange(view, range, dir, { select: true });
    };
}

/**
 * Contributed Cmd+Shift+K / palette Delete Block (MAR-103): delete the
 * caret's block or the selected block range in one undo step.
 */
export const deleteSelectedBlocks: Command = (state, dispatch, view) => {
    if (!view || !dispatch) {
        return false;
    }
    const range = actionRange(state, view);
    if (!range) {
        return false;
    }
    return deleteBlockRange(view, range);
};

/**
 * ←/→ while a block range is selected: collapse/expand the selected
 * foldable block(s) — the universal tree-view grammar (MAR-110). This
 * deliberately replaces ProseMirror's default collapse-to-caret on these
 * keys IN BLOCK-SELECTION MODE ONLY (Escape remains the exit, matching how
 * tree views behave); outside a block range the keys fall through
 * untouched. With `editor.folding` off the default behavior returns.
 */
export function foldSelectedBlocks(fold: boolean): Command {
    return (state, dispatch) => {
        const sel = state.selection;
        if (!(sel instanceof BlockRangeSelection)) {
            return false;
        }
        const foldState = foldPluginKey.getState(state);
        if (!foldState?.enabled) {
            return false;
        }
        const positions: number[] = [];
        state.doc.forEach((node, offset) => {
            if (
                offset >= sel.from && offset < sel.to &&
                foldHiddenRange(state.doc, offset) !== null &&
                foldState.folded.has(offset) !== fold
            ) {
                positions.push(offset);
            }
        });
        if (positions.length > 0 && dispatch) {
            dispatch(
                state.tr
                    .setMeta(foldPluginKey, { type: "setMany", positions, folded: fold } satisfies FoldMeta)
                    .setMeta("addToHistory", false),
            );
        }
        // Consume even when nothing changed: in block-selection mode the
        // arrows are fold verbs, never a selection exit.
        return true;
    };
}

const blockKeymap = keydownHandler({
    "Escape": toggleBlockSelection,
    "ArrowLeft": foldSelectedBlocks(true),
    "ArrowRight": foldSelectedBlocks(false),
    "Shift-ArrowDown": extendBlockSelection(1),
    "Shift-ArrowUp": extendBlockSelection(-1),
    "Mod-a": escalateSelectAll,
    "Alt-ArrowDown": moveSelectedBlocks(1),
    "Alt-ArrowUp": moveSelectedBlocks(-1),
    "Mod-Shift-ArrowDown": moveSelectedBlocks(1),
    "Mod-Shift-ArrowUp": moveSelectedBlocks(-1),
    "Shift-Alt-ArrowDown": duplicateSelectedBlocks(1),
    "Shift-Alt-ArrowUp": duplicateSelectedBlocks(-1),
});

/**
 * The plugin's keydown entry (exported for tests). A plain Escape first
 * offers the key to the transient-surface stack (ui/escapeLayers.ts): if a
 * surface closed, the key is consumed WITHOUT touching the selection — the
 * VS Code/Notion layering (find widget closes before the editor reacts).
 * The layer check lives here in the wiring, not inside toggleBlockSelection,
 * so the exported command stays pure. stopPropagation matches how the
 * overlays' own Escape handlers keep the consumed chord from reaching the
 * workbench key forwarder (see keyboardShortcuts.ts); an unconsumed Escape
 * still propagates, since the workbench owns Escape when we don't use it.
 */
export function handleBlockKeydown(view: EditorView, event: KeyboardEvent): boolean {
    if (
        event.key === "Escape" &&
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
        closeTopmostLayer()
    ) {
        event.stopPropagation();
        return true;
    }
    return blockKeymap(view, event);
}

export const blockKeysPlugin = $prose(() =>
    new Plugin({
        props: {
            handleKeyDown: handleBlockKeydown,
        },
    }),
);
