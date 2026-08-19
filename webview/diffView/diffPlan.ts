/**
 * webview/diffView/diffPlan.ts — turning document changes into hunks (MAR-55).
 *
 * `computeDocDiff` (@milkdown/plugin-diff, already load-bearing for external
 * sync and agent landing) does the hard half: a structural LCS across blocks
 * and a character-level changeset inside matched textblocks, expressed as
 * ProseMirror positions in BOTH documents. What it does not do is decide
 * anything visual — its own plugin creates no decorations at all.
 *
 * This module is that decision, and it is separated from the rendering so the
 * part with the invariants is testable without a view. A hunk keeps both
 * ranges even when one of them is empty, so it always states the whole
 * replacement: this run of the base became this run of the working document.
 * That is what lets a test rebuild the working document from the base and the
 * plan, which is the check that a position from one document has not been used
 * to index the other.
 *
 * The one judgement it makes is `deletedContext`: deleted content has to be
 * drawn somewhere in the working document, and where it lands decides what it
 * may be. A deletion inside a paragraph gets inline content; a deletion
 * between blocks gets the removed blocks themselves. Getting that backwards
 * puts a `<div>` inside a text run, which is invalid HTML the browser then
 * reparents, detaching it from the widget ProseMirror is tracking.
 *
 * Positions are NOT clamped or filtered here. A position `computeDocDiff`
 * cannot honour is a real defect, and swallowing it would leave the panel
 * silently missing hunks; the caller catches and reports instead
 * (webview/diffView/index.ts).
 */
import type { Node as ProseNode } from "../pm";

/** The shape of one `computeDocDiff` change this module reads. */
export interface DiffChangeLike {
    readonly fromA: number;
    readonly toA: number;
    readonly fromB: number;
    readonly toB: number;
}

/** What a deleted run may be drawn as, decided by where it sits in the working doc. */
export type DeletionContext = "inline" | "block";

/** A half-open range of ProseMirror positions in one document. */
export interface DiffRange {
    readonly from: number;
    readonly to: number;
}

/**
 * One reviewable unit: what changed at one place, both sides together.
 *
 * A hunk is the navigation unit as well as the rendering unit, which is why
 * the two sides stay paired rather than becoming two lists. A replacement is
 * one place a reader steps to, not two.
 */
export interface DiffHunk {
    /** Document order, from zero. */
    readonly index: number;
    /** The run in the BASE document this hunk replaced; empty for a pure insertion. */
    readonly base: DiffRange;
    /** The run in the WORKING document that replaced it; empty for a pure deletion. */
    readonly working: DiffRange;
    /** How the deleted run may be drawn, or null when nothing was deleted. */
    readonly deletedContext: DeletionContext | null;
}

/** True when the hunk added content. */
export function hasInsertion(hunk: DiffHunk): boolean {
    return hunk.working.to > hunk.working.from;
}

/** True when the hunk removed content. */
export function hasDeletion(hunk: DiffHunk): boolean {
    return hunk.base.to > hunk.base.from;
}

/**
 * Pair each change with where and how it can be drawn.
 *
 * Every change becomes a hunk, including a degenerate one that changed
 * nothing. Dropping those here would make any test asserting "every hunk
 * changed something" a tautology over the loop's own partition, and an empty
 * change from `computeDocDiff` is worth failing on rather than hiding.
 */
export function planDiffHunks(
    working: ProseNode,
    changes: readonly DiffChangeLike[],
): DiffHunk[] {
    return changes.map((change, index) => ({
        index,
        base: { from: change.fromA, to: change.toA },
        working: { from: change.fromB, to: change.toB },
        deletedContext:
            change.toA > change.fromA ? deletionContextAt(working, change.fromB) : null,
    }));
}

/**
 * Whether `pos` in `doc` can hold inline content.
 *
 * `resolve` throws for a position outside the document, and that throw is
 * deliberately not caught: it means the change came from a document other than
 * the one being rendered, which is the failure mode a diff over two documents
 * most needs to be loud about.
 */
export function deletionContextAt(doc: ProseNode, pos: number): DeletionContext {
    return doc.resolve(pos).parent.isTextblock ? "inline" : "block";
}
