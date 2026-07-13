/**
 * plugins/smartSelect.ts — Expand/Shrink Selection (VS Code smart select,
 * MAR-98).
 *
 * The default chords are hardcoded ProseMirror keymap bindings, not
 * contributed keybindings: they collide with native contenteditable
 * selection behavior (word/line extension), so the default action must be
 * suppressed synchronously at the keydown — a round-trip through the
 * extension host would let the native selection change land first. Same
 * reasoning as the Alt+Arrow move-block bindings in blockKeys.ts. The
 * chords mirror the built-in editor per platform:
 *   - macOS:          Ctrl+Shift+Cmd+ArrowRight / ArrowLeft
 *   - Windows/Linux:  Shift+Alt+ArrowRight / ArrowLeft
 * Both are claimed by the key-leak guard (webview/keyboardShortcuts.ts) so
 * they never double-fire a workbench action; the palette entries
 * (`birta.editor.expandSelection` / `shrinkSelection`) stay
 * rebindable to ADDITIONAL chords.
 *
 * THE LADDER (each expand grows to the next strictly-containing range, then
 * hands off to the existing block grammar — one keyboard language with
 * Escape and the Mod+A ladder in blockKeys.ts):
 *
 *   caret → word → inline mark span (smallest strictly-containing extent of
 *   bold/italic/link/code) → block text → block range (toggleBlockSelection,
 *   exactly what Escape produces, fold-unit-snapped) → everything
 *   (escalateSelectAll). Expanding past everything returns false.
 *
 * Word rule at a caret: a word char to the RIGHT of the caret wins (word
 * under/after the caret), else a word char to the LEFT (word ending at the
 * caret), else the nearest word scanning right within the block, else
 * scanning left. An empty (or wordless, textless) block skips straight to
 * the block ladder.
 *
 * SHRINK IS DETERMINISTIC RE-DERIVATION, NOT HISTORY. VS Code shrinks by
 * replaying a recorded expand stack; we intentionally keep no plugin state.
 * Shrink recomputes the containment chain for the CURRENT selection —
 * everything → single block unit → block text → mark span → word — anchored
 * at the selection's head-side interior position, and steps down one level.
 * After an expand run this retraces the same ranges whenever the head lands
 * where the run started; after an arbitrary selection it still steps down
 * somewhere sensible. A caret, or a selection with no recognized strictly
 * -contained sub-range (e.g. a lone word), returns false.
 */
import { keymap } from "@milkdown/prose/keymap";
import type { Mark } from "@milkdown/prose/model";
import { TextSelection, type Command, type EditorState } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { escalateSelectAll, toggleBlockSelection, unitBoundaries } from "./blockKeys";
import { BlockRangeSelection } from "./blockRange";
import { foldedSectionEnds } from "./headingFold";

interface Range {
    from: number;
    to: number;
}

/** Word characters: letters, digits, underscore (Unicode-aware). */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR.test(ch);

/**
 * The word under/adjacent to `pos` inside its textblock, per the header's
 * word rule. Null when the block holds no word at all (or isn't a textblock).
 * Inline leaves (images, breaks) map to a placeholder char so offsets stay
 * aligned with document positions.
 */
function wordAt(state: EditorState, pos: number): Range | null {
    const $pos = state.doc.resolve(pos);
    const block = $pos.parent;
    if (!block.isTextblock) {
        return null;
    }
    const blockStart = $pos.start();
    const text = block.textBetween(0, block.content.size, undefined, "￼");
    const off = Math.max(0, Math.min(pos - blockStart, text.length));
    let s: number;
    let e: number;
    if (isWordChar(text[off])) {
        // Word under / starting after the caret — take its full run.
        s = off;
        e = off;
        while (isWordChar(text[e])) e++;
        while (s > 0 && isWordChar(text[s - 1])) s--;
    } else if (isWordChar(text[off - 1])) {
        // Word ending at the caret.
        e = off;
        s = off;
        while (s > 0 && isWordChar(text[s - 1])) s--;
    } else {
        // Whitespace/punctuation both sides: nearest word right, else left.
        let i = off;
        while (i < text.length && !isWordChar(text[i])) i++;
        if (i < text.length) {
            s = i;
            e = i;
            while (isWordChar(text[e])) e++;
        } else {
            let j = off;
            while (j > 0 && !isWordChar(text[j - 1])) j--;
            if (j === 0) {
                return null;
            }
            e = j;
            s = j;
            while (s > 0 && isWordChar(text[s - 1])) s--;
        }
    }
    return s === e ? null : { from: blockStart + s, to: blockStart + e };
}

/**
 * All maximal same-mark extents around [from, to) within its textblock: for
 * every mark carried by EVERY inline node the range touches, the contiguous
 * run of siblings carrying that mark. `from`/`to` must sit in one textblock.
 */
function markExtents(state: EditorState, from: number, to: number): Range[] {
    const $from = state.doc.resolve(from);
    const block = $from.parent;
    if (!block.isTextblock) {
        return [];
    }
    const blockStart = $from.start();
    // Marks present on every inline node overlapping the range.
    let common: readonly Mark[] | null = null;
    block.forEach((child, offset) => {
        const cFrom = blockStart + offset;
        const cTo = cFrom + child.nodeSize;
        if (cTo <= from || cFrom >= to) {
            return;
        }
        common = common === null ? child.marks : common.filter((m) => m.isInSet(child.marks));
    });
    const marks: readonly Mark[] = common ?? [];
    const extents: Range[] = [];
    for (const mark of marks) {
        let runStart: number | null = null;
        let runEnd = 0;
        let found: Range | null = null;
        const closeRun = () => {
            if (runStart !== null && runStart <= from && runEnd >= to) {
                found = { from: runStart, to: runEnd };
            }
            runStart = null;
        };
        block.forEach((child, offset) => {
            const cFrom = blockStart + offset;
            if (mark.isInSet(child.marks)) {
                if (runStart === null) {
                    runStart = cFrom;
                }
                runEnd = cFrom + child.nodeSize;
            } else {
                closeRun();
            }
        });
        closeRun();
        if (found) {
            extents.push(found);
        }
    }
    return extents;
}

/** Grow the selection to the next enclosing syntactic range. */
export const expandSelection: Command = (state, dispatch) => {
    const sel = state.selection;
    const { doc } = state;
    if (sel instanceof BlockRangeSelection) {
        if (sel.from <= 0 && sel.to >= doc.content.size) {
            return false; // already everything — the top of the ladder
        }
        // Hand off to the existing block grammar: block range → everything.
        return escalateSelectAll(state, dispatch);
    }
    if (sel instanceof TextSelection) {
        const { $from, $to } = sel;
        if (sel.empty && $from.parent.isTextblock) {
            const word = wordAt(state, sel.head);
            if (word) {
                if (dispatch) {
                    dispatch(state.tr.setSelection(TextSelection.create(doc, word.from, word.to)));
                }
                return true;
            }
            // Wordless but non-empty block (punctuation only): its text is
            // still a level; a truly empty block falls through to the
            // block ladder.
            if ($from.parent.content.size > 0) {
                if (dispatch) {
                    dispatch(state.tr.setSelection(TextSelection.create(doc, $from.start(), $from.end())));
                }
                return true;
            }
        } else if (!sel.empty && $from.sameParent($to) && $from.parent.isTextblock) {
            // Smallest mark extent STRICTLY containing the selection.
            let best: Range | null = null;
            for (const extent of markExtents(state, sel.from, sel.to)) {
                const strictly = extent.from < sel.from || extent.to > sel.to;
                if (strictly && (!best || extent.to - extent.from < best.to - best.from)) {
                    best = extent;
                }
            }
            if (best) {
                if (dispatch) {
                    dispatch(state.tr.setSelection(TextSelection.create(doc, best.from, best.to)));
                }
                return true;
            }
            const bFrom = $from.start();
            const bTo = $from.end();
            if (bFrom < sel.from || bTo > sel.to) {
                if (dispatch) {
                    dispatch(state.tr.setSelection(TextSelection.create(doc, bFrom, bTo)));
                }
                return true;
            }
        }
    }
    // Block ladder hand-off: exactly Escape's escalation (fold-unit-snapped).
    return toggleBlockSelection(state, dispatch);
};

/** Shrink the selection back one step of the expand ladder (re-derived). */
export const shrinkSelection: Command = (state, dispatch) => {
    const sel = state.selection;
    const { doc } = state;
    if (sel.empty) {
        return false;
    }
    if (sel instanceof BlockRangeSelection) {
        const units = unitBoundaries(state);
        const covered = units.filter((u) => u.from >= sel.from && u.to <= sel.to);
        if (covered.length > 1) {
            // Multi-unit (e.g. everything) → the single unit at the
            // head-side interior position.
            const interior = sel.head < sel.anchor ? sel.from : Math.max(sel.from, sel.to - 1);
            const unit =
                units.find((u) => u.from <= interior && interior < u.to) ?? covered[covered.length - 1]!;
            const range = BlockRangeSelection.tryCreate(doc, unit.from, unit.to);
            if (!range) {
                return false;
            }
            if (dispatch) {
                dispatch(state.tr.setSelection(range));
            }
            return true;
        }
        // Single unit → its text (a caret for an empty block; a leaf block
        // like an HR has no interior text positions — nothing below). A
        // COLLAPSED heading's unit spans its hidden section too, so shrink to
        // the heading's OWN text — otherwise the tail lands inside the
        // display:none body and typing would replace invisible content. This
        // mirrors escalateSelectAll's un-snapped text rung: ⌘A and shrink
        // agree that a collapsed heading's text is the heading line alone.
        const collapsed = foldedSectionEnds(state).has(sel.from);
        const headingNode = collapsed ? doc.nodeAt(sel.from) : null;
        const textEnd = headingNode ? sel.from + headingNode.nodeSize - 1 : sel.to - 1;
        const $start = doc.resolve(Math.min(sel.from + 1, doc.content.size));
        const $end = doc.resolve(Math.max(0, textEnd));
        const blockText = TextSelection.between($start, $end);
        if (blockText.from < sel.from || blockText.to > sel.to) {
            return false;
        }
        if (dispatch) {
            dispatch(state.tr.setSelection(blockText));
        }
        return true;
    }
    if (!(sel instanceof TextSelection)) {
        return false; // NodeSelection etc. — unrecognized
    }
    const { $from, $to, $head } = sel;
    if (!$from.sameParent($to)) {
        // Cross-block text (a shrunken collapsed-section unit, or a native
        // multi-block drag) → the head block's full text.
        if (!$head.parent.isTextblock) {
            return false;
        }
        const bFrom = $head.start();
        const bTo = $head.end();
        if (bFrom < sel.from || bTo > sel.to || bTo - bFrom >= sel.to - sel.from) {
            return false;
        }
        if (dispatch) {
            dispatch(state.tr.setSelection(TextSelection.create(doc, bFrom, bTo)));
        }
        return true;
    }
    if (!$from.parent.isTextblock) {
        return false;
    }
    // Within one block: the LARGEST recognized range strictly inside the
    // selection around the head-side probe char — a mark extent beats the
    // word inside it, retracing word → mark → block text downward.
    const strictlyInside = (r: Range): boolean =>
        r.from >= sel.from && r.to <= sel.to && r.to - r.from < sel.to - sel.from;
    const probeFrom = sel.head > sel.from ? sel.head - 1 : sel.head;
    const candidates = markExtents(state, probeFrom, probeFrom + 1).filter(strictlyInside);
    const word = wordAt(state, sel.head);
    if (word && strictlyInside(word)) {
        candidates.push(word);
    }
    if (candidates.length === 0) {
        return false;
    }
    const best = candidates.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    if (dispatch) {
        dispatch(state.tr.setSelection(TextSelection.create(doc, best.from, best.to)));
    }
    return true;
};

export const smartSelectKeymapPlugin = $prose(() => {
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);
    return keymap(
        isMac
            ? {
                "Ctrl-Shift-Cmd-ArrowRight": expandSelection,
                "Ctrl-Shift-Cmd-ArrowLeft": shrinkSelection,
            }
            : {
                "Shift-Alt-ArrowRight": expandSelection,
                "Shift-Alt-ArrowLeft": shrinkSelection,
            },
    );
});
