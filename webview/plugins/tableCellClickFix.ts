import type { EditorView } from "@milkdown/prose/view";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import { CellSelection, TableMap } from "@milkdown/prose/tables";
import { $prose } from "@milkdown/utils";
import { isLogTableSelEnabled } from "./tableDebug";

// Diagnostic-log helper: resolve a document position to a 1-indexed row/col.
function getCellCoords(
    doc: any,
    pos: number,
): { row: number; col: number } | null {
    try {
        const $pos = doc.resolve(pos);
        for (let d = $pos.depth; d >= 0; d--) {
            const typeName = $pos.node(d).type.name;
            if (typeName === "table_cell" || typeName === "table_header") {
                for (let td = d - 1; td >= 0; td--) {
                    if ($pos.node(td).type.name === "table") {
                        const tableNode = $pos.node(td);
                        const tableStart = $pos.start(td);
                        const cellRelPos = $pos.before(d) - tableStart;
                        const map = TableMap.get(tableNode);
                        const rect = map.findCell(cellRelPos);
                        return { row: rect.top + 1, col: rect.left + 1 };
                    }
                }
            }
        }
    } catch {}
    return null;
}

/**
 * Decides whether a transaction should be vetoed during the brief window after
 * a cross-cell drag, where an incidental caret move would clobber the freshly
 * made CellSelection.
 *
 * A document-changing transaction is NEVER vetoed: silently dropping one would
 * diverge the editor from the file (e.g. an inbound external-sync diff, or VS
 * Code undo/redo, landing inside the post-drag window). Only a pure selection
 * replacement — CellSelection being overwritten by a non-cell selection while
 * the veto is armed — is blocked.
 */
export function shouldVetoTransaction(
    hasPendingCellVeto: boolean,
    stateSelIsCell: boolean,
    trSelIsCell: boolean,
    trDocChanged: boolean,
): boolean {
    if (!hasPendingCellVeto || trDocChanged) {
        return false;
    }
    return stateSelIsCell && !trSelIsCell;
}

// Single click on a table cell: convert a single-cell CellSelection into a
// TextSelection with the caret at the click position. appendTransaction is used
// so the correction lands synchronously before the first render (no green
// flash). In-cell text drag: build a TextSelection from the click position to
// the current mouse position, restoring a normal text selection.
export const cellClickFixPlugin = $prose(() => {
    let pendingClickPos: number | null = null;
    let clickIsPlain = true;
    let wasCrossCell = false;
    let lastGoodCellSelection: CellSelection | null = null;
    let multiSelectCount = 0;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let capturedView: EditorView | null = null;

    return new Plugin({
        view(editorView) {
            capturedView = editorView;
            return {
                destroy() {
                    capturedView = null;
                },
            };
        },
        props: {
            handleDOMEvents: {
                mousedown: (view, event) => {
                    if (
                        event.button !== 0 ||
                        event.detail !== 1 ||
                        event.shiftKey ||
                        event.ctrlKey ||
                        event.metaKey
                    ) {
                        pendingClickPos = null;
                        return false;
                    }
                    const cell = (event.target as Element).closest("td, th");
                    if (!cell) {
                        pendingClickPos = null;
                        return false;
                    }
                    const pos = view.posAtCoords({
                        left: event.clientX,
                        top: event.clientY,
                    });
                    pendingClickPos = pos ? pos.pos : null;
                    clickIsPlain = true;
                    wasCrossCell = false;
                    lastGoodCellSelection = null;
                    lastMouseX = event.clientX;
                    lastMouseY = event.clientY;

                    const onMove = (mv: MouseEvent) => {
                        lastMouseX = mv.clientX;
                        lastMouseY = mv.clientY;
                        const dx = mv.clientX - event.clientX;
                        const dy = mv.clientY - event.clientY;
                        if (Math.sqrt(dx * dx + dy * dy) > 4) {
                            clickIsPlain = false;
                        }
                    };
                    document.addEventListener("mousemove", onMove, true);

                    const cleanup = () => {
                        document.removeEventListener("mouseup", cleanup, true);
                        document.removeEventListener("mousemove", onMove, true);
                        if (wasCrossCell) {
                            pendingClickPos = null;
                            clickIsPlain = true;
                            wasCrossCell = false;
                            if (isLogTableSelEnabled() && lastGoodCellSelection) {
                                const headCoords = capturedView
                                    ? getCellCoords(
                                          capturedView.state.doc,
                                          lastGoodCellSelection.$headCell.pos + 1,
                                      )
                                    : null;
                                let cellCount = 0;
                                lastGoodCellSelection.forEachCell(() => {
                                    cellCount++;
                                });
                                console.log(
                                    `[TableSel] drag ended at ${headCoords ? `row ${headCoords.row}, col ${headCoords.col}` : "row ?, col ?"} — ${cellCount} cells selected`,
                                );
                            }
                            const savedCellSel = lastGoodCellSelection;
                            setTimeout(() => {
                                if (lastGoodCellSelection === savedCellSel) {
                                    lastGoodCellSelection = null;
                                }
                            }, 200);
                        } else {
                            Promise.resolve().then(() => {
                                pendingClickPos = null;
                                clickIsPlain = true;
                            });
                        }
                    };
                    document.addEventListener("mouseup", cleanup, true);
                    return false;
                },
            },
        },
        filterTransaction(tr, state) {
            const veto = shouldVetoTransaction(
                !!lastGoodCellSelection,
                state.selection instanceof CellSelection,
                tr.selection instanceof CellSelection,
                tr.docChanged,
            );
            if (veto && isLogTableSelEnabled()) {
                console.log(
                    "[TableSel] filterTransaction: blocked overwrite of CellSelection",
                );
            }
            return !veto;
        },
        appendTransaction(_trs, _oldState, newState) {
            if (pendingClickPos === null) return null;
            const sel = newState.selection;
            if (
                !(sel instanceof CellSelection) ||
                sel.isRowSelection() ||
                sel.isColSelection()
            ) {
                return null;
            }
            if (sel.$anchorCell.pos !== sel.$headCell.pos) {
                if (!wasCrossCell && isLogTableSelEnabled()) {
                    multiSelectCount++;
                    const startCoords =
                        pendingClickPos !== null
                            ? getCellCoords(newState.doc, pendingClickPos)
                            : null;
                    console.log(`[TableSel] table multi-select #${multiSelectCount}`);
                    console.log(
                        `[TableSel] drag started at ${startCoords ? `row ${startCoords.row}, col ${startCoords.col}` : "row ?, col ?"}`,
                    );
                }
                wasCrossCell = true;
                lastGoodCellSelection = sel;
                return null;
            }
            try {
                if (!clickIsPlain && capturedView) {
                    const toCoords = capturedView.posAtCoords({
                        left: lastMouseX,
                        top: lastMouseY,
                    });
                    if (toCoords) {
                        const anchorP = Math.min(
                            pendingClickPos,
                            newState.doc.content.size,
                        );
                        const headP = Math.min(
                            toCoords.pos,
                            newState.doc.content.size,
                        );
                        try {
                            const $a = newState.doc.resolve(anchorP);
                            const $h = newState.doc.resolve(headP);
                            let aCellStart = -1;
                            let hCellStart = -1;
                            for (let d = $a.depth; d >= 0; d--) {
                                const n = $a.node(d).type.name;
                                if (
                                    n === "table_cell" ||
                                    n === "table_header"
                                ) {
                                    aCellStart = $a.start(d);
                                    break;
                                }
                            }
                            for (let d = $h.depth; d >= 0; d--) {
                                const n = $h.node(d).type.name;
                                if (
                                    n === "table_cell" ||
                                    n === "table_header"
                                ) {
                                    hCellStart = $h.start(d);
                                    break;
                                }
                            }
                            if (aCellStart !== hCellStart) {
                                return null;
                            }
                        } catch {
                            /* ignore, continue with the conversion */
                        }
                        return newState.tr.setSelection(
                            TextSelection.create(newState.doc, anchorP, headP),
                        );
                    }
                }
                const $pos = newState.doc.resolve(
                    Math.min(pendingClickPos, newState.doc.content.size),
                );
                return newState.tr.setSelection(TextSelection.near($pos));
            } catch {
                return null;
            }
        },
    });
});
