import { commandsCtx } from "@milkdown/core";
import {
    toggleStrongCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    turnIntoTextCommand,
    wrapInHeadingCommand,
} from "@milkdown/preset-commonmark";
import type { Node as PMNode, ResolvedPos } from "@milkdown/prose/model";
import { toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import {
    CellSelection,
    deleteRow,
    deleteColumn,
    setCellAttr,
    TableMap,
} from "@milkdown/prose/tables";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { TextSelection } from "@milkdown/prose/state";
import {
    IconBold,
    IconItalic,
    IconStrikethrough,
    IconCode,
    IconLink,
    IconChevronDown,
    IconAlignLeft,
    IconAlignCenter,
    IconAlignRight,
    IconTrash2,
} from "@/ui/icons";
import { applyTooltip } from "@/ui/tooltip";
import { t, kbd } from "@/i18n";
import { createButton, createSeparator } from "@/ui/dom";
import './selectionToolbar.css';

type GetEditor = () => Editor | null;

// One-time position override: set by tableHandles with the mouse coordinates when a row/column is selected via the drag handle
let pendingPos: { x: number; y: number } | null = null;
export function setPendingToolbarPos(x: number, y: number): void {
    pendingPos = { x, y };
}

function isInTableCell($pos: {
    depth: number;
    node(d: number): { type: { name: string } };
}): boolean {
    for (let d = $pos.depth; d >= 0; d--) {
        const name = $pos.node(d).type.name;
        if (name === "table_cell" || name === "table_header") return true;
    }
    return false;
}

// Inline-code toggle:
// - TextSelection → use the Milkdown command directly (reliable)
// - CellSelection  → process cell by cell with forEachCell, fixing the issue where a cross-cell selection only applied to the last cell
function applyInlineCodeToSelection(
    view: EditorView,
    getEditor: GetEditor,
): void {
    const { state } = view;
    const sel = state.selection;

    if (!(sel instanceof CellSelection)) {
        callCmd(getEditor, toggleInlineCodeCommand);
        return;
    }

    // CellSelection: locate the code mark reliably via spec.code===true, without relying on a name string
    const codeMarkType =
        Object.values(state.schema.marks).find(
            (mt) => (mt.spec as { code?: boolean }).code === true,
        ) ??
        state.schema.marks["code"] ??
        state.schema.marks["code_inline"];
    if (!codeMarkType) {
        console.warn(
            "[selectionToolbar] code mark type not found in schema, marks:",
            Object.keys(state.schema.marks),
        );
        callCmd(getEditor, toggleInlineCodeCommand);
        return;
    }

    let hasCode = false;
    sel.forEachCell((node: PMNode) => {
        node.descendants((n: PMNode) => {
            if (n.isText && codeMarkType.isInSet(n.marks)) {
                hasCode = true;
            }
        });
    });

    const tr = state.tr;
    sel.forEachCell((node: PMNode, pos: number) => {
        const from = pos + 1;
        const to = pos + node.nodeSize - 1;
        if (hasCode) {
            tr.removeMark(from, to, codeMarkType);
        } else {
            tr.addMark(from, to, codeMarkType.create());
        }
    });
    view.dispatch(tr);
}

function callCmd<T>(
    getEditor: GetEditor,
    command: { key: unknown },
    payload?: T,
): void {
    const editor = getEditor();
    if (!editor) {
        return;
    }
    editor.action((ctx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.get(commandsCtx).call(command.key as any, payload as any);
    });
}

function sBtn(
    icon: string,
    title: string,
    onClick: () => void,
): HTMLButtonElement {
    return createButton({ className: "sel-tb-btn", icon, title, tooltipPlacement: "above", onClick });
}

function sSep(): HTMLElement {
    return createSeparator("sel-tb-sep");
}

// Determine whether a CellSelection selects the table's first row (the header)
function isFirstRow(sel: CellSelection): boolean {
    const $anchor = sel.$anchorCell;
    for (let d = $anchor.depth; d >= 0; d--) {
        if ($anchor.node(d).type.name === "table") {
            return $anchor.index(d) === 0;
        }
    }
    return false;
}

// Determine whether a CellSelection selects all rows of the table (whole-table selection)
function isAllRowsSelected(sel: CellSelection): boolean {
    if (!sel.isRowSelection()) {
        return false;
    }
    const $anchor = sel.$anchorCell;
    const $head = sel.$headCell;
    for (let d = $anchor.depth; d >= 0; d--) {
        if ($anchor.node(d).type.name === "table") {
            const map = TableMap.get($anchor.node(d));
            const selRows = Math.abs($anchor.index(d) - $head.index(d)) + 1;
            return selRows >= map.height;
        }
    }
    return false;
}

// Determine whether a CellSelection selects all columns of the table
function isAllColsSelected(sel: CellSelection): boolean {
    if (!sel.isColSelection()) {
        return false;
    }
    const $anchor = sel.$anchorCell;
    const $head = sel.$headCell;
    for (let d = $anchor.depth; d >= 0; d--) {
        if ($anchor.node(d).type.name === "table") {
            const tableNode = $anchor.node(d);
            const map = TableMap.get(tableNode);
            const tableStart = $anchor.start(d);
            try {
                const anchorRect = map.findCell($anchor.pos - tableStart);
                const headRect = map.findCell($head.pos - tableStart);
                const minCol = Math.min(anchorRect.left, headRect.left);
                const maxCol = Math.max(anchorRect.right, headRect.right);
                return minCol === 0 && maxCol >= map.width;
            } catch {
                return false;
            }
        }
    }
    return false;
}

// Determine whether the entire table is selected
function isEntireTableSelected(sel: CellSelection): boolean {
    return isAllRowsSelected(sel) || isAllColsSelected(sel);
}

/** Strip common markdown markers, for fuzzy comparison against the original content */
function normalizeForSearch(s: string): string {
    return s
        .replace(/^#{1,6}\s+/m, "")
        .replace(/\*+/g, "")
        .replace(/~+/g, "")
        .replace(/`/g, "")
        .replace(/^\s*[-*+]\s+/m, "")
        .replace(/^\s*\d+\.\s+/m, "")
        .replace(/^\s*>\s*/gm, "")
        .replace(/\|/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Get the full text content of the deepest block-level container node at the caret */
export function getBlockContainerText($pos: ResolvedPos): string {
    for (let d = $pos.depth; d >= 1; d--) {
        const node = $pos.node(d);
        if (node.isBlock && node.type.name !== "doc") {
            const text = node.textContent.trim();
            if (text.length >= 3) return text;
        }
    }
    return "";
}

/** Search the original markdown for the line number (1-indexed) containing the block text; return -1 when not found */
export function findLineInOriginalSource(
    source: string,
    blockText: string,
): number {
    if (!blockText || blockText.length < 3) return -1;
    const normalizedBlock = normalizeForSearch(blockText).slice(0, 60);
    if (normalizedBlock.length < 3) return -1;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (normalizeForSearch(lines[i]).includes(normalizedBlock))
            return i + 1;
    }
    return -1;
}

/** Debug helper: run line-number computation for any doc position and return diagnostic data */
export function sampleDocPosition(
    view: EditorView,
    docPos: number,
    getLineMapFn: () => number[],
    getMarkdownSourceFn: () => string,
): {
    pos: number;
    nodeType: string;
    nodeIdx: number;
    lineMapVal: number | undefined;
    srcAtMap: string;
    line: number;
    via: string;
    pmSnip: string;
    srcAtCalc: string;
    ok: boolean;
} {
    const doc = view.state.doc;
    const pos = Math.max(1, Math.min(docPos, doc.content.size - 1));
    const $from = doc.resolve(pos);
    const depth1Node = $from.depth >= 1 ? $from.node(1) : $from.node(0);
    const nodeType = depth1Node.type.name;
    const nodeIdx = $from.index(0);
    const lineMap = getLineMapFn();
    const lineMapVal = lineMap[nodeIdx];
    const source = getMarkdownSourceFn();
    const srcLines = source.split("\n");
    const srcAtMap =
        lineMapVal !== undefined ? (srcLines[lineMapVal - 1] ?? "") : "";
    const blockText = getBlockContainerText($from);
    let line: number;
    let via: string;
    const found = findLineInOriginalSource(source, blockText);
    if (found !== -1) {
        line = found;
        via = "textSearch";
    } else if (lineMapVal) {
        line = lineMapVal;
        via = "lineMapFallback";
    } else {
        const textBefore = doc.textBetween(0, pos, "\n");
        line = (textBefore.match(/\n/g) ?? []).length + 1;
        via = "countFallback";
    }
    const srcAtCalc = srcLines[line - 1] ?? "";
    const pmSnip = depth1Node.textContent.slice(0, 50);
    const ok = normalizeForSearch(srcAtCalc).includes(
        normalizeForSearch(pmSnip).slice(0, 20),
    );
    return {
        pos,
        nodeType,
        nodeIdx,
        lineMapVal,
        srcAtMap,
        line,
        via,
        pmSnip,
        srcAtCalc,
        ok,
    };
}

export function setupSelectionToolbar(
    getView: () => EditorView | null,
    getEditor: () => Editor | null,
    openLinkPrompt: () => void,
): { onSelectionChange(view: EditorView): void } {
    let lastView: EditorView | null = null;
    let isDragging = false;

    document.addEventListener(
        "mousedown",
        (e) => {
            const target = e.target as Element;
            if (target.closest?.(".milkdown")) {
                isDragging = true;
            }
        },
        true,
    );

    document.addEventListener(
        "mouseup",
        () => {
            if (!isDragging) {
                return;
            }
            isDragging = false;
            if (lastView) {
                showAndPosition(lastView);
            }
        },
        true,
    );

    const toolbar = document.createElement("div");
    toolbar.className = "sel-toolbar";
    toolbar.style.display = "none";
    document.body.appendChild(toolbar);

    // ── Format dropdown (text mode / non-table only) ──────────
    const fmtWrap = document.createElement("div");
    fmtWrap.className = "sel-tb-fmt-wrap";

    const fmtBtn = document.createElement("button");
    fmtBtn.className = "sel-tb-btn sel-tb-fmt-btn";
    fmtBtn.innerHTML = `<span class="sel-tb-fmt-label">P</span>${IconChevronDown}`;
    fmtBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    const fmtMenu = document.createElement("div");
    fmtMenu.className = "sel-tb-fmt-menu";
    fmtMenu.style.display = "none";

    const formats: [string, string, () => void][] = [
        [t("Paragraph"), "P", () => callCmd(getEditor, turnIntoTextCommand)],
        [
            t("Heading 1"),
            "H1",
            () => callCmd(getEditor, wrapInHeadingCommand, 1),
        ],
        [
            t("Heading 2"),
            "H2",
            () => callCmd(getEditor, wrapInHeadingCommand, 2),
        ],
        [
            t("Heading 3"),
            "H3",
            () => callCmd(getEditor, wrapInHeadingCommand, 3),
        ],
        [
            t("Heading 4"),
            "H4",
            () => callCmd(getEditor, wrapInHeadingCommand, 4),
        ],
        [
            t("Heading 5"),
            "H5",
            () => callCmd(getEditor, wrapInHeadingCommand, 5),
        ],
        [
            t("Heading 6"),
            "H6",
            () => callCmd(getEditor, wrapInHeadingCommand, 6),
        ],
    ];

    const fmtItems: HTMLElement[] = [];

    formats.forEach(([, shortLabel, action]) => {
        const item = document.createElement("div");
        item.className = "sel-tb-fmt-item";
        item.textContent = shortLabel;
        item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            action();
            fmtMenu.style.display = "none";
            // Refresh the active state after the format command runs (the transaction is applied next frame)
            requestAnimationFrame(() => {
                const v = getView();
                if (v && toolbar.style.display !== "none") {
                    showAndPosition(v);
                }
            });
        });
        fmtMenu.appendChild(item);
        fmtItems.push(item);
    });

    let fmtHideTimer: ReturnType<typeof setTimeout> | null = null;

    fmtWrap.addEventListener("mouseenter", () => {
        if (fmtHideTimer) {
            clearTimeout(fmtHideTimer);
            fmtHideTimer = null;
        }
        // Space check: default above, switch below when there isn't enough room
        const rect = fmtBtn.getBoundingClientRect();
        const approxH = formats.length * 30;
        if (rect.top < approxH + 16) {
            fmtMenu.style.bottom = "auto";
            fmtMenu.style.top = "calc(100% + 6px)";
        } else {
            fmtMenu.style.top = "auto";
            fmtMenu.style.bottom = "calc(100% + 6px)";
        }
        fmtMenu.style.display = "flex";
    });
    fmtWrap.addEventListener("mouseleave", () => {
        fmtHideTimer = setTimeout(() => {
            fmtMenu.style.display = "none";
        }, 100);
    });
    fmtMenu.addEventListener("mouseenter", () => {
        if (fmtHideTimer) {
            clearTimeout(fmtHideTimer);
            fmtHideTimer = null;
        }
    });

    fmtWrap.appendChild(fmtBtn);
    fmtWrap.appendChild(fmtMenu);
    toolbar.appendChild(fmtWrap);

    const textFmtSep = sSep();
    toolbar.appendChild(textFmtSep);

    // ── Inline format buttons (shown in both text and table modes) ──────
    const boldBtn = sBtn(IconBold, t("Bold") + " " + kbd("Mod-b"), () =>
        callCmd(getEditor, toggleStrongCommand),
    );
    const italicBtn = sBtn(IconItalic, t("Italic") + " " + kbd("Mod-i"), () =>
        callCmd(getEditor, toggleEmphasisCommand),
    );
    const strikeBtn = sBtn(
        IconStrikethrough,
        t("Strikethrough") + " " + kbd("Mod-Shift-x"),
        () => callCmd(getEditor, toggleStrikethroughCommand),
    );
    const codeBtn = sBtn(
        IconCode,
        t("Inline Code") + " " + kbd("Mod-e"),
        () => {
            const v = getView();
            if (v) {
                applyInlineCodeToSelection(v, getEditor);
            }
        },
    );
    toolbar.appendChild(boldBtn);
    toolbar.appendChild(italicBtn);
    toolbar.appendChild(strikeBtn);
    toolbar.appendChild(codeBtn);

    // ── Link button (text mode only) ─────────────────
    // Opens the same Insert/Edit Link prompt as the main toolbar button and
    // Cmd/Ctrl+K. createButton's mousedown handler calls preventDefault so
    // the editor selection survives the click (same as the other buttons).
    const linkSep = sSep();
    toolbar.appendChild(linkSep);
    // No shortcut label: insert-link is a user-rebindable contributed
    // keybinding and the webview cannot query its effective binding.
    const linkBtn = createButton({
        className: "sel-tb-btn sel-tb-link-btn",
        icon: IconLink,
        title: t("Insert/Edit Link"),
        tooltipPlacement: "above",
        onClick: openLinkPrompt,
    });
    toolbar.appendChild(linkBtn);

    // ── Table-mode elements (alignment + delete, all hidden initially) ──
    const tableSep = sSep();
    tableSep.style.display = "none";
    toolbar.appendChild(tableSep);

    // Alignment dropdown (single icon, expands on hover)
    const alignWrap = document.createElement("div");
    alignWrap.className = "sel-tb-fmt-wrap";
    alignWrap.style.display = "none";

    const alignBtn = document.createElement("button");
    alignBtn.className = "sel-tb-btn sel-tb-fmt-btn";
    alignBtn.innerHTML = IconAlignLeft + IconChevronDown;
    alignBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    const alignMenu = document.createElement("div");
    alignMenu.className = "sel-tb-fmt-menu";
    alignMenu.style.display = "none";

    const alignDefs: [string, string, string][] = [
        [IconAlignLeft, t("Align Left"), "left"],
        [IconAlignCenter, t("Align Center"), "center"],
        [IconAlignRight, t("Align Right"), "right"],
    ];
    alignDefs.forEach(([icon, title, value]) => {
        const item = document.createElement("div");
        item.className = "sel-tb-fmt-item sel-tb-align-item";
        item.innerHTML = icon;
        applyTooltip(item as HTMLElement, title, { placement: "above" });
        item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const view = getView();
            if (!view) {
                return;
            }
            setCellAttr("alignment", value)(view.state, view.dispatch);
            alignMenu.style.display = "none";
        });
        alignMenu.appendChild(item);
    });

    let alignHideTimer: ReturnType<typeof setTimeout> | null = null;
    alignWrap.addEventListener("mouseenter", () => {
        if (alignHideTimer) {
            clearTimeout(alignHideTimer);
            alignHideTimer = null;
        }
        // Space check: default above, switch below when there isn't enough room
        const rect = alignBtn.getBoundingClientRect();
        const approxH = alignDefs.length * 34;
        if (rect.top < approxH + 16) {
            alignMenu.style.bottom = "auto";
            alignMenu.style.top = "calc(100% + 6px)";
        } else {
            alignMenu.style.top = "auto";
            alignMenu.style.bottom = "calc(100% + 6px)";
        }
        alignMenu.style.display = "flex";
    });
    alignWrap.addEventListener("mouseleave", () => {
        alignHideTimer = setTimeout(() => {
            alignMenu.style.display = "none";
        }, 100);
    });
    alignMenu.addEventListener("mouseenter", () => {
        if (alignHideTimer) {
            clearTimeout(alignHideTimer);
            alignHideTimer = null;
        }
    });

    alignWrap.appendChild(alignBtn);
    alignWrap.appendChild(alignMenu);
    toolbar.appendChild(alignWrap);

    const deleteSep = sSep();
    deleteSep.style.display = "none";
    toolbar.appendChild(deleteSep);

    const deleteRowBtn = sBtn(IconTrash2, t("Delete Row"), () => {
        const view = getView();
        if (!view) {
            return;
        }
        const sel = view.state.selection;
        if (!(sel instanceof CellSelection) || isFirstRow(sel)) {
            return;
        }
        deleteRow(view.state, view.dispatch);
        hideToolbar();
        const v2 = getView();
        if (v2) {
            // Collapse the residual selection to a caret next to where the
            // row/column was, so the viewport stays on the edited table
            // instead of jumping to the top of the document.
            const sel2 = v2.state.selection;
            const $near =
                sel2 instanceof CellSelection ? sel2.$headCell : sel2.$head;
            v2.dispatch(
                v2.state.tr.setSelection(TextSelection.near($near)),
            );
        }
    });
    deleteRowBtn.classList.add("sel-tb-del-row-btn");
    deleteRowBtn.style.display = "none";
    toolbar.appendChild(deleteRowBtn);

    // Clear the header cells' content (without deleting the row)
    const clearHeaderBtn = sBtn(IconTrash2, t("Clear Header"), () => {
        const view = getView();
        if (!view) {
            return;
        }
        const sel = view.state.selection;
        if (!(sel instanceof CellSelection) || !isFirstRow(sel)) {
            return;
        }
        const $anchor = sel.$anchorCell;
        for (let d = $anchor.depth; d >= 0; d--) {
            if ($anchor.node(d).type.name === "table") {
                const tableNode = $anchor.node(d);
                const map = TableMap.get(tableNode);
                const tableStart = $anchor.start(d);
                // Collect the content ranges of every cell in row 0 (back to front, to avoid position drift)
                const ranges: Array<{ from: number; to: number }> = [];
                for (let col = 0; col < map.width; col++) {
                    const cellPos =
                        tableStart + map.positionAt(0, col, tableNode);
                    const $cell = view.state.doc.resolve(cellPos);
                    const cellNode = $cell.nodeAfter;
                    if (cellNode) {
                        ranges.push({
                            from: cellPos + 1,
                            to: cellPos + 1 + cellNode.content.size,
                        });
                    }
                }
                let tr = view.state.tr;
                for (let i = ranges.length - 1; i >= 0; i--) {
                    const { from, to } = ranges[i];
                    const emptyPara =
                        view.state.schema.nodes["paragraph"]?.createAndFill();
                    if (emptyPara) {
                        tr = tr.replaceWith(from, to, emptyPara);
                    }
                }
                view.dispatch(tr);
                hideToolbar();
                return;
            }
        }
    });
    clearHeaderBtn.style.display = "none";
    toolbar.appendChild(clearHeaderBtn);

    // Delete the whole table (shown only when the entire table is selected)
    const deleteTableBtn = sBtn(IconTrash2, t("Delete Table"), () => {
        const view = getView();
        if (!view) {
            return;
        }
        const sel = view.state.selection;
        if (!(sel instanceof CellSelection)) {
            return;
        }
        const $anchor = sel.$anchorCell;
        for (let d = $anchor.depth; d >= 0; d--) {
            if ($anchor.node(d).type.name === "table") {
                const tableStart = $anchor.before(d);
                const tableEnd = tableStart + $anchor.node(d).nodeSize;
                view.dispatch(view.state.tr.delete(tableStart, tableEnd));
                hideToolbar();
                return;
            }
        }
    });
    deleteTableBtn.style.display = "none";
    toolbar.appendChild(deleteTableBtn);

    const deleteColBtn = sBtn(IconTrash2, t("Delete Column"), () => {
        const view = getView();
        if (!view) {
            return;
        }
        deleteColumn(view.state, view.dispatch);
        hideToolbar();
        const v2 = getView();
        if (v2) {
            // Collapse the residual selection to a caret next to where the
            // row/column was, so the viewport stays on the edited table
            // instead of jumping to the top of the document.
            const sel2 = v2.state.selection;
            const $near =
                sel2 instanceof CellSelection ? sel2.$headCell : sel2.$head;
            v2.dispatch(
                v2.state.tr.setSelection(TextSelection.near($near)),
            );
        }
    });
    deleteColBtn.classList.add("sel-tb-del-col-btn");
    deleteColBtn.style.display = "none";
    toolbar.appendChild(deleteColBtn);

    // ── Click outside the toolbar to close it (clicks inside the editor don't close, so shift+click extending a selection won't hide the toolbar)
    document.addEventListener("mousedown", (e) => {
        const target = e.target as Element;
        const inEditor = !!target.closest?.(".milkdown");
        if (
            toolbar.style.display !== "none" &&
            !toolbar.contains(target as Node) &&
            !inEditor
        ) {
            hideToolbar();
        }
    });

    function hideToolbar(): void {
        toolbar.style.display = "none";
        fmtMenu.style.display = "none";
        alignMenu.style.display = "none";
    }

    function positionToolbar(view: EditorView, from: number, to: number): void {
        const tbW = toolbar.offsetWidth;
        const tbH = toolbar.offsetHeight;
        let leftX: number, topY: number;
        if (pendingPos) {
            const px = pendingPos.x;
            const py = pendingPos.y;
            pendingPos = null;
            leftX = px - tbW / 2;
            topY = py - tbH - 8;
            if (topY < 8) {
                topY = py + 12;
            }
        } else {
            const startC = view.coordsAtPos(from);
            const endC = view.coordsAtPos(to);
            leftX = (startC.left + endC.right) / 2 - tbW / 2;
            topY = startC.top - tbH - 8;
            if (topY < 8) {
                topY = endC.bottom + 8;
            }
        }
        leftX = Math.max(8, Math.min(leftX, window.innerWidth - tbW - 8));
        toolbar.style.left = `${leftX}px`;
        toolbar.style.top = `${topY}px`;
        toolbar.style.visibility = "visible";
    }

    function showAndPosition(view: EditorView): void {
        lastView = view;
        if (isDragging) {
            hideToolbar();
            return;
        }
        const { selection } = view.state;

        // ── Table CellSelection mode ───────────────────
        if (selection instanceof CellSelection) {
            const isRow = selection.isRowSelection();
            const isCol = selection.isColSelection();

            // The format dropdown is meaningless in table mode, so hide it
            fmtWrap.style.display = "none";
            textFmtSep.style.display = "none";

            // Inline format buttons stay visible for every CellSelection
            boldBtn.style.display = "";
            italicBtn.style.display = "";
            strikeBtn.style.display = "";
            codeBtn.style.display = "";

            // Link: hidden in cell-selection mode — the link prompt replaces
            // a flat text range, which would corrupt the table structure
            // when the selection spans cells.
            linkSep.style.display = "none";
            linkBtn.style.display = "none";

            // Alignment: shown when a whole column is selected (and not the whole table)
            const isEntireTable = isEntireTableSelected(
                selection as CellSelection,
            );
            tableSep.style.display = isCol && !isEntireTable ? "" : "none";
            alignWrap.style.display = isCol && !isEntireTable ? "" : "none";

            // Delete-button visibility logic
            const headerRow = isRow && isFirstRow(selection as CellSelection);
            deleteTableBtn.style.display = isEntireTable ? "" : "none";
            clearHeaderBtn.style.display =
                isRow && headerRow && !isEntireTable ? "" : "none";
            deleteRowBtn.style.display =
                isRow && !headerRow && !isEntireTable ? "" : "none";
            deleteColBtn.style.display = isCol && !isEntireTable ? "" : "none";
            deleteSep.style.display =
                isEntireTable || isRow || isCol ? "" : "none";

            // Position
            toolbar.style.visibility = "hidden";
            toolbar.style.display = "flex";
            positionToolbar(view, selection.from, selection.to);
            return;
        }

        // ── Text TextSelection mode ────────────────────
        if (selection.empty || !(selection instanceof TextSelection)) {
            hideToolbar();
            return;
        }

        const { $from } = selection;

        // Don't show inside a code block
        for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type.name === "code_block") {
                hideToolbar();
                return;
            }
        }

        const inTable = isInTableCell($from);

        // Format dropdown: hidden inside a table, shown normally outside one
        fmtWrap.style.display = inTable ? "none" : "";
        textFmtSep.style.display = inTable ? "none" : "";

        // Inline formats + link: always visible in text mode
        boldBtn.style.display = "";
        italicBtn.style.display = "";
        strikeBtn.style.display = "";
        codeBtn.style.display = "";
        linkSep.style.display = "";
        linkBtn.style.display = "";

        // Table-only elements: hidden
        tableSep.style.display = "none";
        alignWrap.style.display = "none";
        deleteRowBtn.style.display = "none";
        clearHeaderBtn.style.display = "none";
        deleteTableBtn.style.display = "none";
        deleteColBtn.style.display = "none";
        deleteSep.style.display = "none";

        // Highlight the current format + update the format-button icon (only meaningful outside table mode)
        if (!inTable) {
            let activeLevel = 0;
            for (let d = $from.depth; d >= 0; d--) {
                const n = $from.node(d);
                if (n.type.name === "heading") {
                    activeLevel = (n.attrs.level as number) ?? 0;
                    break;
                }
            }
            const labelEl = fmtBtn.querySelector(".sel-tb-fmt-label");
            if (labelEl) {
                labelEl.textContent = formats[activeLevel]?.[1] ?? "P";
            }
            fmtItems.forEach((item, i) => {
                item.classList.toggle(
                    "sel-tb-fmt-item--active",
                    i === 0 ? activeLevel === 0 : i === activeLevel,
                );
            });
        }

        // Position
        toolbar.style.visibility = "hidden";
        toolbar.style.display = "flex";
        positionToolbar(view, selection.from, selection.to);
    }

    // Recompute the toolbar position on scroll (so the fixed toolbar follows the content)
    window.addEventListener(
        "scroll",
        () => {
            if (toolbar.style.display !== "none" && lastView) {
                showAndPosition(lastView);
            }
        },
        { capture: true },
    );

    return { onSelectionChange: showAndPosition };
}
