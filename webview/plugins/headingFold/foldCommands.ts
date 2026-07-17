/**
 * webview/plugins/headingFold/foldCommands.ts
 *
 * The command layer: caret-scoped fold/unfold with ancestor bubbling
 * (MAR-110: birta.editor.fold/unfold/…), Fold All / Unfold All, the explicit
 * reveal-on-navigate entry (revealPosition), and the typing-level
 * fold-boundary reveal guards (Backspace/Delete/Enter). Every dispatch here
 * shares the fold invariants: zero steps, no history entry, selection
 * ejected out of newly hidden content.
 */
import type { EditorView } from "@milkdown/prose/view";
import { keymap } from "@milkdown/prose/keymap";
import {
    Selection,
    type Command,
    type EditorState,
    type Transaction,
} from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { foldPluginKey, type FoldMeta } from "../foldState";
import {
    allFoldablePositions,
    cachedFoldRanges,
    foldEscapeSelection,
    foldHiddenRange,
    foldedHiddenRanges,
    isHeadingNode,
} from "./foldModel";

/**
 * An explicit ENTRY intent into hidden content (Find match navigation, TOC
 * click, goto-symbol): unfold every fold whose hidden range contains `pos`
 * and leave them unfolded — VS Code's reveal semantics. No-op when the
 * target is already visible.
 */
export function revealPosition(view: EditorView, pos: number): void {
    const containing = foldedHiddenRanges(view.state).filter(
        (r) => pos >= r.from && pos < r.to,
    );
    if (containing.length === 0) {
        return;
    }
    view.dispatch(
        view.state.tr
            .setMeta(foldPluginKey, {
                type: "setMany",
                positions: containing.map((r) => r.pos),
                folded: false,
            } satisfies FoldMeta)
            .setMeta("addToHistory", false),
    );
}

// ─── Fold commands (MAR-110: birta.editor.fold/unfold/…) ──────────

/** Every foldable containing `pos` (heading line or section; callout, list
 * item, table, or code block node), innermost first. */
function foldablesContaining(state: EditorState, pos: number): number[] {
    const candidates: number[] = [];
    for (const [candidate, range] of cachedFoldRanges(state.doc)) {
        if (range && pos >= candidate && pos < range.to) {
            candidates.push(candidate);
        }
    }
    const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
    for (let depth = 1; depth <= $pos.depth; depth++) {
        const before = $pos.before(depth);
        // foldHiddenRange keeps list-item-nested callouts/tables/code out —
        // the fold command must never target what the decoration pass won't
        // render. (Nested headings return null there too.)
        if (!isHeadingNode($pos.node(depth)) && foldHiddenRange(state.doc, before) !== null) {
            candidates.push(before);
        }
    }
    return candidates.sort((a, b) => b - a);
}

/** Dispatch a single idempotent fold/unfold with the shared invariants:
 * zero steps, no history entry, selection ejected out of hidden content. */
function dispatchFold(
    state: EditorState,
    dispatch: (tr: Transaction) => void,
    pos: number,
    folded: boolean,
): void {
    const tr = state.tr
        .setMeta(foldPluginKey, { type: "set", pos, folded } satisfies FoldMeta)
        .setMeta("addToHistory", false);
    if (folded) {
        const range = foldHiddenRange(state.doc, pos);
        if (range && state.selection.from < range.to && state.selection.to > range.from) {
            tr.setSelection(foldEscapeSelection(tr, state.doc.nodeAt(pos), pos));
        }
    }
    dispatch(tr);
}

/**
 * The position the caret fold/unfold commands resolve their foldable at. A
 * non-empty FORWARD selection (Escape's block range, a node selection) puts
 * `head` at the range's END boundary — a depth-0 position equal to the NEXT
 * block's offset, which foldablesContaining would treat inclusively and
 * resolve to the FOLLOWING section. Step one position back inside the
 * selected content instead (the depth-0 nodeBefore rule openAtCaret.ts
 * applies). Backward selections and plain carets already point at (or into)
 * the intended content and are left alone.
 */
function foldProbePos(state: EditorState): number {
    const { selection } = state;
    return !selection.empty && selection.head > selection.anchor
        ? selection.head - 1
        : selection.head;
}

/**
 * Fold the innermost foldable containing the caret; when it is already
 * folded, bubble to the nearest still-open foldable ancestor (VS Code's
 * fold-at-cursor semantics).
 */
export const foldAtCaret: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled) {
        return false;
    }
    for (const pos of foldablesContaining(state, foldProbePos(state))) {
        if (!pluginState.folded.has(pos)) {
            if (dispatch) {
                dispatchFold(state, dispatch, pos, true);
            }
            return true;
        }
    }
    return false;
};

/** Unfold the innermost folded foldable at the caret. */
export const unfoldAtCaret: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled) {
        return false;
    }
    for (const pos of foldablesContaining(state, foldProbePos(state))) {
        if (pluginState.folded.has(pos)) {
            if (dispatch) {
                dispatchFold(state, dispatch, pos, false);
            }
            return true;
        }
    }
    return false;
};

export const foldAllCommand: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled) {
        return false;
    }
    if (allFoldablePositions(state.doc).length === 0) {
        return false;
    }
    if (dispatch) {
        dispatch(
            state.tr
                .setMeta(foldPluginKey, { type: "foldAll" } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );
    }
    return true;
};

export const unfoldAllCommand: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    if (dispatch) {
        dispatch(
            state.tr
                .setMeta(foldPluginKey, { type: "unfoldAll" } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );
    }
    return true;
};

// ─── Backspace/Delete at a fold boundary: reveal, never edit hidden content ─

/** Backspace at the start of a textblock (ANY depth — a list item's first
 * line joins into its previous sibling just like a top-level paragraph)
 * whose join target sits in collapsed hidden content: expand the fold
 * instead of deleting into it. */
export const revealOnBackspace: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    const sel = state.selection;
    const $from = sel.$from;
    if (!sel.empty || $from.depth === 0 || $from.parentOffset !== 0) {
        return false;
    }
    const blockStart = $from.before($from.depth);
    // A collapsed heading's hidden section ending exactly here…
    const section = foldedHiddenRanges(state).find((r) => r.to === blockStart);
    if (section) {
        if (dispatch) {
            dispatchFold(state, dispatch, section.pos, false);
        }
        return true;
    }
    // …or the join target — where Backspace would put the caret — sits
    // inside collapsed hidden content: a collapsed callout/table/code block
    // immediately before, or a list whose last item is folded. Reveal the
    // innermost such fold instead of editing what the user can't see.
    const target = Selection.near(state.doc.resolve(blockStart), -1).from;
    const covering = foldedHiddenRanges(state)
        .filter((r) => target >= r.from && target <= r.to)
        .sort((a, b) => b.pos - a.pos)[0];
    if (covering) {
        if (dispatch) {
            dispatchFold(state, dispatch, covering.pos, false);
        }
        return true;
    }
    return false;
};

/** Delete at the end of a collapsed heading line (forward-deleting into its
 * hidden section) or just before a collapsed callout: expand instead. */
export const revealOnDelete: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    const sel = state.selection;
    const $from = sel.$from;
    if (!sel.empty || $from.depth !== 1 || $from.parentOffset !== $from.parent.content.size) {
        return false;
    }
    const blockStart = $from.before(1);
    if (pluginState.folded.has(blockStart) && isHeadingNode(state.doc.nodeAt(blockStart))) {
        if (dispatch) {
            dispatchFold(state, dispatch, blockStart, false);
        }
        return true;
    }
    // …or the next sibling is any collapsed foldable (callout, table, code
    // block): forward-deleting toward hidden content reveals it instead.
    const blockEnd = $from.after(1);
    if (state.doc.resolve(blockEnd).nodeAfter && pluginState.folded.has(blockEnd)) {
        if (dispatch) {
            dispatchFold(state, dispatch, blockEnd, false);
        }
        return true;
    }
    return false;
};

/**
 * Enter (split) or Mod-Enter (insert paragraph below) with the caret on a
 * COLLAPSED heading's line: the new block would land at the first position
 * of the hidden range — instantly display:none — and the caret guard would
 * then eject the caret into the next visible section (or, at doc end, snap
 * it back so Enter seemed dead while hidden empty paragraphs accreted).
 * Unfold first (revealOnBackspace's philosophy: edits at a fold boundary
 * reveal, never touch hidden content) and ALWAYS return false, so the
 * default Enter handling proceeds against the now-visible section.
 */
export const revealOnEnter: Command = (state, dispatch) => {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState?.enabled || pluginState.folded.size === 0) {
        return false;
    }
    const $from = state.selection.$from;
    // Caret inside a FOLDED list item's visible first line: the split would
    // tear the hidden subtree into the new sibling (splitListItem carries
    // trailing children). Unfold first — same philosophy — and fall through.
    for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === "list_item") {
            const itemPos = $from.before(depth);
            if (pluginState.folded.has(itemPos) && dispatch) {
                dispatchFold(state, dispatch, itemPos, false);
            }
            break; // innermost item decides; outer folds hide this line anyway
        }
    }
    if ($from.depth !== 1) {
        return false;
    }
    const blockStart = $from.before(1);
    if (
        !pluginState.folded.has(blockStart) ||
        !isHeadingNode(state.doc.nodeAt(blockStart)) ||
        foldHiddenRange(state.doc, blockStart) === null
    ) {
        return false;
    }
    if (dispatch) {
        dispatchFold(state, dispatch, blockStart, false);
    }
    return false; // never consume — the split/insert runs on the unfolded state
};

/** Typing-level fold-boundary guards (plain keys — not rebindable chords).
 * Registered BEFORE the presets and insertParagraphKeymapPlugin (editor.ts):
 * revealOnEnter must dispatch its unfold before the default Enter /
 * Mod-Enter handlers read the state. */
export const foldRevealKeymapPlugin = $prose(() =>
    keymap({
        "Backspace": revealOnBackspace,
        "Delete": revealOnDelete,
        "Enter": revealOnEnter,
        "Mod-Enter": revealOnEnter,
    }),
);
