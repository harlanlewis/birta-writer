/**
 * webview/utils/textblockEdit.ts — localize a document change to a single
 * textblock's inline content, by OBSERVING the two real docs (not predicting
 * from steps). Shared by two consumers that each apply their own policy:
 *
 *   - the Contents outline (webview/components/toc/index.ts): ordinary body
 *     typing leaves the heading outline structurally identical, so it reuses the
 *     cached outline with positions shifted by the delta — but a heading edit
 *     DOES change the outline, so it rejects the heading case (MAR-137).
 *   - the Notes scanner (webview/notes/scan.ts): re-scans just the changed
 *     block and shifts the trailing note anchors, instead of re-walking the
 *     whole document each keystroke (MAR-192).
 *
 * `findDiffStart` / `findDiffEnd` bound ALL differences, so outside the returned
 * range the two trees are value-identical: no block appeared, vanished, split,
 * merged, or re-typed there. When the whole change fits inside one textblock's
 * inline content, the only structural fact is that positions after it shifted by
 * a constant `delta`.
 */
import type { Node as PmNode } from "../pm";

export type TextblockEdit =
    /** The two docs are value-identical (no edit, or marks-only object churn). */
    | { kind: "identical" }
    /** The whole change lies inside one textblock's inline content. */
    | {
          kind: "inline";
          /** Start position of the edited textblock in the previous doc. */
          prevBlockPos: number;
          /** Start position of the (same) edited textblock in the next doc. */
          nextBlockPos: number;
          prevBlock: PmNode;
          nextBlock: PmNode;
          /** findDiffEnd's position in the PREVIOUS doc (clamped ≥ start).
           *  Positions at or before it are unmoved; those after shift by delta. */
          endA: number;
          /** Net size change carried by the edit (chars added minus removed). */
          delta: number;
      };

/** The span two docs differ over, with no claim about structure. */
export interface ChangedRange {
    /** First position (valid in both docs) where content diverges. */
    start: number;
    /** End of the changed span in the PREVIOUS doc (clamped ≥ start). */
    endA: number;
    /** End of the changed span in the NEXT doc (clamped ≥ start). */
    endB: number;
}

/**
 * The coarser sibling of `singleTextblockInlineEdit`: the span two docs differ
 * over, or null when they are value-identical. Outside [start, endA] / [start,
 * endB] the trees are value-identical, so a node whose bytes lie wholly outside
 * cannot have appeared, vanished, or changed markup. Pure; cost is bounded by
 * structure sharing, not document size.
 */
export function changedRange(prev: PmNode, next: PmNode): ChangedRange | null {
    const start = prev.content.findDiffStart(next.content);
    if (start == null) {
        return null;
    }
    const diff = prev.content.findDiffEnd(next.content);
    if (!diff) {
        return null;
    }
    let { a: endA, b: endB } = diff;
    // Repeated content ("aa" → "aaa") lets the end scan overrun the start; clamp
    // to a consistent placement (readDOMChange's normalization). Any placement
    // inside the repeated run resolves to the same textblock, so parent tests on
    // the endpoints are placement-independent.
    if (endA < start) { endB += start - endA; endA = start; }
    if (endB < start) { endA += start - endB; endB = start; }
    return { start, endA, endB };
}

/**
 * Localize the change between two docs to a single textblock, or return null
 * when it could have touched document structure (then the caller must do the
 * full walk). Pure.
 */
/**
 * Whether the change between two docs touches a textblock whose text `test`
 * accepts, in either doc: a block edited or added in `next`, or one removed
 * from `prev`. Cost is bounded by the changed span, never the document, so a
 * plugin whose work depends on text of one shape (a `=` for the calc cues)
 * can ask this on every edit and walk nothing when the answer is no.
 */
export function changeTouchesTextblock(prev: PmNode, next: PmNode, test: (text: string) => boolean): boolean {
    const range = changedRange(prev, next);
    if (!range) {
        return false;
    }
    const spanHas = (doc: PmNode, from: number, to: number): boolean => {
        let found = false;
        const max = doc.content.size;
        doc.nodesBetween(Math.min(from, max), Math.min(to, max), (node) => {
            if (found) { return false; }
            if (node.isTextblock) {
                if (test(node.textContent)) { found = true; }
                return false;
            }
            return true;
        });
        return found;
    };
    return spanHas(prev, range.start, range.endA) || spanHas(next, range.start, range.endB);
}

/** One top-level block replaced by one top-level block, everything else value-identical. */
export interface TopLevelBlockEdit {
    /** The block's index among the document's children, the same in both docs. */
    index: number;
    prevBlockPos: number;
    nextBlockPos: number;
    prevBlock: PmNode;
    nextBlock: PmNode;
    /** Net size change carried by the edit. */
    delta: number;
}

/**
 * The coarser sibling of `singleTextblockInlineEdit`, for the case it
 * rejects on purpose: the whole change lies inside ONE top-level block,
 * which may have been replaced rather than edited inline. Typing in a
 * heading is the common shape, because the heading-id plugin restamps the
 * heading's attrs right after the keystroke, and a node replacement puts
 * the diff at the block's boundary. Neighbouring blocks are untouched by
 * construction, so a consumer that reads per top-level block can redo this
 * one and shift the rest by `delta`. Null when more than one top-level
 * block differs, or the docs are identical.
 */
export function singleTopLevelBlockEdit(prev: PmNode, next: PmNode): TopLevelBlockEdit | null {
    const range = changedRange(prev, next);
    if (!range) {
        return null;
    }
    if (prev.childCount !== next.childCount) {
        return null;
    }
    const { start, endA, endB } = range;
    const a = prev.childAfter(Math.min(start, prev.content.size));
    const b = next.childAfter(Math.min(start, next.content.size));
    if (!a.node || !b.node || a.index !== b.index) {
        return null;
    }
    // The change must end inside the same block in both docs; a range that
    // reaches the block's end could have joined it with the next.
    if (endA > a.offset + a.node.nodeSize || endB > b.offset + b.node.nodeSize) {
        return null;
    }
    // The block after it must be the same node in both, or the change
    // reached past the boundary after all.
    if (a.index + 1 < prev.childCount && prev.child(a.index + 1) !== next.child(b.index + 1)) {
        return null;
    }
    return {
        index: a.index,
        prevBlockPos: a.offset,
        nextBlockPos: b.offset,
        prevBlock: a.node,
        nextBlock: b.node,
        delta: b.node.nodeSize - a.node.nodeSize,
    };
}

export function singleTextblockInlineEdit(prev: PmNode, next: PmNode): TextblockEdit | null {
    const range = changedRange(prev, next);
    if (!range) {
        return { kind: "identical" };
    }
    const { start, endA, endB } = range;
    const $a0 = prev.resolve(start);
    const $a1 = prev.resolve(endA);
    const $b0 = next.resolve(start);
    const $b1 = next.resolve(endB);
    if (!($a0.sameParent($a1) && $a0.parent.isTextblock)) { return null; }
    if (!($b0.sameParent($b1) && $b0.parent.isTextblock)) { return null; }
    return {
        kind: "inline",
        prevBlockPos: $a0.before($a0.depth),
        nextBlockPos: $b0.before($b0.depth),
        prevBlock: $a0.parent,
        nextBlock: $b0.parent,
        endA,
        delta: endB - endA,
    };
}
