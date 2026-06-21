import { editorViewCtx, schemaCtx } from "@milkdown/core";
import { keymap } from "@milkdown/prose/keymap";
import { TextSelection } from "@milkdown/prose/state";
import { sinkListItem } from "@milkdown/prose/schema-list";
import { $prose } from "@milkdown/utils";

/** 判断光标是否在代码块内 */
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

/** 获取光标所在的列表类型（bullet_list 或 ordered_list），不在列表中返回 null */
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

/** Tab 键快捷键 */
export const tabKeymapPlugin = $prose((ctx) =>
    keymap({
        Tab: (state, dispatch) => {
            const view = ctx.get(editorViewCtx);
            if (!dispatch) { return false; }

            // 代码块内：插入 4 空格
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

            // 列表内：调用 sinkListItem 变成二级列表
            if (getListType(view)) {
                const schema = ctx.get(schemaCtx);
                const listItemType = schema.nodes["list_item"];
                if (listItemType) {
                    const doSink = sinkListItem(listItemType);
                    return doSink(state, dispatch);
                }
            }

            // 普通文本：插入 2 空格
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
