/**
 * editing/listMerge.ts
 *
 * The ONE answer to "can these two adjacent lists become one, and where?" —
 * shared by every merge surface: the auto-join plugin (plugins/list.ts), the
 * block menu's Merge rows (components/blockMenu/menu.ts), and the caret
 * advisory (plugins/listMergeSuggest.ts).
 *
 * Background: markdown itself merges blank-line-separated same-marker lists
 * at parse time, so two sibling list NODES only exist when the source split
 * them deliberately (a `-`→`*` marker change, an HTML comment) or an edit
 * made them adjacent (deleting the paragraph between two lists, a block
 * move, a turn-into). Serializing two adjacent sibling lists alternates the
 * bullet marker (mdast-util-to-markdown's `bulletOther`) — which is exactly
 * how a transient editing artifact becomes a durable source-level split.
 * These helpers give every surface the same, canJoin-backed verdict on
 * whether a boundary is mergeable; the POLICY of when to merge (auto vs
 * advisory vs explicit) stays with each caller.
 */
import type { EditorState, EditorView, Node as ProseNode } from "../pm";
import { canJoin } from "../pm";
import { flashRange } from "./rangeIndicator";

/** Whether `node` is one of the two list container types. */
export function isListNode(node: ProseNode | null | undefined): boolean {
    const name = node?.type.name;
    return name === "bullet_list" || name === "ordered_list";
}

/**
 * Whether `pos` sits exactly between two sibling lists of the same type.
 * Pure structural probe (no canJoin) — the auto-join plugin uses it against
 * the OLD doc to tell a pre-existing split from one the edit just created.
 * Returns false (never throws) for any position that isn't such a boundary.
 */
export function isSameTypeListBoundary(doc: ProseNode, pos: number): boolean {
    if (pos < 0 || pos > doc.content.size) {
        return false;
    }
    const $pos = doc.resolve(pos);
    const before = $pos.nodeBefore;
    const after = $pos.nodeAfter;
    return before !== null && after !== null && before.type === after.type && isListNode(before);
}

/**
 * The joinable boundary next to the list at `listPos`, in `dir` (-1 = the
 * sibling above, 1 = below), or null when the neighbor is not a same-type
 * list (or the join is structurally refused). This is what decides whether a
 * "Merge with list above/below" affordance exists at all.
 */
export function mergeableListBoundary(
    doc: ProseNode,
    listPos: number,
    dir: -1 | 1,
): number | null {
    const node = doc.nodeAt(listPos);
    if (!node || !isListNode(node)) {
        return null;
    }
    const boundary = dir === -1 ? listPos : listPos + node.nodeSize;
    return isSameTypeListBoundary(doc, boundary) && canJoin(doc, boundary) ? boundary : null;
}

/**
 * The mergeable boundary ABOVE the innermost list holding the caret, or null.
 * Deliberately narrow — this is the caret advisory's trigger, and it must
 * only fire right where the merge would happen: an empty selection, in the
 * FIRST item of its list, with a same-type sibling list directly above.
 * Innermost wins, so a caret in a nested sublist probes the sublist's own
 * neighbor, never the outer list's.
 */
export function caretMergeBoundary(state: EditorState): number | null {
    const { selection } = state;
    if (!selection.empty) {
        return null;
    }
    const $from = selection.$from;
    for (let depth = $from.depth; depth >= 2; depth--) {
        if ($from.node(depth).type.name !== "list_item") {
            continue;
        }
        // First item of its list, or the boundary is not at the caret.
        if ($from.index(depth - 1) !== 0) {
            return null;
        }
        return mergeableListBoundary(state.doc, $from.before(depth - 1), -1);
    }
    return null;
}

/**
 * Join the two lists meeting at `boundary` as one undo step, re-verifying
 * the boundary against the CURRENT doc (menu/advisory callers computed it
 * against an earlier state). Flashes the merged list — the join's only other
 * visible effect is subtle spacing, so the flash answers "what happened".
 */
export function mergeListsAt(view: EditorView, boundary: number): boolean {
    const doc = view.state.doc;
    if (!isSameTypeListBoundary(doc, boundary) || !canJoin(doc, boundary)) {
        return false;
    }
    const mergedFrom = boundary - (doc.resolve(boundary).nodeBefore?.nodeSize ?? 0);
    const mergedTo = boundary + (doc.resolve(boundary).nodeAfter?.nodeSize ?? 0);
    view.dispatch(view.state.tr.join(boundary).scrollIntoView());
    view.focus();
    // The join removed the two adjoining tokens, so the merged list ends 2
    // positions earlier than the old pair's span.
    flashRange(view, mergedFrom, mergedTo - 2);
    return true;
}
