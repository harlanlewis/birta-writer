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
 *   bold/italic/link/code) → block text → the enclosing structure inside the
 *   top-level block, one level at a time (a list item, then the list it sits
 *   in, then the item THAT sits in, and so on up to depth 2; a blockquote's
 *   or callout's child) as a text selection over its whole content → block
 *   range (toggleBlockSelection, exactly what Escape produces,
 *   fold-unit-snapped) → everything (escalateSelectAll). Expanding past
 *   everything returns false. Table cells and rows are not rungs: a text
 *   selection across cells is not a thing, and the table itself is the
 *   block-range rung.
 *
 * Word rule at a caret: a word char to the RIGHT of the caret wins (word
 * under/after the caret), else a word char to the LEFT (word ending at the
 * caret), else the nearest word scanning right within the block, else
 * scanning left. An empty (or wordless, textless) block skips straight to
 * the block ladder.
 *
 * SHRINK IS RE-DERIVATION, WITH ONE MEMO ON TOP. Shrink recomputes the
 * containment chain for the CURRENT selection — everything → single block
 * unit → block text (or the enclosing structure's text, one level at a
 * time) → mark span → word — anchored at the selection's head-side interior
 * position, and steps down one level. That is stateless and works after any
 * selection, but it cannot know that "everything" was reached from a
 * three-block range rather than one, so on its own it lands on one unit
 * where Shift+Up would give three (MAR-105). So the plugin also keeps an
 * expand memo: each expand pushes the selection it grew from, and shrink
 * pops back to it while the current selection is still exactly the one that
 * expand produced. Any other selection change, or any document change,
 * empties the memo, and shrink falls back to re-derivation. The commands
 * work without the plugin state (the memo is then simply absent), which is
 * how the direct-command tests exercise the ladder. A caret, or a selection
 * with no recognized strictly-contained sub-range (e.g. a lone word), returns
 * false.
 */
import { keydownHandler } from "../pm";
import type { Mark, Node as ProseNode, ResolvedPos, Transaction } from "../pm";
import { Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState } from "../pm";
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

/**
 * The text selection covering the whole content of the ancestor of `$pos` at
 * `depth`, or null when that ancestor is not a rung: depth 0 is the document
 * and depth 1 is the top-level block (the block-range rung already covers
 * it), and table structure is skipped (`tableRole`), because a text
 * selection across cells is not a thing and the table is its own block rung.
 */
function structureText(doc: ProseNode, $pos: ResolvedPos, depth: number): Selection | null {
    if (depth < 2 || depth >= $pos.depth) {
        return null;
    }
    const node = $pos.node(depth);
    if (node.type.spec.tableRole) {
        return null;
    }
    return TextSelection.between(doc.resolve($pos.start(depth)), doc.resolve($pos.end(depth)));
}

const rangeOf = (sel: Selection): Range => ({ from: sel.from, to: sel.to });
const strictlyContains = (outer: Range, inner: Range): boolean =>
    outer.from <= inner.from && outer.to >= inner.to && outer.to - outer.from > inner.to - inner.from;

/**
 * One expand step's memo entry: the JSON of the selection expand grew FROM
 * and of the one it produced. JSON rather than live Selections so a stale
 * entry can never carry a ResolvedPos of another document; both types here
 * (text, block range) round-trip through Selection.fromJSON.
 */
interface MemoEntry {
    origin: Record<string, unknown>;
    target: Record<string, unknown>;
}

const smartSelectKey = new PluginKey<MemoEntry[]>("smartSelectMemo");

const sameSelection = (json: Record<string, unknown>, sel: Selection): boolean => {
    const now = sel.toJSON() as Record<string, unknown>;
    return now.type === json.type && now.anchor === json.anchor && now.head === json.head;
};

/** Grow the selection to the next enclosing syntactic range. */
export const expandSelection: Command = (state, dispatch) => {
    // Every dispatched step records where it grew from (see the header's
    // memo). Without the plugin in the state the meta is simply ignored.
    const origin = state.selection.toJSON() as Record<string, unknown>;
    const remember = dispatch
        ? (tr: Transaction) => dispatch(tr.setMeta(smartSelectKey, { push: origin }))
        : undefined;
    return expandOnce(state, remember);
};

const expandOnce: Command = (state, dispatch) => {
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
        // Enclosing structure inside the top-level block, deepest first: the
        // first ancestor whose whole text strictly contains the selection.
        for (let depth = $from.sharedDepth($to.pos); depth >= 2; depth--) {
            const rung = structureText(doc, $from, depth);
            if (rung && strictlyContains(rangeOf(rung), rangeOf(sel))) {
                if (dispatch) {
                    dispatch(state.tr.setSelection(rung));
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
    // The memo first: while the selection is still exactly what the last
    // expand produced, step back to what it grew from.
    const memo = smartSelectKey.getState(state);
    const top = memo?.[memo.length - 1];
    if (top && sameSelection(top.target, sel)) {
        if (dispatch) {
            dispatch(
                state.tr
                    .setSelection(Selection.fromJSON(doc, top.origin))
                    .setMeta(smartSelectKey, { pop: true }),
            );
        }
        return true;
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
        // Cross-block text (a structure rung, a shrunken collapsed-section
        // unit, or a native multi-block drag) → the LARGEST enclosing
        // structure around the head that sits strictly inside, else the
        // head block's full text.
        if (!$head.parent.isTextblock) {
            return false;
        }
        for (let depth = 2; depth < $head.depth; depth++) {
            const rung = structureText(doc, $head, depth);
            if (rung && strictlyContains(rangeOf(sel), rangeOf(rung))) {
                if (dispatch) {
                    dispatch(state.tr.setSelection(rung));
                }
                return true;
            }
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
    const bindings: Record<string, Command> = isMac
        ? {
            "Ctrl-Shift-Cmd-ArrowRight": expandSelection,
            "Ctrl-Shift-Cmd-ArrowLeft": shrinkSelection,
        }
        : {
            "Shift-Alt-ArrowRight": expandSelection,
            "Shift-Alt-ArrowLeft": shrinkSelection,
        };
    return new Plugin<MemoEntry[]>({
        key: smartSelectKey,
        state: {
            init: () => [],
            apply(tr, memo) {
                const meta = tr.getMeta(smartSelectKey) as
                    | { push?: Record<string, unknown>; pop?: boolean }
                    | undefined;
                if (meta?.push) {
                    return [...memo, { origin: meta.push, target: tr.selection.toJSON() as Record<string, unknown> }];
                }
                if (meta?.pop) {
                    return memo.slice(0, -1);
                }
                // Anything else that moves the selection or the document ends
                // the run: the memo describes positions in a document and a
                // selection chain that no longer exist.
                return tr.docChanged || tr.selectionSet ? [] : memo;
            },
        },
        props: { handleKeyDown: keydownHandler(bindings) },
    });
});
