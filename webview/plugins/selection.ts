import type { EditorView } from "@milkdown/prose/view";
import { Plugin } from "@milkdown/prose/state";
import { CellSelection } from "@milkdown/prose/tables";
import { $prose } from "@milkdown/utils";
import { isLogTableSelEnabled } from "./tableDebug";

// 选区变更回调（由 index.ts 注入，用于驱动浮动工具栏）
let onSelectionChange: ((view: EditorView) => void) | null = null;

export function registerSelectionChangeHandler(
    cb: (view: EditorView) => void,
): void {
    onSelectionChange = cb;
}

export const selectionPlugin = $prose(
    () =>
        new Plugin({
            view: () => ({
                update(view, prevState) {
                    if (
                        onSelectionChange &&
                        (!view.state.selection.eq(prevState.selection) ||
                         !view.state.doc.eq(prevState.doc))
                    ) {
                        onSelectionChange(view);
                    }
                    if (
                        isLogTableSelEnabled() &&
                        prevState.selection instanceof CellSelection &&
                        !(view.state.selection instanceof CellSelection)
                    ) {
                        console.trace("[TableSel] table selection cleared");
                    }
                },
            }),
        }),
);
