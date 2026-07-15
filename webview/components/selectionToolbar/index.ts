import { commandsCtx } from "@milkdown/core";
import {
    toggleStrongCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
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
    IconHighlighter,
    IconEraser,
    IconMath,
    IconLink,
    IconChevronDown,
    IconChevronUp,
    IconCopy,
    IconAlignLeft,
    IconAlignCenter,
    IconAlignRight,
    IconTrash2,
    IconGripVertical,
} from "@/ui/icons";
import { applyTooltip } from "@/ui/tooltip";
import { t, kbd } from "@/i18n";
import { runEditorCommand } from "@/editorCommands";
import { createButton, createSeparator } from "@/ui/dom";
import { BlockRangeSelection } from "@/plugins/blockRange";
import { blockMarkerSpec } from "@/plugins/headingFold";
import {
    moveSelectedBlocks,
    duplicateSelectedBlocks,
    deleteSelectedBlocks,
} from "@/plugins/blockKeys";
import { resolveVisible, type FloatingToolbarItems } from "./registry";
import { computeToolbarActiveState } from "@/components/toolbar/activeState";
import { trackEditorReflow } from "@/ui/editorReflow";
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

/** The gutter symbol for a block node: a heading → an "H{n}" text badge, any
 *  other block → its gutter marker icon (¶, image, table, code, …), so the
 *  block palette's menu button reads as the very same affordance the margin
 *  handle shows. Falls back to the grip glyph for a block the gutter doesn't
 *  badge. */
function blockSymbolHTML(node: PMNode | null): string {
    if (!node) { return IconGripVertical; }
    if (node.type.name === "heading") {
        const level = Math.min(Math.max(Number(node.attrs["level"]) || 1, 1), 6);
        return `<span class="sel-tb-block-badge">H${level}</span>`;
    }
    return blockMarkerSpec(node)?.icon ?? IconGripVertical;
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

export function setupSelectionToolbar(
    getView: () => EditorView | null,
    getEditor: () => Editor | null,
    openLinkPrompt: () => void,
    items?: FloatingToolbarItems,
): { onSelectionChange(view: EditorView): void; hide(): void } {
    // Per-item visibility for the inline (text-mode) buttons. Resolved once at
    // setup from the birta.floatingToolbar.items.* settings; a missing flag
    // defaults to visible. Table-mode and block-mode buttons are contextual
    // and not user-gated here.
    const visible = resolveVisible(items);
    let lastView: EditorView | null = null;
    let isDragging = false;

    // Quiet "on" look for a button whose mark/construct is active on the
    // selection — the same VS Code activated-option token the top toolbar uses
    // (styled via .sel-tb-btn--active), so the two surfaces read identically.
    const setActive = (el: HTMLElement, on: boolean): void => {
        el.classList.toggle("sel-tb-btn--active", on);
    };

    // Keep the bar glued to its selection as the editor scrolls or reflows (ToC
    // dock/resize/toggle, window resize) — via the shared reflow tracker, the
    // same one the link popup uses. Created lazily on first show (the view is
    // available by then) and never torn down (the palette lives for the session).
    let reflowOff: (() => void) | null = null;

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

    // Route through the shared command registry (same entries as the main
    // toolbar / palette) so a heading pick inside a list item lifts the line
    // out of the list instead of silently no-oping — a heading can't live in
    // list_item's `paragraph block*` content, so the raw wrapInHeading command
    // returns false there (MAR-111). The lift logic lives in editorCommands'
    // setHeading; never duplicate it here.
    const formats: [string, string, () => void][] = [
        [t("Paragraph"), "P", () => runEditorCommand("setParagraph", getEditor)],
        [t("Heading 1"), "H1", () => runEditorCommand("setHeading1", getEditor)],
        [t("Heading 2"), "H2", () => runEditorCommand("setHeading2", getEditor)],
        [t("Heading 3"), "H3", () => runEditorCommand("setHeading3", getEditor)],
        [t("Heading 4"), "H4", () => runEditorCommand("setHeading4", getEditor)],
        [t("Heading 5"), "H5", () => runEditorCommand("setHeading5", getEditor)],
        [t("Heading 6"), "H6", () => runEditorCommand("setHeading6", getEditor)],
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
    // Inline math sits with the mark buttons, right after inline code: it's an
    // inline construct like code, not a block insert, so it reads better beside
    // the marks than off in the clear-formatting group.
    const mathBtn = sBtn(IconMath, t("Inline Math"), () =>
        runEditorCommand("insertMath", getEditor),
    );
    const highlightBtn = sBtn(IconHighlighter, t("Highlight"), () =>
        runEditorCommand("toggleHighlight", getEditor),
    );
    toolbar.appendChild(boldBtn);
    toolbar.appendChild(italicBtn);
    toolbar.appendChild(strikeBtn);
    toolbar.appendChild(codeBtn);
    toolbar.appendChild(mathBtn);
    toolbar.appendChild(highlightBtn);

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

    // ── Insert group: clear formatting ──
    const insertSep = sSep();
    toolbar.appendChild(insertSep);
    const clearFmtBtn = sBtn(IconEraser, t("Clear Formatting"), () =>
        runEditorCommand("clearFormatting", getEditor),
    );
    toolbar.appendChild(clearFmtBtn);

    // ── Block-selection elements (shown only for a whole-block range) ──
    // A multi-block BlockRangeSelection has no gutter-menu surface (that menu
    // targets one block); these reuse the keyboard layer's range commands so
    // move/duplicate/delete behave identically to Alt+↑/↓ etc. and stay one
    // undo step. Hidden by default; the block branch of showAndPosition reveals
    // them.
    const runBlockCmd = (cmd: (
        state: EditorView["state"],
        dispatch: EditorView["dispatch"],
        view: EditorView,
    ) => boolean): void => {
        const v = getView();
        if (v) {
            cmd(v.state, v.dispatch, v);
            // The command's transaction fires a selection change, which
            // re-runs showAndPosition (reposition after a move, hide after a
            // delete collapses to a caret) — no manual follow-up needed.
        }
    };
    // Grab-menu button (leads the block group): opens the same gutter block
    // menu — turn-into + all block actions — so the full menu is discoverable
    // from the selection itself, not only the margin handle. Opening the menu
    // dismisses this palette (index.ts focusin), a clean hand-off to block level.
    const blockMenuBtn = sBtn(IconGripVertical, t("Block menu"), () =>
        runEditorCommand("openBlockMenu", getEditor),
    );
    blockMenuBtn.style.display = "none";
    toolbar.appendChild(blockMenuBtn);
    const blockSep = sSep();
    blockSep.style.display = "none";
    toolbar.appendChild(blockSep);
    const moveUpBtn = sBtn(IconChevronUp, t("Move Up"), () =>
        runBlockCmd(moveSelectedBlocks(-1)),
    );
    moveUpBtn.style.display = "none";
    toolbar.appendChild(moveUpBtn);
    const moveDownBtn = sBtn(IconChevronDown, t("Move Down"), () =>
        runBlockCmd(moveSelectedBlocks(1)),
    );
    moveDownBtn.style.display = "none";
    toolbar.appendChild(moveDownBtn);
    const dupBlockBtn = sBtn(IconCopy, t("Duplicate"), () =>
        runBlockCmd(duplicateSelectedBlocks(1)),
    );
    dupBlockBtn.style.display = "none";
    toolbar.appendChild(dupBlockBtn);
    const delBlockBtn = sBtn(IconTrash2, t("Delete"), () =>
        runBlockCmd(deleteSelectedBlocks),
    );
    delBlockBtn.classList.add("sel-tb-danger-btn");
    delBlockBtn.style.display = "none";
    toolbar.appendChild(delBlockBtn);

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

    // Group hide helpers — each mode shows its own controls and hides the
    // others, so a stale button from a prior selection never lingers.
    function hideAllInline(): void {
        fmtWrap.style.display = "none";
        textFmtSep.style.display = "none";
        boldBtn.style.display = "none";
        italicBtn.style.display = "none";
        strikeBtn.style.display = "none";
        codeBtn.style.display = "none";
        highlightBtn.style.display = "none";
        linkSep.style.display = "none";
        linkBtn.style.display = "none";
        insertSep.style.display = "none";
        clearFmtBtn.style.display = "none";
        mathBtn.style.display = "none";
    }
    function hideAllTable(): void {
        tableSep.style.display = "none";
        alignWrap.style.display = "none";
        deleteRowBtn.style.display = "none";
        clearHeaderBtn.style.display = "none";
        deleteTableBtn.style.display = "none";
        deleteColBtn.style.display = "none";
        deleteSep.style.display = "none";
    }
    function hideBlockButtons(): void {
        blockMenuBtn.style.display = "none";
        blockSep.style.display = "none";
        moveUpBtn.style.display = "none";
        moveDownBtn.style.display = "none";
        dupBlockBtn.style.display = "none";
        delBlockBtn.style.display = "none";
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
        // Start tracking scroll/reflow on first show (view.dom is live by now),
        // re-running showAndPosition so the bar follows its selection.
        if (!reflowOff) {
            reflowOff = trackEditorReflow(view.dom, () => {
                if (toolbar.style.display !== "none" && lastView) {
                    showAndPosition(lastView);
                }
            });
        }
        if (isDragging) {
            hideToolbar();
            return;
        }
        const { selection } = view.state;

        // ── Block-range selection mode (whole blocks) ──
        // A multi-block BlockRangeSelection has no gutter-menu surface (that
        // menu targets a single block), so the floating bar is its mouse
        // affordance: the grab menu (turn-into + all block actions), then move,
        // duplicate, delete the whole run.
        if (selection instanceof BlockRangeSelection) {
            hideAllInline();
            hideAllTable();
            // The menu button shows the selected block's gutter symbol (¶ / H2 /
            // image / table …), so it reads as the same handle the margin shows.
            blockMenuBtn.innerHTML = blockSymbolHTML(view.state.doc.nodeAt(selection.from));
            blockMenuBtn.style.display = "";
            // Separator between the grab menu and the move/dup/delete group.
            blockSep.style.display = "";
            moveUpBtn.style.display = "";
            moveDownBtn.style.display = "";
            dupBlockBtn.style.display = "";
            delBlockBtn.style.display = "";
            toolbar.style.visibility = "hidden";
            toolbar.style.display = "flex";
            positionToolbar(view, selection.from, selection.to);
            return;
        }

        // ── Table CellSelection mode ───────────────────
        if (selection instanceof CellSelection) {
            const isRow = selection.isRowSelection();
            const isCol = selection.isColSelection();

            // The format dropdown is meaningless in table mode, so hide it
            fmtWrap.style.display = "none";
            textFmtSep.style.display = "none";

            // Inline format buttons stay visible for every CellSelection
            // (subject to the user's per-item visibility settings).
            boldBtn.style.display = visible.has("bold") ? "" : "none";
            italicBtn.style.display = visible.has("italic") ? "" : "none";
            strikeBtn.style.display = visible.has("strikethrough") ? "" : "none";
            codeBtn.style.display = visible.has("inlineCode") ? "" : "none";
            highlightBtn.style.display = visible.has("highlight") ? "" : "none";

            // Link: hidden in cell-selection mode — the link prompt replaces
            // a flat text range, which would corrupt the table structure
            // when the selection spans cells. Clear-formatting / math / block
            // ops are not offered in cell mode either.
            linkSep.style.display = "none";
            linkBtn.style.display = "none";
            insertSep.style.display = "none";
            clearFmtBtn.style.display = "none";
            mathBtn.style.display = "none";
            hideBlockButtons();

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

            // Reflect active marks on the selected cells (matching the top
            // toolbar). Hidden buttons toggle harmlessly.
            const cellActive = computeToolbarActiveState(view.state);
            setActive(boldBtn, cellActive.marks.bold);
            setActive(italicBtn, cellActive.marks.italic);
            setActive(strikeBtn, cellActive.marks.strikethrough);
            setActive(codeBtn, cellActive.marks.inlineCode);
            setActive(highlightBtn, cellActive.marks.highlight);

            // A single-cell selection with every inline mark opted out has no
            // structure controls either → don't flash an empty bar.
            const hasCellMarks =
                visible.has("bold") ||
                visible.has("italic") ||
                visible.has("strikethrough") ||
                visible.has("inlineCode") ||
                visible.has("highlight");
            if (!hasCellMarks && !isEntireTable && !isRow && !isCol) {
                hideToolbar();
                return;
            }

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

        const { $from, $to } = selection;

        // Don't show inside a code block
        for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type.name === "code_block") {
                hideToolbar();
                return;
            }
        }

        const inTable = isInTableCell($from);

        // Turn-into (P/H1–H6) is a BLOCK operation, so it only belongs on a
        // block-scoped selection: the whole text of one block, or a run that
        // spans blocks. On a substring within a block it conflates levels —
        // you're formatting a phrase, not retyping the block — so hide it and
        // leave block conversion to the gutter menu.
        const wholeBlock =
            !$from.sameParent($to) ||
            (selection.from <= $from.start() && selection.to >= $to.end());

        // Text mode: each inline button honors its per-item visibility setting
        // (birta.floatingToolbar.items.*). The format dropdown is additionally
        // hidden inside a table cell (meaningless there) and on a substring
        // selection (block op on a phrase — see wholeBlock above).
        const showFormat = !inTable && visible.has("format") && wholeBlock;
        const showBold = visible.has("bold");
        const showItalic = visible.has("italic");
        const showStrike = visible.has("strikethrough");
        const showCode = visible.has("inlineCode");
        const showHighlight = visible.has("highlight");
        const showLink = visible.has("link");
        const showClear = visible.has("clearFormatting");
        const showMath = visible.has("math");
        fmtWrap.style.display = showFormat ? "" : "none";
        boldBtn.style.display = showBold ? "" : "none";
        italicBtn.style.display = showItalic ? "" : "none";
        strikeBtn.style.display = showStrike ? "" : "none";
        codeBtn.style.display = showCode ? "" : "none";
        highlightBtn.style.display = showHighlight ? "" : "none";
        linkBtn.style.display = showLink ? "" : "none";
        clearFmtBtn.style.display = showClear ? "" : "none";
        mathBtn.style.display = showMath ? "" : "none";

        // A separator only appears between two non-empty groups, so hiding items
        // by config never leaves a leading, trailing, or doubled separator.
        // Inline math now groups with the marks (it moved beside inline code).
        const hasMarks = showBold || showItalic || showStrike || showCode || showMath || showHighlight;
        const hasInsert = showClear;
        textFmtSep.style.display = showFormat && (hasMarks || showLink || hasInsert) ? "" : "none";
        linkSep.style.display = showLink && (showFormat || hasMarks) ? "" : "none";
        insertSep.style.display = hasInsert && (showFormat || hasMarks || showLink) ? "" : "none";

        // Nothing to show (every inline item opted out) → don't flash an empty bar.
        if (!showFormat && !hasMarks && !showLink && !hasInsert) {
            hideToolbar();
            return;
        }

        // Table-only and block-only elements: hidden in text mode
        hideAllTable();
        hideBlockButtons();

        // Reflect which inline marks/constructs are already applied on the
        // selection — the same derivation the top toolbar uses, so the two
        // surfaces can never disagree. Toggling a hidden button is harmless.
        const active = computeToolbarActiveState(view.state);
        setActive(boldBtn, active.marks.bold);
        setActive(italicBtn, active.marks.italic);
        setActive(strikeBtn, active.marks.strikethrough);
        setActive(codeBtn, active.marks.inlineCode);
        setActive(highlightBtn, active.marks.highlight);
        setActive(mathBtn, active.inlineMath);
        // A real [text](url) link is a mark; a [[wikilink]] is a node-selected
        // atom — both light the one Link button (matching the top toolbar).
        setActive(linkBtn, active.marks.link || active.wikiLink);

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

    return { onSelectionChange: showAndPosition, hide: hideToolbar };
}
