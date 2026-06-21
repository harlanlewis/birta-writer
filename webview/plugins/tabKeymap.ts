import { editorViewCtx } from "@milkdown/core";
import { keymap } from "@milkdown/prose/keymap";
import { TextSelection } from "@milkdown/prose/state";
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

/** Tab 键快捷键：代码块内插入 4 空格，普通文本插入 2 空格 */
export const tabKeymapPlugin = $prose((ctx) =>
    keymap({
        Tab: (state, dispatch) => {
            const view = ctx.get(editorViewCtx);
            if (!dispatch) { return false; }

            const { selection } = state;
            const tabSize = isInCodeBlock(view) ? "    " : "  ";

            if (selection.empty) {
                // 无选区：插入空格
                const tr = state.tr.insertText(tabSize);
                dispatch(tr);
            } else {
                // 有选区：选中文本首行之前插入空格（简单缩进）
                const tr = state.tr.insertText(tabSize, selection.from);
                dispatch(tr);
            }
            return true;
        },
    }),
);
