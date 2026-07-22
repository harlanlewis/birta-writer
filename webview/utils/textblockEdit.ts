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

/**
 * Localize the change between two docs to a single textblock, or return null
 * when it could have touched document structure (then the caller must do the
 * full walk). Pure.
 */
export function singleTextblockInlineEdit(prev: PmNode, next: PmNode): TextblockEdit | null {
    const start = prev.content.findDiffStart(next.content);
    if (start == null) {
        return { kind: "identical" };
    }
    const diff = prev.content.findDiffEnd(next.content);
    if (!diff) {
        return { kind: "identical" };
    }
    let { a: endA, b: endB } = diff;
    // Repeated content ("aa" → "aaa") lets the end scan overrun the start; clamp
    // to a consistent placement (readDOMChange's normalization). Any placement
    // inside the repeated run resolves to the same textblock, so the parent test
    // below is placement-independent.
    if (endA < start) { endB += start - endA; endA = start; }
    if (endB < start) { endA += start - endB; endB = start; }
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
