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
 * advisory vs explicit) stays with each caller. `listMarkersConflict` is the
 * one exception a policy may not decide for itself: a marker change is a
 * boundary no surface may cross without being asked.
 */
import type { EditorState, EditorView, Node as ProseNode } from "../pm";
import { canJoin } from "../pm";
import { flashRange } from "./rangeIndicator";

/** Whether `node` is one of the two list container types. */
export function isListNode(node: ProseNode | null | undefined): boolean {
    const name = node?.type.name;
    return name === "bullet_list" || name === "ordered_list";
}

/** The marker characters each list type can actually print. */
const BULLET_MARKERS = new Set(["-", "*", "+"]);
const ORDERED_MARKERS = new Set([".", ")"]);

/**
 * The marker `node` will be SPELLED with, or null when it has none to defend.
 *
 * Type-scoped, and that is the whole reason this is a function rather than an
 * attr read. The two list types print from disjoint alphabets (`-`/`*`/`+`
 * against `.`/`)`), and nothing in the schema stops the attr holding a
 * character its own type cannot print; `serializeList` (plugins/sourceStyle.ts)
 * discards such a value for the global default. A marker only counts where it
 * survives to the file, so this applies the same validity test that serializer
 * does. Reading the raw attr instead makes two lists that will print
 * IDENTICALLY look like they disagree, which leaves them split for the
 * serializer to alternate apart — the exact artifact this module guards.
 *
 * A defence, not a repair: `convertListTreeAt` drops the marker it cannot carry
 * across a type change, so no caller writes such a value today. This stays
 * because the invariant is the schema's rather than any one caller's, and it is
 * held by its own test on a hand-built node so the guard cannot quietly stop
 * being exercised.
 */
export function listMarkerOf(node: ProseNode | null | undefined): string | null {
    const marker = node?.attrs["marker"];
    if (typeof marker !== "string") {
        return null;
    }
    const valid = node?.type.name === "ordered_list" ? ORDERED_MARKERS : BULLET_MARKERS;
    return valid.has(marker) ? marker : null;
}

/**
 * Whether two same-type lists are SPELLED differently in the file: a bullet
 * `-` against a `*`, or an ordered `.` against a `)`. A list with no recorded
 * marker has no spelling to defend and conflicts with nothing, so a list the
 * editor created still folds into whatever it lands beside.
 *
 * This is the one fact that separates a boundary worth keeping from an editing
 * artifact, and it is why the auto-join's mandate stops here. Markdown CAN say
 * a marker change — `- a` then `* b` parses as two lists, and
 * docs/DESIGN_PRINCIPLES.md puts a bullet character and an ordered delimiter on
 * the source side of the presentation line — so a differently-spelled pair
 * serializes as the two lists it is and reparses that way. A same-spelled pair
 * cannot: the serializer alternates the second one's bullet to keep the pair
 * apart (`bulletOther`), inventing a split the author never made, which is the
 * artifact the auto-join exists to prevent.
 *
 * The verdict is deliberately NOT part of `isSameTypeListBoundary` below: a
 * marker change is a boundary nothing may cross SILENTLY, while merging two
 * differently-spelled lists on purpose stays a thing a user can ask for, so
 * the block menu's Merge rows and the caret advisory still offer it.
 *
 * Takes marker values rather than nodes, because the typed side of an input
 * rule has a character and no node yet (plugins/listMarkerInput.ts). Read a
 * node's side with `listMarkerOf` above, never the raw attr.
 */
export function listMarkersConflict(
    a: string | null | undefined,
    b: string | null | undefined,
): boolean {
    return typeof a === "string" && typeof b === "string" && a !== b;
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
