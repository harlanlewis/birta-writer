/**
 * Pure table-reorder helpers, kept free of DOM and EditorView so they can be
 * unit-tested directly. handles.ts wires the drag interaction to these.
 */
import type { Node as PMNode } from "@milkdown/prose/model";

/**
 * Maps a drop gesture to a destination index in the array AFTER the source
 * element has been spliced out.
 *
 * @param fromIdx      source row/column index
 * @param targetIdx    the row/column the pointer is over at drop time
 * @param insertBefore true when dropping on the leading half of the target
 * @returns the destination index to pass to reorderRow/reorderColumn
 */
export function resolveDropIndex(
    fromIdx: number,
    targetIdx: number,
    insertBefore: boolean,
): number {
    return resolveDropIndexRange(fromIdx, fromIdx, targetIdx, insertBefore);
}

/**
 * Range-aware generalization of {@link resolveDropIndex}: maps a drop gesture
 * to a destination index in the array AFTER a contiguous block [from0..from1]
 * (inclusive) has been spliced out.
 *
 * Dropping anywhere inside the block itself is a no-op and returns `from0`
 * (the block's own start), so a subsequent reorder is the identity.
 *
 * @param from0        first index of the dragged block (inclusive)
 * @param from1        last index of the dragged block (inclusive)
 * @param targetIdx    the row/column the pointer is over at drop time
 * @param insertBefore true when dropping on the leading half of the target
 * @returns the destination index to pass to reorderRowRange/reorderColumnRange
 */
export function resolveDropIndexRange(
    from0: number,
    from1: number,
    targetIdx: number,
    insertBefore: boolean,
): number {
    const size = from1 - from0 + 1;
    // Gap position in the ORIGINAL array (0 .. length).
    const finalTo = insertBefore ? targetIdx : targetIdx + 1;
    // Gaps strictly inside the block (from0+1 .. from1) mean "no move".
    if (finalTo > from0 && finalTo <= from1) {
        return from0;
    }
    // Everything the block occupied before `finalTo` shifts it left by `size`.
    return finalTo > from1 ? finalTo - size : finalTo;
}

/** Returns a copy of `tableNode` with row `from` moved to index `to`. */
export function reorderRow(tableNode: PMNode, from: number, to: number): PMNode {
    const rows: PMNode[] = [];
    tableNode.forEach((r) => rows.push(r));
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    return tableNode.type.create(tableNode.attrs, rows, tableNode.marks);
}

/**
 * Returns a copy of `tableNode` with column `from` moved to index `to` in
 * every row.
 */
export function reorderColumn(
    tableNode: PMNode,
    from: number,
    to: number,
): PMNode {
    const newRows: PMNode[] = [];
    tableNode.forEach((row) => {
        const cells: PMNode[] = [];
        row.forEach((c) => cells.push(c));
        const [cell] = cells.splice(from, 1);
        cells.splice(to, 0, cell);
        newRows.push(row.type.create(row.attrs, cells, row.marks));
    });
    return tableNode.type.create(tableNode.attrs, newRows, tableNode.marks);
}

/**
 * Returns a copy of `tableNode` with the contiguous block of rows
 * [from0..from1] (inclusive) moved so it starts at index `to` (a post-splice
 * index in the array with the block already removed).
 *
 * Header guard: the header is always row 0, so a block that includes row 0
 * cannot move, and no block may be dropped above the header (`to === 0`). In
 * either case the original node is returned unchanged.
 */
export function reorderRowRange(
    tableNode: PMNode,
    from0: number,
    from1: number,
    to: number,
): PMNode {
    if (from0 <= 0 || to <= 0) {
        return tableNode; // header may not move, and nothing above it
    }
    const rows: PMNode[] = [];
    tableNode.forEach((r) => rows.push(r));
    const block = rows.splice(from0, from1 - from0 + 1);
    rows.splice(to, 0, ...block);
    return tableNode.type.create(tableNode.attrs, rows, tableNode.marks);
}

/**
 * Returns a copy of `tableNode` with the contiguous block of columns
 * [from0..from1] (inclusive) moved so it starts at index `to` (post-splice) in
 * every row. Columns have no header constraint.
 */
export function reorderColumnRange(
    tableNode: PMNode,
    from0: number,
    from1: number,
    to: number,
): PMNode {
    const newRows: PMNode[] = [];
    tableNode.forEach((row) => {
        const cells: PMNode[] = [];
        row.forEach((c) => cells.push(c));
        const block = cells.splice(from0, from1 - from0 + 1);
        cells.splice(to, 0, ...block);
        newRows.push(row.type.create(row.attrs, cells, row.marks));
    });
    return tableNode.type.create(tableNode.attrs, newRows, tableNode.marks);
}
