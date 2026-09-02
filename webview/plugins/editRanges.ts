/**
 * webview/plugins/editRanges.ts — what a transaction touched, so a decoration
 * plugin can redo that and map the rest (MAR-431).
 *
 * A decoration set is a tree shaped to the document it was built from.
 * Across an edit, `set.map(tr.mapping, tr.doc)` carries every untouched
 * decoration to where the edit put it, so the only work an edit owes is the
 * blocks it changed. These helpers name those blocks from the transaction's
 * own step maps, which is the one source that is proportional to the edit:
 * `plugins/htmlLivePairs.ts` and `list.ts`'s `taskListItemsTouched` read
 * them the same way, and a plugin that walks the document instead pays the
 * whole document on every keystroke (AGENTS.md, "Launch performance").
 *
 * A range is in `tr.doc`'s coordinates: each step's range lands in the
 * document that step produced, so it is carried through the steps after it.
 */
import type { Node as ProseNode, Transaction } from "../pm";

export interface EditRange {
    from: number;
    to: number;
}

/** The ranges of `tr.doc` the transaction's steps touched, clamped to the document. */
export function touchedRanges(tr: Transaction): EditRange[] {
    const size = tr.doc.content.size;
    const out: EditRange[] = [];
    tr.mapping.maps.forEach((stepMap, i) => {
        const rest = tr.mapping.slice(i + 1);
        stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            out.push({
                from: Math.max(0, Math.min(rest.map(newStart, -1), size)),
                to: Math.max(0, Math.min(rest.map(newEnd, 1), size)),
            });
        });
    });
    return out;
}

/**
 * Call `cb` once for each TOP-LEVEL block of `doc` that any of `ranges`
 * touches, in document order, with the block's node, position and index. A
 * range that sits on a boundary between two blocks touches both, which is
 * the conservative reading: a split or a join changes both neighbours.
 */
export function forEachTouchedTopLevel(
    doc: ProseNode,
    ranges: readonly EditRange[],
    cb: (node: ProseNode, pos: number, index: number) => void,
): number {
    if (ranges.length === 0 || doc.childCount === 0) return 0;
    // Blocks are found from the range's own start, never by walking the
    // document from the top: that walk is what this helper exists to avoid.
    const found = new Map<number, { node: ProseNode; pos: number }>();
    for (const { from, to } of ranges) {
        const size = doc.content.size;
        let { index, offset } = doc.childAfter(Math.min(from, size));
        // At the very end, or exactly on a boundary, the block BEFORE is
        // touched too: `childAfter` names the next block, and a split or a
        // join at a boundary changes both neighbours.
        if (index > 0 && (index >= doc.childCount || (offset === from && from > 0))) {
            index -= 1;
            offset -= doc.child(index).nodeSize;
        }
        for (let i = index; i < doc.childCount; i++) {
            const child = doc.child(i);
            if (offset > to) break;
            found.set(i, { node: child, pos: offset });
            offset += child.nodeSize;
        }
    }
    const order = [...found.keys()].sort((a, b) => a - b);
    for (const i of order) {
        const { node, pos } = found.get(i)!;
        cb(node, pos, i);
    }
    return order.length;
}
