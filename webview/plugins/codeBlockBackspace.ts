import { keymap } from "../pm";
import { NodeSelection } from "../pm";
import { $prose } from "@milkdown/utils";

// Code block Backspace: when the cursor is at the start of the paragraph following a code block, select the code block instead of entering it
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
