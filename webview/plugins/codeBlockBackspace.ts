import { keymap } from "@milkdown/prose/keymap";
import { NodeSelection } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

// 代码块 Backspace：光标在代码块后的段落行首时，选中代码块而非进入其内部
export const codeBlockBackspacePlugin = $prose(() =>
    keymap({
        Backspace: (state, dispatch) => {
            const { selection } = state;
            if (!selection.empty || selection.$from.parentOffset !== 0) {
                return false;
            }
            const $from = selection.$from;
            const startOfBlock = $from.before($from.depth);
            if (startOfBlock === 0) {
                return false;
            }
            const nodeBefore = state.doc.resolve(startOfBlock).nodeBefore;
            if (!nodeBefore || nodeBefore.type.name !== "code_block") {
                return false;
            }
            if (dispatch) {
                dispatch(
                    state.tr.setSelection(
                        NodeSelection.create(
                            state.doc,
                            startOfBlock - nodeBefore.nodeSize,
                        ),
                    ),
                );
            }
            return true;
        },
    }),
);
