import type { EditorView } from "../pm";
import { Plugin } from "../pm";
import { CellSelection } from "../pm";
import { $prose } from "@milkdown/utils";
import { isLogTableSelEnabled } from "./tableDebug";

// Selection-change callback (injected by index.ts; drives the floating toolbars)
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
