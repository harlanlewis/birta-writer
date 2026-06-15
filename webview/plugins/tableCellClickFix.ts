import type { EditorView } from "@milkdown/prose/view";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import { CellSelection, TableMap } from "@milkdown/prose/tables";
import { $prose } from "@milkdown/utils";
import { isLogTableSelEnabled } from "./tableDebug";

// 诊断日志辅助：从文档位置获取 1-indexed 行列号
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

// 单击表格单元格：将单格 CellSelection 转为 TextSelection，光标定位到点击位置
// 用 appendTransaction 确保修正在首次渲染前同步完成（无绿色闪烁）
// 格内文字拖拽：从点击位到当前鼠标位构造 TextSelection，恢复正常选区
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
                                    `[TableSel] 拖拽结束 ${headCoords ? `${headCoords.row}行${headCoords.col}列` : "?行?列"} 共选中${cellCount}个表格内容`,
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
            if (!lastGoodCellSelection) {
                return true;
            }
            if (
                state.selection instanceof CellSelection &&
                !(tr.selection instanceof CellSelection)
            ) {
                if (isLogTableSelEnabled()) {
                    console.log(
                        "[TableSel] filterTransaction: 已阻止覆盖CellSelection",
                    );
                }
                return false;
            }
            return true;
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
                    console.log(`[TableSel] 第${multiSelectCount}次多选表格`);
                    console.log(
                        `[TableSel] 开始拖拽 ${startCoords ? `${startCoords.row}行${startCoords.col}列` : "?行?列"}`,
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
                            /* ignore, 继续转换 */
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
