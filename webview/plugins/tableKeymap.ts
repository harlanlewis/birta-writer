import { keymap } from "../pm";
import type { EditorState, Transaction } from "../pm";
import { TextSelection } from "../pm";
import {
    addRow,
    goToNextCell,
    isInTable,
    selectedRect,
    TableMap,
} from "../pm";
import type { Node as PMNode } from "../pm";
import { $prose } from "@milkdown/utils";

/**
 * Spreadsheet-style keyboard navigation for tables. Registered with high
 * precedence (before the commonmark/base keymap) so Tab/Enter win over the
 * defaults in table cells. Every handler returns `false` outside a table so
 * normal editing is untouched.
 *
 *   Tab / Shift-Tab → next / previous cell (append a row past the last cell)
 *   Enter           → cell directly below (append a row on the last row)
 *
 * Delete/Backspace are intentionally NOT bound: pressing Delete clears cell
 * contents (the standard spreadsheet/Docs behavior). Removing a row or column
 * is done through the right-click menu. Mod-Enter exits the table (gfm preset).
 */

type Dispatch = ((tr: Transaction) => void) | undefined;

/** Places the text cursor inside the cell at (row, col) of the given table. */
function putCursorInCell(
    tr: Transaction,
    tableStart: number,
    map: TableMap,
    table: PMNode,
    row: number,
    col: number,
): Transaction {
    const cellPos = tableStart + map.positionAt(row, col, table);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
}

/** Appends a blank row to the table and moves the cursor into `col` of it. */
function appendRowAndFocus(state: EditorState, dispatch: Dispatch, col: number): boolean {
    if (!dispatch) { return true; }
    const rect = selectedRect(state);
    const tr = state.tr;
    addRow(tr, rect, rect.map.height);
    const table = tr.doc.nodeAt(rect.tableStart - 1);
    if (!table || table.type.name !== "table") { return true; }
    const newMap = TableMap.get(table);
    dispatch(putCursorInCell(tr, rect.tableStart, newMap, table, rect.map.height, col).scrollIntoView());
    return true;
}

function moveToCellBelow(state: EditorState, dispatch: Dispatch): boolean {
    if (!isInTable(state)) { return false; }
    const rect = selectedRect(state);
    const { map, table, tableStart, top, left } = rect;
    if (top + 1 < map.height) {
        if (dispatch) {
            dispatch(putCursorInCell(state.tr, tableStart, map, table, top + 1, left).scrollIntoView());
        }
        return true;
    }
    return appendRowAndFocus(state, dispatch, left);
}

export const tableKeymapPlugin = $prose(() =>
    keymap({
        Tab: (state, dispatch) => {
            if (!isInTable(state)) { return false; }
            if (goToNextCell(1)(state, dispatch)) { return true; }
            return appendRowAndFocus(state, dispatch, 0);
        },
        "Shift-Tab": (state, dispatch) => {
            if (!isInTable(state)) { return false; }
            return goToNextCell(-1)(state, dispatch);
        },
        Enter: (state, dispatch) => {
            if (isInTable(state) && state.selection.empty) {
                return moveToCellBelow(state, dispatch);
            }
            return false;
        },
    }),
);
