/**
 * editing/checklistSink.ts (MAR-175)
 *
 * Self-sinking checklists: when a task item is CHECKED it drops just below the
 * still-unchecked siblings in its list, and UNCHECKING floats it back up to the
 * bottom of the unchecked group. Opt-in (`birta.checklist.sinkChecked`, default
 * OFF); when off, `webview/index.ts` does a plain in-place flip and never calls
 * in here at all.
 *
 * The design pivot is ONE undo step. The naive path — flip the checkbox, then
 * ask `moveBlocks` to relocate — is two dispatches, so a single Cmd+Z would
 * leave the box toggled but the row still moved (or vice-versa). Instead we fold
 * BOTH into a single transaction: `appendMove` (the tr-building core split out
 * of `moveBlocks` for exactly this) stages the delete+insert on our own tr, and
 * we add the checkbox flip as a position-preserving `setNodeMarkup` at the
 * item's landing position. One tr, one dispatch, one undo.
 *
 * Why flip AFTER the move rather than before: `appendMove` re-inserts the
 * ORIGINAL node objects (its fragment is read from the pre-move doc), so a flip
 * staged first would be discarded with the deleted range. Flipping at the
 * landing position (`moved.insertAt`) mutates the node that actually survives.
 * The flip is an attr change — invisible to the content-guard fingerprint — so
 * the "move" tag `appendMove` set still holds and the combined tr is not vetoed.
 *
 * Nesting is automatic: `appendMove` moves a `list_item` and its nested sublist
 * as ONE child (the sublist lives inside the item), and the sibling scan below
 * only ever looks at the moving item's OWN parent, so a parent item carries its
 * subtree and never reorders across lists.
 *
 * Animation: there is NO literal slide. Per the house rule (rangeIndicator.ts)
 * we never mutate class/opacity/transform on the ProseMirror-managed `<li>` —
 * that wakes PM's DOM observer and destroys gutter widgets — so the feedback is
 * `moveBlocks`' existing body-mounted landing flash, a quiet advisory highlight.
 */
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { appendMove } from "./moveBlocks";
import { flashRange } from "./rangeIndicator";

/**
 * The boundary position a task item at `itemPos` should move to when its
 * checked state becomes `newChecked`, or null when no move is warranted — the
 * item is already correctly placed, or it is not inside a reorderable list.
 * Pure (document + position in, position out) so the reorder rule is unit
 * testable without a live view.
 *
 * Both directions target the SAME boundary: just after the last still-unchecked
 * sibling (excluding the moving item). Checking sinks the item down to the top
 * of the checked group; unchecking floats it up to the bottom of the unchecked
 * group — the symmetric inverse. `checked === false` is the "unchecked task"
 * test: non-task siblings carry `checked === null` and are left out of the sort.
 */
export function sinkTargetPos(
    doc: ProseNode,
    itemPos: number,
    newChecked: boolean,
): number | null {
    const $pos = doc.resolve(itemPos);
    // depth 0 means the position is at the top level (not inside any parent),
    // so there is no sibling list to sort within.
    if ($pos.depth === 0) {
        return null;
    }
    const parent = $pos.parent;
    const movingIndex = $pos.index();

    // The greatest-index sibling (excluding the mover) that is still UNCHECKED —
    // the checked group begins immediately after it. Non-task items (checked ===
    // null) are neither checked nor unchecked, so they never move the boundary.
    let lastUnchecked = -1;
    parent.forEach((child, _offset, index) => {
        if (index !== movingIndex && child.attrs["checked"] === false) {
            lastUnchecked = index;
        }
    });

    let targetIndex: number;
    if (newChecked) {
        // CHECK: drop just below the last unchecked sibling. With no unchecked
        // siblings there is nothing to sink below — leave the item where it is
        // (any order among an all-checked group already satisfies the invariant).
        if (lastUnchecked === -1) {
            return null;
        }
        targetIndex = lastUnchecked + 1;
    } else {
        // UNCHECK: float up to become the last unchecked item (just after the
        // current last unchecked). With none unchecked it becomes the first and
        // only one, at the top of the list (targetIndex 0).
        targetIndex = lastUnchecked + 1;
    }

    const targetPos = $pos.posAtIndex(targetIndex);
    // A target inside/adjacent to the mover is `appendMove`'s put-it-back no-op;
    // report it as "no move" so the caller does a plain flip instead of staging
    // a wasted transaction.
    const item = parent.child(movingIndex);
    const source = { from: itemPos, to: itemPos + item.nodeSize };
    if (targetPos >= source.from && targetPos <= source.to) {
        return null;
    }
    return targetPos;
}

/**
 * Toggle the task item at `itemPos` to `newChecked`. With `sink` off (or when
 * no relocation is warranted / possible) this is exactly the historical plain
 * in-place flip. With `sink` on and a move warranted, the flip and the
 * relocation land as ONE transaction (one undo step) and the landing flashes.
 */
export function applyTaskToggle(
    view: EditorView,
    itemPos: number,
    newChecked: boolean,
    sink: boolean,
): void {
    const { state } = view;
    const node = state.doc.nodeAt(itemPos);
    if (!node) {
        return;
    }
    const flippedAttrs = { ...node.attrs, checked: newChecked };
    // The plain in-place flip — the OFF path, and the fallback whenever a
    // relocation is refused so the checkbox still toggles.
    const plainFlip = () => {
        view.dispatch(view.state.tr.setNodeMarkup(itemPos, null, flippedAttrs));
    };

    if (!sink) {
        plainFlip();
        return;
    }

    const target = sinkTargetPos(state.doc, itemPos, newChecked);
    if (target === null) {
        plainFlip();
        return;
    }

    const source = { from: itemPos, to: itemPos + node.nodeSize };
    const tr = state.tr;
    const moved = appendMove(tr, state, source, target);
    if (!moved) {
        // Put-it-back no-op, a contract refusal, the insert backstop, or a
        // save-survival hazard — `tr` may be partially staged, so fall back to
        // a FRESH plain-flip tr rather than dispatching it.
        plainFlip();
        return;
    }
    // Flip the checkbox at the item's NEW position, in the SAME transaction.
    // The move re-inserted the original node (its old checked value); this attr
    // change is fingerprint-invisible, so the content-guard tag still holds.
    tr.setNodeMarkup(moved.insertAt, null, flippedAttrs);

    const docBefore = state.doc;
    view.dispatch(tr);
    if (view.state.doc === docBefore) {
        // A content-guard veto left the document untouched (defensive — a flip +
        // conserving move should never trip it). Retry as a plain flip so the
        // user's click is not silently swallowed.
        plainFlip();
        return;
    }
    view.focus();
    // Landing flash at the destination — the quiet, advisory feedback (no slide;
    // see the module header on the house rule).
    flashRange(view, moved.insertAt, moved.insertAt + moved.contentSize);
}

/**
 * Uncheck every checked task item in the checklist containing the selection, in
 * ONE transaction (one undo step) — the "clear a checklist for reuse" command.
 * No reordering is needed: once nothing is checked, there is nothing to sink. A
 * caret outside any list is a no-op (returns false).
 *
 * Scope is the OUTERMOST ancestor list: "Uncheck All" means the whole
 * checklist, so invoking it from a nested sub-item clears the entire tree, not
 * just the sublist the caret happens to sit in. (Two checklists separated by a
 * paragraph are separate trees — only the caret's own tree is cleared.)
 */
export function uncheckAllTasks(view: EditorView): boolean {
    const { state } = view;
    const { $from } = state.selection;

    // Outermost ancestor list of the caret; no list → nothing to clear.
    let listDepth = -1;
    for (let depth = 1; depth <= $from.depth; depth++) {
        const name = $from.node(depth).type.name;
        if (name === "bullet_list" || name === "ordered_list") {
            listDepth = depth;
            break;
        }
    }
    if (listDepth < 0) {
        return false;
    }

    const listPos = $from.before(listDepth);
    const list = $from.node(listDepth);
    const tr = state.tr;
    let changed = false;
    // Absolute positions from nodesBetween; setNodeMarkup is position-preserving,
    // so every position computed on the original doc stays valid across the batch.
    state.doc.nodesBetween(listPos, listPos + list.nodeSize, (child, pos) => {
        if (child.type.name === "list_item" && child.attrs["checked"] === true) {
            tr.setNodeMarkup(pos, null, { ...child.attrs, checked: false });
            changed = true;
        }
    });
    if (changed) {
        view.dispatch(tr);
    }
    // A list with nothing checked is still "handled" — the command found its
    // target and simply had no work, which is not the same as "no list here".
    return true;
}
