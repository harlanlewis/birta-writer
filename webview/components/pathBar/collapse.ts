/**
 * components/pathBar/collapse.ts
 *
 * Which of the path bar's segments fold into its `…` at a given width.
 *
 * The middle goes first, nearest the root first, so the folders closest to
 * the file are the last to go: they are the ones that say where the file is,
 * and the root says which disk or cloud. When even the root and the file do
 * not fit beside the `…`, the root folds too, and the file's own name is the
 * one thing left, truncated by CSS rather than folded.
 *
 * Pure over measured widths, so the whole order is testable without a layout
 * engine, and a resize re-plans from numbers already taken rather than
 * reflowing once per segment.
 */

/**
 * The indices to fold, ascending, or an empty list when everything fits.
 *
 * @param widths each segment's natural width, chevron included, root first and
 *   the file last.
 * @param ellipsis the width the `…` takes, chevron included, when shown.
 * @param available the room the bar has.
 */
export function foldedSegments(widths: readonly number[], ellipsis: number, available: number): number[] {
    const n = widths.length;
    const total = (folded: ReadonlySet<number>): number =>
        widths.reduce((sum, w, i) => (folded.has(i) ? sum : sum + w), 0) + (folded.size ? ellipsis : 0);
    // The file never folds; the root folds last.
    const order = [...Array.from({ length: Math.max(0, n - 2) }, (_, i) => i + 1), ...(n > 1 ? [0] : [])];
    const folded = new Set<number>();
    if (total(folded) <= available) { return []; }
    for (const index of order) {
        folded.add(index);
        if (total(folded) <= available) { break; }
    }
    return [...folded].sort((a, b) => a - b);
}
