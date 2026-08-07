/**
 * editing/listConvert.ts
 *
 * The ONE list-flavor converter: retype a list — and the lists nested inside it
 * — to bullet / ordered / task, as a single transaction. Every conversion
 * surface routes here (the block menu's Turn-into via retypeList, the toolbar's
 * Lists control and the slash menu via editorCommands' toggles).
 *
 * WHICH nested lists: those that are the SAME KIND as the one you selected. A
 * sublist of a DIFFERENT kind was deliberately made different — by the block
 * menu, or by typing its marker (plugins/listMarkerInput.ts) — and a conversion
 * aimed at its parent is not a request to undo that. So
 *
 *     - item                 - [ ] item
 *       1. foo        →        1. foo         "make this a task list"
 *         - bar                  - [ ] bar
 *
 * converts the two bullet lists and leaves the numbered one numbered.
 *
 * THAT IS A PREDICATE, NOT A PRUNE, and `bar` above is the case that shows the
 * difference: it sits UNDER the exempt list and is still converted, because it
 * is itself the selected kind. Pruning at the first mismatch would make a
 * conversion's reach depend on where the alternation happened to fall rather
 * than on what each list is, so the same "make this a task list" would treat
 * two identical-looking bullet lists differently.
 *
 * The whole-tree rule this replaced converted EVERY nested list unconditionally
 * (`- item / 1. foo` came back fully ordered). That was written when a mixed
 * tree could only be built through the gutter menu; it now destroys, in one
 * click, a structure the keyboard can build in three keystrokes.
 *
 * KNOWN SHARP EDGE. Task flavor is not a node type but a per-item `checked`
 * attr on the same bullet_list (`checked: false` makes an item a task; `null`
 * makes it plain), so it is ORTHOGONAL to bullet-vs-ordered — `1. [ ] step` is
 * valid GFM and round-trips. Reading it as a third kind is therefore a choice,
 * and its cost is the `1. foo` line above: converting an outline to a checklist
 * leaves the numbered branch without boxes, which can read as a hole. It is the
 * choice the UI already makes (Task List is a peer row of Bullet and Numbered
 * in every menu), and it is the conservative direction — it changes less, and
 * the branch is one gesture away if you want it boxed too (maintainer ruling,
 * 2026-08-07). Converting task → task-less clears the boxes; converting INTO
 * tasks preserves any existing checked state.
 *
 * Composition note: converting a list that sits directly beside a list of the
 * TARGET type makes them same-type siblings, and listAutoJoinPlugin then
 * merges the pair — deliberately. The conversion is the user's own edit
 * creating that adjacency, which is exactly the auto-join's mandate; the
 * result ("make this bullet too" → one bullet list) is also the only shape
 * same-marker adjacency can take in the saved markdown.
 */
import type { EditorView, ResolvedPos, Transaction } from "../pm";
import type { Node as ProseNode } from "../pm";
import { Fragment, TextSelection } from "../pm";

/** The Turn-into vocabulary for lists (blockCapabilities' ConversionKind subset). */
export type ListKind = "bulletList" | "orderedList" | "taskList";

/**
 * Retype the list at `listPos` — and every nested list of the SAME KIND (see
 * the header) — to `kind`, dispatched as ONE transaction (one undo step).
 * Returns whether anything changed. Positions are computed from the
 * pre-transaction tree; setNodeMarkup never shifts positions, so a single pass
 * over the original nodes is safe, and every `listKindOf` probe below reads
 * that original tree rather than a partly-converted one.
 */
export function convertListTreeAt(
    view: EditorView,
    listPos: number,
    kind: ListKind,
): boolean {
    const doc = view.state.doc;
    const list = doc.nodeAt(listPos);
    const bullet = view.state.schema.nodes["bullet_list"];
    const ordered = view.state.schema.nodes["ordered_list"];
    if (!list || !bullet || !ordered) {
        return false;
    }
    if (list.type !== bullet && list.type !== ordered) {
        return false;
    }
    const targetType = kind === "orderedList" ? ordered : bullet;
    // The kind the user pointed at, which is what every nested list is measured
    // against. Read once, off the original tree.
    const sourceKind = listKindOf(list);
    let tr = view.state.tr;

    /**
     * Walk one list node. `retype` is false for a list of a different kind: it
     * and its items are left exactly as they are, and the walk still DESCENDS
     * through them, because a deeper list of the selected kind is still in
     * scope (the `bar` case in the header).
     */
    const walk = (node: ProseNode, pos: number, retype: boolean): void => {
        if (retype && node.type !== targetType) {
            tr = tr.setNodeMarkup(pos, targetType, node.attrs);
        }
        const order = Number(node.attrs["order"] ?? 1);
        node.forEach((item: ProseNode, offset: number, index: number) => {
            const itemPos = pos + 1 + offset;
            if (retype) {
                // Task flavor: preserve an existing checked state when converting
                // INTO tasks (a ticked box survives), clear it when leaving.
                const prior = item.attrs["checked"] ?? null;
                const checked: boolean | null =
                    kind === "taskList" ? (typeof prior === "boolean" ? prior : false) : null;
                // The item's own flavor attrs must follow the list type: Milkdown's
                // syncListOrderPlugin retypes any bullet_list whose FIRST item still
                // says `listType: "ordered"` back to ordered (with a string spread),
                // so leaving these stale silently reverts the conversion.
                const listType = kind === "orderedList" ? "ordered" : "bullet";
                const label = kind === "orderedList" ? `${index + order}.` : "•";
                if (
                    prior !== checked ||
                    item.attrs["listType"] !== listType ||
                    item.attrs["label"] !== label
                ) {
                    tr = tr.setNodeMarkup(itemPos, null, {
                        ...item.attrs,
                        checked,
                        listType,
                        label,
                    });
                }
            }
            item.forEach((child: ProseNode, childOffset: number) => {
                if (child.type === bullet || child.type === ordered) {
                    walk(child, itemPos + 1 + childOffset, listKindOf(child) === sourceKind);
                }
            });
        });
    };
    // The selected list always converts, whatever its kind — it is the one the
    // user pointed at, and `sourceKind` is read FROM it.
    walk(list, listPos, true);

    if (!tr.docChanged) {
        return false;
    }
    view.dispatch(tr);
    return true;
}

/**
 * The bullet/ordered axis a TYPED marker asks for. Task-ness is deliberately
 * absent: it is a per-item `checked` attr that rides either list type
 * (`1. [ ] step` is valid GFM), so a marker never carries it — see
 * plugins/listMarkerInput.ts.
 */
export interface ItemMarkerSpec {
    kind: "bulletList" | "orderedList";
    /** The number the user typed, as the new list's `order`. Bullets ignore it. */
    order?: number;
    /** The marker character typed, recorded as the new list's source style. */
    marker?: string;
}

/**
 * Retype ONE list item's flavor, splitting its list — the transform behind a
 * marker typed at the head of an item (plugins/listMarkerInput.ts). Stages onto
 * `tr` rather than dispatching, because an input rule must RETURN its
 * transaction (the `appendMove` precedent in editing/moveBlocks.ts).
 *
 * THE SCOPE IS THE ITEM, AND THAT IS THE WHOLE POINT — the deliberate opposite
 * of `convertListTreeAt` above, which every menu surface uses to convert a tree
 * through and through. A marker is a claim about ONE LINE. In Markdown a
 * marker change at the same indent IS a new list, so
 *
 *     - alpha        - alpha
 *     - beta    →    1. beta      three lists, exactly what the bytes say
 *     - gamma        - gamma
 *
 * and the split is visible (three blocks, three gutter handles), which is the
 * document the user now has. Converting the siblings instead would rewrite
 * lines the user never touched.
 *
 * The item's own subtree travels INSIDE it, untouched. That is what makes this
 * the surface that can build mixed nesting — indent, type `1. `, and the
 * sublist is ordered while its parent stays bulleted.
 *
 * Returns false without touching `tr` when the item is already that flavor
 * (the caller then leaves the typed characters as literal text) or `itemPos`
 * is not a list item's position.
 */
export function retypeListItemAt(
    tr: Transaction,
    itemPos: number,
    spec: ItemMarkerSpec,
): boolean {
    const $item = tr.doc.resolve(itemPos);
    const list = $item.parent;
    const schema = list.type.schema;
    const bullet = schema.nodes["bullet_list"];
    const ordered = schema.nodes["ordered_list"];
    if (!bullet || !ordered || (list.type !== bullet && list.type !== ordered)) {
        return false;
    }
    const target = spec.kind === "orderedList" ? ordered : bullet;
    if (list.type === target) {
        return false;
    }
    const index = $item.index();
    const items: ProseNode[] = [];
    list.forEach((child) => items.push(child));
    const item = items[index];
    if (!item || item.type !== schema.nodes["list_item"]) {
        return false;
    }

    const order = spec.kind === "orderedList" ? Math.max(0, spec.order ?? 1) : 1;
    // The item's own flavor attrs must follow the list type in the SAME
    // transaction: listOrderSync retypes any bullet_list whose first item still
    // says `listType: "ordered"` straight back to ordered, so a stale attr here
    // silently reverts the retype (the same landmine convertListTreeAt records).
    const listType = spec.kind === "orderedList" ? "ordered" : "bullet";
    const label = spec.kind === "orderedList" ? `${order}.` : "•";
    // A recorded source gap belongs to the position in the list this item is
    // LEAVING; as a first item it has nothing before it to gap from (MAR-210).
    const mid = item.type.create(
        { ...item.attrs, listType, label, blankBefore: null },
        item.content,
        item.marks,
    );
    const midAttrs =
        spec.kind === "orderedList"
            ? {
                  spread: list.attrs["spread"],
                  order,
                  marker: spec.marker ?? null,
                  incrementMarker: null,
              }
            : { spread: list.attrs["spread"], marker: spec.marker ?? null };
    const midList = target.create(midAttrs, Fragment.from([mid]));
    if (!midList) {
        return false;
    }

    const blocks: ProseNode[] = [];
    if (index > 0) {
        blocks.push(list.copy(Fragment.from(items.slice(0, index))));
    }
    blocks.push(midList);
    if (index + 1 < items.length) {
        const tail = items.slice(index + 1);
        const first = tail[0];
        tail[0] = first.type.create(
            { ...first.attrs, blankBefore: null },
            first.content,
            first.marks,
        );
        // An ordered tail keeps the numbers it was already SHOWING rather than
        // restarting at 1 — the split moved the items, not their numbering.
        const tailAttrs =
            list.type === ordered
                ? { ...list.attrs, order: Number(list.attrs["order"] ?? 1) + index + 1 }
                : list.attrs;
        blocks.push(list.type.create(tailAttrs, Fragment.from(tail)));
    }

    // The caret's offset INSIDE the item is preserved verbatim: the item's
    // content is re-created unchanged (only its attrs move), so the same
    // relative position is the same place in the same text. A caret that was
    // not in this item to begin with is left to the transaction's own mapping —
    // this transform has no opinion about where an unrelated selection belongs.
    const caret = tr.selection.from;
    const caretInItem =
        caret > itemPos && caret < itemPos + item.nodeSize ? caret - itemPos : null;
    const listPos = $item.before();
    tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.from(blocks));
    if (caretInItem !== null) {
        const midItemPos = listPos + (index > 0 ? blocks[0].nodeSize : 0) + 1;
        tr.setSelection(TextSelection.near(tr.doc.resolve(midItemPos + caretInItem), 1));
    }
    return true;
}

/**
 * The OUTERMOST list containing `$pos`, as {pos, node}, or null when the
 * position is not inside a list — the conversion TARGET (a caret anywhere in
 * a tree converts the whole tree, matching the block menu, whose item
 * markers also target the enclosing list). The toggle-off test uses
 * `innermostListAt` instead: flavor identity at the caret is the list the
 * caret is actually in (the one the toolbar's active state highlights).
 * Both take a ResolvedPos (a selection's own `$from` works directly).
 */
export function outermostListAt(
    $pos: ResolvedPos,
): { pos: number; node: ProseNode } | null {
    for (let depth = 1; depth <= $pos.depth; depth++) {
        const node = $pos.node(depth);
        const name = node.type.name;
        if (name === "bullet_list" || name === "ordered_list") {
            return { pos: $pos.before(depth), node };
        }
    }
    return null;
}

/** The INNERMOST list containing `$pos` (see outermostListAt). */
export function innermostListAt(
    $pos: ResolvedPos,
): { pos: number; node: ProseNode } | null {
    for (let depth = $pos.depth; depth >= 1; depth--) {
        const node = $pos.node(depth);
        const name = node.type.name;
        if (name === "bullet_list" || name === "ordered_list") {
            return { pos: $pos.before(depth), node };
        }
    }
    return null;
}

/** The current flavor of a list node: ordered, task (any item carries a
 * checked attr — the classifier blockCapabilities uses reads the first item),
 * or plain bullet. */
export function listKindOf(node: ProseNode): ListKind {
    if (node.type.name === "ordered_list") {
        return "orderedList";
    }
    return node.firstChild?.attrs["checked"] != null ? "taskList" : "bulletList";
}
