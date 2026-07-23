/**
 * editing/listConvert.ts
 *
 * The ONE list-flavor converter: retype a list — and every list nested
 * anywhere inside it — to bullet / ordered / task, as a single transaction.
 * Every conversion surface routes here (the block menu's Turn-into via
 * retypeList, the toolbar's Lists control and the slash menu via
 * editorCommands' toggles), so "convert this list" always means the whole
 * tree: a bullet list with ordered sub-steps becomes ordered through and
 * through, never just its top layer.
 *
 * Task flavor is not a node type but a per-item `checked` attr on the same
 * bullet_list (`checked: false` makes an item a task; `null` makes it plain),
 * so a conversion is always a type retype plus an item attr sweep. Converting
 * task → task-less clears the boxes' state; converting INTO tasks preserves
 * any existing checked state (a nested task sublist keeps its ticks).
 *
 * Composition note: converting a list that sits directly beside a list of the
 * TARGET type makes them same-type siblings, and listAutoJoinPlugin then
 * merges the pair — deliberately. The conversion is the user's own edit
 * creating that adjacency, which is exactly the auto-join's mandate; the
 * result ("make this bullet too" → one bullet list) is also the only shape
 * same-marker adjacency can take in the saved markdown.
 */
import type { EditorView, ResolvedPos } from "../pm";
import type { Node as ProseNode } from "../pm";

/** The Turn-into vocabulary for lists (blockCapabilities' ConversionKind subset). */
export type ListKind = "bulletList" | "orderedList" | "taskList";

/**
 * Retype the list at `listPos` — and all nested lists — to `kind`, dispatched
 * as ONE transaction (one undo step). Returns whether anything changed.
 * Positions are computed from the pre-transaction tree; setNodeMarkup never
 * shifts positions, so a single pass over the original nodes is safe.
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
    let tr = view.state.tr;

    /** Retype one list node + sweep its items; recurse into nested lists. */
    const convert = (node: ProseNode, pos: number): void => {
        if (node.type !== targetType) {
            tr = tr.setNodeMarkup(pos, targetType, node.attrs);
        }
        const order = Number(node.attrs["order"] ?? 1);
        node.forEach((item: ProseNode, offset: number, index: number) => {
            const itemPos = pos + 1 + offset;
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
                tr = tr.setNodeMarkup(itemPos, null, { ...item.attrs, checked, listType, label });
            }
            item.forEach((child: ProseNode, childOffset: number) => {
                if (child.type === bullet || child.type === ordered) {
                    convert(child, itemPos + 1 + childOffset);
                }
            });
        });
    };
    convert(list, listPos);

    if (!tr.docChanged) {
        return false;
    }
    view.dispatch(tr);
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
