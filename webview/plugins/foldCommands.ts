/**
 * webview/plugins/foldCommands.ts
 *
 * ProseMirror commands behind the contributed section-folding entries
 * (markdownWysiwyg.editor.foldSection / unfoldSection / foldAllSections /
 * unfoldAllSections), dispatched through the editor-command registry.
 *
 * All four work against headingFold's plugin state and dispatch its metas
 * ({ type: "toggle" } / { type: "setAll" }) with addToHistory:false, exactly
 * like the gutter chevron — fold state is a view concern, never an undo step.
 * The single-section pair is DIRECTIONAL: foldSection never unfolds and
 * unfoldSection never folds, so holding the chord always converges instead
 * of toggling in place.
 */
import { TextSelection, type Command, type EditorState, type Transaction } from "@milkdown/prose/state";
import {
    cachedFoldRanges,
    headingFoldPluginKey,
    sectionHeadingPosAt,
    type HeadingFoldMeta,
} from "./headingFold";

/** The folded-position set, or null when the fold plugin isn't in this state. */
function foldedSet(state: EditorState): ReadonlySet<number> | null {
    return headingFoldPluginKey.getState(state)?.folded ?? null;
}

/**
 * Move the selection onto the heading's own text when it currently overlaps
 * [bodyFrom, bodyTo) — content that the transaction is about to hide. The
 * chevron-click rule (headingFold.ts): a caret must never end up sitting
 * invisibly inside display:none content.
 */
function rescueSelection(
    state: EditorState,
    tr: Transaction,
    headingPos: number,
    bodyFrom: number,
    bodyTo: number,
): void {
    if (state.selection.from < bodyTo && state.selection.to > bodyFrom) {
        tr.setSelection(
            TextSelection.near(tr.doc.resolve(Math.min(headingPos + 1, tr.doc.content.size))),
        );
    }
}

/**
 * The position both single-section commands resolve their section at. A
 * non-empty FORWARD selection (Escape's block range, a node selection) puts
 * `head` at the range's END boundary — a depth-0 position equal to the NEXT
 * block's offset, which sectionHeadingPosAt would treat inclusively and
 * resolve to the FOLLOWING section. Step one position back inside the
 * selected content instead (the depth-0 nodeBefore rule openAtCaret.ts
 * applies). Backward selections and plain carets already point at (or into)
 * the intended content and are left alone.
 */
function sectionProbePos(state: EditorState): number {
    const { selection } = state;
    return !selection.empty && selection.head > selection.anchor
        ? selection.head - 1
        : selection.head;
}

/**
 * Fold the section containing the caret (the innermost one — matching the
 * chevron the section-hover highlight points at). Already folded, or no
 * enclosing section → false; the chord pair is directional, so this never
 * dispatches a toggle that would unfold.
 */
export const foldSection: Command = (state, dispatch) => {
    const folded = foldedSet(state);
    if (!folded) {
        return false;
    }
    const headingPos = sectionHeadingPosAt(state.doc, sectionProbePos(state));
    if (headingPos === null || folded.has(headingPos)) {
        return false;
    }
    if (dispatch) {
        const tr = state.tr
            .setMeta(headingFoldPluginKey, { type: "toggle", pos: headingPos } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false);
        const range = cachedFoldRanges(state.doc).get(headingPos);
        if (range) {
            rescueSelection(state, tr, headingPos, range.from, range.to);
        }
        dispatch(tr);
    }
    return true;
};

/**
 * Unfold the innermost FOLDED section containing the caret: a caret ON a
 * folded heading line unfolds that heading; a caret whose own section is
 * open but sits under a folded ancestor unfolds that ancestor. Nothing
 * folded around the caret → false (directional, see foldSection).
 */
export const unfoldSection: Command = (state, dispatch) => {
    const folded = foldedSet(state);
    if (!folded || folded.size === 0) {
        return false;
    }
    const pos = sectionProbePos(state);
    let headingPos: number | null = null;
    for (const [candidate, range] of cachedFoldRanges(state.doc)) {
        if (
            range && folded.has(candidate) && candidate <= pos && pos < range.to &&
            (headingPos === null || candidate > headingPos)
        ) {
            headingPos = candidate;
        }
    }
    if (headingPos === null) {
        return false;
    }
    if (dispatch) {
        dispatch(
            state.tr
                .setMeta(headingFoldPluginKey, { type: "toggle", pos: headingPos } satisfies HeadingFoldMeta)
                .setMeta("addToHistory", false),
        );
    }
    return true;
};

/**
 * Fold every foldable section at once ({ type: "setAll" }). No headings, or
 * everything already folded → false. A selection touching any section body
 * is rescued onto the OUTERMOST enclosing heading — the one heading line of
 * its chain that stays visible after a fold-all (inner heading lines hide
 * with their ancestor's body).
 */
export const foldAllSections: Command = (state, dispatch) => {
    const folded = foldedSet(state);
    if (!folded) {
        return false;
    }
    const ranges = cachedFoldRanges(state.doc);
    const foldable: number[] = [];
    for (const [pos, range] of ranges) {
        if (range) {
            foldable.push(pos);
        }
    }
    if (foldable.length === 0 || foldable.every((pos) => folded.has(pos))) {
        return false;
    }
    if (dispatch) {
        const tr = state.tr
            .setMeta(headingFoldPluginKey, { type: "setAll", folded: foldable } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false);
        let outermost: number | null = null;
        for (const [candidate, range] of ranges) {
            if (
                range && state.selection.from < range.to && state.selection.to > range.from &&
                (outermost === null || candidate < outermost)
            ) {
                outermost = candidate;
            }
        }
        if (outermost !== null) {
            tr.setSelection(
                TextSelection.near(tr.doc.resolve(Math.min(outermost + 1, tr.doc.content.size))),
            );
        }
        dispatch(tr);
    }
    return true;
};

/** Unfold every folded section ({ type: "setAll", folded: [] }). Nothing
 * folded → false. The caret needs no rescue — content only becomes visible. */
export const unfoldAllSections: Command = (state, dispatch) => {
    const folded = foldedSet(state);
    if (!folded || folded.size === 0) {
        return false;
    }
    if (dispatch) {
        dispatch(
            state.tr
                .setMeta(headingFoldPluginKey, { type: "setAll", folded: [] } satisfies HeadingFoldMeta)
                .setMeta("addToHistory", false),
        );
    }
    return true;
};
