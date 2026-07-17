import { schemaCtx } from "@milkdown/core";
import { getView, keymap } from "../pm";
import { Fragment } from "../pm";
import type { Node as ProseNode, NodeType } from "../pm";
import { TextSelection } from "../pm";
import type { EditorState, Transaction } from "../pm";
import { sinkListItem } from "../pm";
import { $prose } from "@milkdown/utils";

function isListNode(node: ProseNode | null | undefined): node is ProseNode {
    return !!node && (node.type.name === "bullet_list" || node.type.name === "ordered_list");
}

/**
 * Tab on an item that has a nested sublist: indent the ITEM ALONE — its
 * children keep their absolute depth, becoming its siblings (the text-editor
 * line-indent model; stock sinkListItem drags the whole subtree deeper).
 *
 *   1. first          Tab on "second" →   1. first
 *   2. second                                1. second
 *      1. sub1                               2. sub1
 *      2. sub2                               3. sub2
 *
 * The item's leading content joins its former sublist as its first item, and
 * that list attaches to the previous sibling (merging into the previous
 * sibling's own trailing list when it has one). On mixed list types THE
 * SURVIVING LIST KEEPS ITS TYPE — merging adopts the previous sibling's
 * trailing list's type; otherwise the item's own sublist type persists
 * (children keep their numbering) — one rule, two cases. Shift-Tab (preset
 * liftListItem) is already the exact inverse: lifting an item makes its
 * following siblings its children. Returns false for items without a
 * sublist — plain sinkListItem handles those. Exported for unit testing.
 */
export function sinkItemKeepingChildren(listItemType: NodeType) {
    return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
        const { $from, $to } = state.selection;
        let depth = -1;
        for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type === listItemType) {
                depth = d;
                break;
            }
        }
        if (depth < 0) {
            return false;
        }
        const item = $from.node(depth);
        const itemPos = $from.before(depth);
        if ($to.pos > itemPos + item.nodeSize) {
            return false; // selection crosses items — default sink semantics
        }
        const sublist = item.lastChild;
        if (!isListNode(sublist)) {
            return false;
        }
        const itemIndex = $from.index(depth - 1);
        if (itemIndex === 0) {
            return true; // nothing to sink under — consume, no-op
        }
        const prev = $from.node(depth - 1).child(itemIndex - 1);
        const prevPos = itemPos - prev.nodeSize;

        // The item minus its trailing sublist…
        const bare = item.copy(item.content.cut(0, item.content.size - sublist.nodeSize));
        // …prepended to that sublist's items…
        const joined = Fragment.from(bare).append(sublist.content);
        // …attached to the previous sibling: merged into its own trailing
        // list when it has one, else as the sublist (keeping its type).
        const prevLast = prev.lastChild;
        let newPrev: ProseNode;
        let itemsBefore: Fragment;
        if (isListNode(prevLast)) {
            itemsBefore = prevLast.content;
            const merged = prevLast.copy(prevLast.content.append(joined));
            newPrev = prev.copy(
                prev.content.cut(0, prev.content.size - prevLast.nodeSize).append(Fragment.from(merged)),
            );
        } else {
            itemsBefore = Fragment.empty;
            newPrev = prev.copy(prev.content.append(Fragment.from(sublist.copy(joined))));
        }

        if (dispatch) {
            const tr = state.tr.replaceWith(prevPos, itemPos + item.nodeSize, newPrev);
            // Selection back where it was, inside the (moved) bare item: the
            // new list is newPrev's last child; `bare` sits after
            // itemsBefore. Item content maps 1:1 into `bare`, so both ends
            // of a range selection survive the sink.
            const listPos = prevPos + 1 + newPrev.content.size - newPrev.lastChild!.nodeSize;
            const barePos = listPos + 1 + itemsBefore.size;
            const mapOffset = (pos: number): number =>
                Math.min(barePos + 1 + Math.max(0, pos - (itemPos + 1)), barePos + bare.nodeSize - 1);
            // A range whose head reached into the (relocated) sublist can't
            // be restored faithfully — collapse to the mapped start instead
            // of faking a span over content that moved elsewhere.
            const headStaysInBare = $to.pos - (itemPos + 1) <= bare.content.size;
            tr.setSelection(TextSelection.between(
                tr.doc.resolve(mapOffset($from.pos)),
                tr.doc.resolve(mapOffset(headStaysInBare ? $to.pos : $from.pos)),
            ));
            dispatch(tr.scrollIntoView());
        }
        return true;
    };
}

/** Whether the cursor is inside a code block */
function isInCodeBlock(view: any): boolean {
    const { state } = view;
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === "code_block") {
            return true;
        }
    }
    return false;
}

/** List type at the cursor (bullet_list or ordered_list), or null when not in a list */
function getListType(view: any): string | null {
    const { state } = view;
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
        const nodeType = $from.node(depth).type.name;
        if (nodeType === "bullet_list" || nodeType === "ordered_list") {
            return nodeType;
        }
    }
    return null;
}

/**
 * Tab key handling. The key-leak guard in webview/keyboardShortcuts.ts stops
 * Tab from propagating to the VS Code webview key forwarder — but only when
 * the event target is inside the ProseMirror content, so overlay inputs keep
 * native focus traversal.
 *
 * Table cells are handled by `tableKeymapPlugin` (registered with higher
 * precedence), so Tab never reaches the "insert spaces" branch there.
 */
export const tabKeymapPlugin = $prose((ctx) =>
    keymap({
        Tab: (state, dispatch) => {
            const view = getView(ctx);
            if (!dispatch) { return false; }

            // Inside a code block: insert 4 spaces
            if (isInCodeBlock(view)) {
                const { selection } = state;
                if (selection.empty) {
                    const tr = state.tr.insertText("    ");
                    dispatch(tr);
                } else {
                    const tr = state.tr.insertText("    ", selection.from);
                    dispatch(tr);
                }
                return true;
            }

            // Inside a list: indent one level. An item with a nested sublist
            // sinks ALONE (children keep their depth); plain items use stock
            // sinkListItem.
            if (getListType(view)) {
                const schema = ctx.get(schemaCtx);
                const listItemType = schema.nodes["list_item"];
                if (listItemType) {
                    if (!sinkItemKeepingChildren(listItemType)(state, dispatch)) {
                        sinkListItem(listItemType)(state, dispatch);
                    }
                    // Even when it cannot sink further, block the default
                    return true;
                }
            }

            // Plain text: insert 2 spaces
            const { selection } = state;
            if (selection.empty) {
                const tr = state.tr.insertText("  ");
                dispatch(tr);
            } else {
                const tr = state.tr.insertText("  ", selection.from);
                dispatch(tr);
            }
            return true;
        },
    }),
);
