import { editorViewCtx, schemaCtx } from "@milkdown/core";
import { keymap } from "@milkdown/prose/keymap";
import { TextSelection } from "@milkdown/prose/state";
import { sinkListItem } from "@milkdown/prose/schema-list";
import { $prose } from "@milkdown/utils";

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
 */
export const tabKeymapPlugin = $prose((ctx) =>
    keymap({
        Tab: (state, dispatch) => {
            const view = ctx.get(editorViewCtx);
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

            // Inside a list: sinkListItem to indent one level
            if (getListType(view)) {
                const schema = ctx.get(schemaCtx);
                const listItemType = schema.nodes["list_item"];
                if (listItemType) {
                    const doSink = sinkListItem(listItemType);
                    const result = doSink(state, dispatch);
                    // Even when it cannot sink further (already deeply nested), block the default
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
