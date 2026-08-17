import { commandsCtx } from "@milkdown/core";
import { isReadOnly } from "@/readOnly";
import {
    toggleStrongCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
} from "@milkdown/preset-commonmark";
import type { Node as PMNode, ResolvedPos } from "@/pm";
import { toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import {
    CellSelection,
    deleteRow,
    deleteColumn,
    setCellAttr,
    TableMap,
} from "@/pm";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "@/pm";
import { TextSelection } from "@/pm";
import {
    IconBold,
    IconItalic,
    IconStrikethrough,
    IconCode,
    IconHighlighter,
    IconEraser,
    IconMath,
    IconLink,
    IconHash,
    IconAgentChat,
    IconChevronDown,
    IconChevronUp,
    IconCopy,
    IconAlignLeft,
    IconAlignCenter,
    IconAlignRight,
    IconTrash2,
    IconGripVertical,
    IconList,
    IconListOrdered,
    IconCheckSquare,
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
import { notifyCopyAgentReference } from "@/messaging";
import { computeToolbarActiveState } from "@/components/toolbar/activeState";
import { trackEditorReflow } from "@/ui/editorReflow";
import { clampLeft, pinIntoView, viewportSize } from "@/ui/anchoredPlacement";
import { safeAreaTop } from "@/utils/headingUtils";
import './selectionToolbar.css';

type GetEditor = () => Editor | null;

/**
 * Space check shared by the toolbar's hover submenus (text format, cell
 * alignment): default ABOVE the bar, switch below only when the bar sits too
 * close to the viewport top for the (approximate — the menu is hidden when
 * this runs) menu height. Deliberately NOT ui/anchoredPlacement: these menus
 * are CSS-anchored to their button wrapper (`calc(100% + 6px)`), invert the
 * usual below-first preference, and never clamp horizontally.
 *
 * The room above the bar ends at `safeAreaTop()`, not at the viewport top —
 * the palette itself can sit just clear of the topbar while a menu opening
 * upward from it lands underneath the bar and vanishes.
 */
function placeSubmenuVertical(menu: HTMLElement, btn: HTMLElement, approxH: number): void {
    const rect = btn.getBoundingClientRect();
    if (rect.top - safeAreaTop() < approxH + 16) {
        menu.style.bottom = "auto";
        menu.style.top = "calc(100% + 6px)";
    } else {
        menu.style.top = "auto";
        menu.style.bottom = "calc(100% + 6px)";
    }
}

/**
 * One-time position override: place the next show against these viewport
 * coordinates instead of against the selection.
 *
 * NOTHING in the product calls this. The row/column drag handles that did were
 * replaced by the table overlay (components/table/tableView.ts), which leaves
 * placement to the selection. It survives because the jsdom unit suite has no
 * layout engine and so cannot go through `coordsAtPos`; every caller is a test.
 * Keep that in mind before treating the pointer branch as a live path.
 */
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
    return createButton({ className: "ui-btn sel-tb-btn", icon, title, tooltipPlacement: "above", onClick });
}

/** The gutter symbol for a block node: a heading → an "H{n}" text badge, a
 *  list (or list item) → its flavor's icon (the gutter marks lists per ITEM,
 *  so the list node derives the same glyph), any other block → its gutter
 *  marker icon (¶, image, table, code, …), so the block palette's menu button
 *  reads as the very same affordance the margin handle shows. Falls back to
 *  the grip glyph for a block the gutter doesn't badge. */
function blockSymbolHTML(node: PMNode | null): string {
    if (!node) { return IconGripVertical; }
    if (node.type.name === "heading") {
        const level = Math.min(Math.max(Number(node.attrs["level"]) || 1, 1), 6);
        return `<span class="sel-tb-block-badge">H${level}</span>`;
    }
    if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
        return listSymbolHTML(node);
    }
    if (node.type.name === "list_item") {
        if (node.attrs["checked"] != null) { return IconCheckSquare; }
        return node.attrs["listType"] === "ordered" ? IconListOrdered : IconList;
    }
    return blockMarkerSpec(node)?.icon ?? IconGripVertical;
}

/** A list node's flavor icon — the slash registry's own art (IconList /
 *  IconListOrdered / IconCheckSquare), task detected like the capability
 *  classifier (first item carries a `checked` attr). */
function listSymbolHTML(node: PMNode): string {
    if (node.type.name === "ordered_list") { return IconListOrdered; }
    return node.firstChild?.attrs["checked"] != null ? IconCheckSquare : IconList;
}

/** The symbol for a whole BLOCK RANGE: when every covered sibling renders the
 *  same gutter symbol, the palette leads with that symbol — the selection
 *  reads as "N of this kind" — and falls back to the neutral grip for a mixed
 *  run. Works at any depth (top-level blocks and list-item ranges alike). */
function rangeSymbolHTML(view: EditorView, from: number, to: number): string {
    const $from = view.state.doc.resolve(from);
    const parent = $from.depth === 0 ? view.state.doc : $from.parent;
    const base = $from.depth === 0 ? 0 : $from.start();
    let symbol: string | null = null;
    let mixed = false;
    parent.forEach((child: PMNode, offset: number) => {
        const pos = base + offset;
        if (mixed || pos < from || pos >= to) { return; }
        const s = blockSymbolHTML(child);
        if (symbol === null) { symbol = s; }
        else if (s !== symbol) { mixed = true; }
    });
    return mixed || symbol === null ? IconGripVertical : symbol;
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
    /** Hidden for being off screen rather than dismissed — see hideOffScreen. */
    let hiddenOffScreen = false;
    // Last block symbol painted into the menu button, so scroll/reflow re-runs of
    // showAndPosition don't re-parse the SVG and rebuild the DOM every frame.
    let lastBlockSymbol = "";

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
    fmtBtn.className = "ui-btn sel-tb-btn sel-tb-fmt-btn";
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
        item.className = "ui-menu-row sel-tb-fmt-item";
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
        placeSubmenuVertical(fmtMenu, fmtBtn, formats.length * 30);
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
        className: "ui-btn sel-tb-btn sel-tb-link-btn",
        icon: IconLink,
        title: t("Insert/Edit Link"),
        tooltipPlacement: "above",
        onClick: openLinkPrompt,
    });
    toolbar.appendChild(linkBtn);

    // Link to section: opens the heading picker, then inserts `[text](#slug)`
    // to the chosen heading (MAR-176). Sits with the link button — the headline
    // use case is "select text → link it to a section" — and routes through the
    // shared command registry, so it behaves identically wherever it's invoked.
    const sectionLinkBtn = sBtn(IconHash, t("Link to Section"), () =>
        runEditorCommand("insertSectionLink", getEditor),
    );
    sectionLinkBtn.classList.add("sel-tb-section-link-btn");
    toolbar.appendChild(sectionLinkBtn);

    // ── Insert group: clear formatting ──
    const insertSep = sSep();
    toolbar.appendChild(insertSep);
    const clearFmtBtn = sBtn(IconEraser, t("Clear Formatting"), () =>
        runEditorCommand("clearFormatting", getEditor),
    );
    toolbar.appendChild(clearFmtBtn);

    // ── Agent group: copy a reference for an AI agent ──
    // The one-click path for "tell my coding agent what I'm looking at": puts
    // `path.md#L12-L20` on the clipboard via the same extension-side command as
    // the context menu, so payload and feedback are identical. It reads the
    // document and writes nothing — separated from the formatting groups.
    const agentSep = sSep();
    toolbar.appendChild(agentSep);
    const agentRefBtn = sBtn(IconAgentChat, t("Copy Reference for AI Agent"), () =>
        notifyCopyAgentReference(),
    );
    agentRefBtn.classList.add("sel-tb-agent-btn");
    toolbar.appendChild(agentRefBtn);

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
    alignBtn.className = "ui-btn sel-tb-btn sel-tb-fmt-btn";
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
        item.className = "ui-menu-row sel-tb-fmt-item sel-tb-align-item";
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
        placeSubmenuVertical(alignMenu, alignBtn, alignDefs.length * 34);
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

    // ── Click outside the toolbar to close it ──────────────────────────
    // Deliberately NOT ui/outsideClick: this surface's "inside" region is not
    // its own DOM but the whole editor — a click anywhere in `.milkdown`
    // moves or extends the selection (shift+click included) and the toolbar
    // must follow it, not dismiss. Dismissal here means "outside the toolbar
    // AND outside the editor", gated on the toolbar being visible; forcing
    // that through the shared contains-only helper would bury the
    // editor-is-inside semantics in its callback.
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
        hiddenOffScreen = false;
    }

    /**
     * Hidden because its selection scrolled out of view, which is NOT the same
     * as dismissed. The selection is still live, so scrolling back must bring
     * the bar back — and the reflow tracker below skips a bar that is display:
     * none, so without this flag the first scroll past the selection would
     * retire the palette for good.
     */
    function hideOffScreen(): void {
        hideToolbar();
        hiddenOffScreen = true;
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
        sectionLinkBtn.style.display = "none";
        insertSep.style.display = "none";
        clearFmtBtn.style.display = "none";
        mathBtn.style.display = "none";
        agentSep.style.display = "none";
        agentRefBtn.style.display = "none";
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

    /**
     * The selection's box in viewport coordinates, plus the bottom of its FIRST
     * ROW — the placement ladder needs both, because "below the selection" and
     * "below the selection's first line" are the same place for a phrase and a
     * screen apart for a column.
     */
    interface SelectionBox {
        top: number;
        bottom: number;
        left: number;
        right: number;
        firstRowBottom: number;
        /**
         * The top of the selection INCLUDING its grabber, where it has one: a
         * selected column's grip sits in the gutter just above the header cell,
         * and it is the handle for dragging the column you just selected, so a
         * bar seated against the cell covers the very control that made the
         * selection. Equal to `top` when the selection has no such chrome.
         */
        chromeTop: number;
    }

    /**
     * The selection's own box, in viewport coordinates.
     *
     * A CellSelection is measured from the cells prosemirror-tables has already
     * marked, not from `coordsAtPos`. Its `from`/`to` are cell BOUNDARIES, and
     * asking for the coordinates of one does not give you the cell: for a
     * column selection the reported top landed above the table entirely, which
     * is what sent the palette to the fallback side and left it pinned near the
     * viewport floor, a screen away from the column it acts on. The marked
     * cells are exactly what the user sees highlighted, so they are the honest
     * anchor as well as the correct one.
     *
     * Gated on the selection's TYPE, not on whether the query finds anything:
     * this runs on every scroll frame the bar is up, and a whole-document class
     * query is not something a text selection should be paying for.
     */
    function selectionBox(
        view: EditorView,
        from: number,
        to: number,
    ): SelectionBox {
        if (view.state.selection instanceof CellSelection) {
            const cells = view.dom.querySelectorAll<HTMLElement>(".selectedCell");
            if (cells.length > 0) {
                // Two rects, not one per cell: the marked cells come back in
                // document order, so the first is the range's top-left and the
                // last its bottom-right, and the first cell's bottom is the
                // first row's. That holds because a Markdown table has no
                // merged cells to break the correspondence — the one assumption
                // here, and it is the format's, not this file's. It matters
                // because this runs on every scroll frame while the bar is up,
                // and a selected column has a rect per row to offer.
                const first = cells[0]!.getBoundingClientRect();
                const last = cells[cells.length - 1]!.getBoundingClientRect();
                const top = Math.min(first.top, last.top);
                const bottom = Math.max(first.bottom, last.bottom);
                // The lit grips of the selected row/column, which the table
                // overlay marks active. They exist by the time any CellSelection
                // does (a keyboard selection arms them too), and the fallback if
                // they do not is simply the cells' own top.
                let chromeTop = top;
                for (const grip of view.dom.querySelectorAll<HTMLElement>(".mw-grip--active")) {
                    chromeTop = Math.min(chromeTop, grip.getBoundingClientRect().top);
                }
                return {
                    top,
                    bottom,
                    left: Math.min(first.left, last.left),
                    right: Math.max(first.right, last.right),
                    firstRowBottom: first.bottom,
                    chromeTop,
                };
            }
        }
        const startC = view.coordsAtPos(from);
        const endC = view.coordsAtPos(to);
        return {
            top: startC.top,
            bottom: endC.bottom,
            left: startC.left,
            right: endC.right,
            firstRowBottom: startC.bottom,
            chromeTop: startC.top,
        };
    }

    /**
     * Place the palette against its selection, in this order:
     *
     *  1. above the selection's GRABBER — for a column that is the grip in
     *     the gutter, so the bar lands clear of the very control that made
     *     the selection and is the handle for dragging it;
     *  2. below the selection's first row, when there is no room above;
     *  3. riding the top of the usable band once the selection's top edge has
     *     scrolled past it, so a selection taller than the window keeps its
     *     controls where the pinned column grip is (`pinIntoView`);
     *  4. hidden entirely once the selection itself is off screen — chrome for
     *     something nobody can see, floating over unrelated content.
     *
     * Only the palette hides at step 4. The selection stays live and every
     * keyboard path with it, so scrolling back brings the bar straight back.
     *
     * The band's top edge is the fixed chrome's bottom, not y=0. Against y=0 a
     * selection on the first line always "fit" above and the palette rendered
     * underneath the opaque topbar: present, positioned, and invisible.
     */
    function positionToolbar(view: EditorView, from: number, to: number): void {
        const tbW = toolbar.offsetWidth;
        const tbH = toolbar.offsetHeight;
        const viewport = viewportSize();
        const band = { start: (viewport.top ?? 0) + 8, end: viewport.height - 8 };

        // A pointer-anchored open (a grip drag handing over its coordinates)
        // places against the pointer and wants none of the ladder: the user is
        // looking at that spot. It is still bounded at BOTH ends of the band —
        // a pointer near either edge otherwise puts the bar under the topbar or
        // past the fold.
        if (pendingPos) {
            const { x: px, y: py } = pendingPos;
            pendingPos = null;
            const above = py - tbH - 8;
            const topY = above < band.start ? py + 12 : above;
            toolbar.style.left = `${clampLeft(px - tbW / 2, tbW, viewport)}px`;
            toolbar.style.top = `${Math.max(band.start, Math.min(topY, band.end - tbH))}px`;
            toolbar.style.visibility = "visible";
            return;
        }

        const box = selectionBox(view, from, to);
        // Step 4, first: everything below assumes there is something to point
        // at. The one exception is a palette the user is currently inside —
        // pulling a surface out from under someone's keyboard focus is worse
        // than leaving it up, and the next scroll after focus leaves retires it.
        if (box.bottom <= band.start || box.top >= band.end) {
            if (!toolbar.contains(document.activeElement)) {
                hideOffScreen();
                return;
            }
        }

        // Step 2 goes below the whole selection while the bar actually FITS
        // there, so it never covers the text it acts on; past that the
        // selection's bottom is not a place at all (below a screen-tall column
        // is off screen, which is what pinned the bar to the viewport floor
        // before), and the fallback is just under the selection's first row —
        // under the header, where the user's eye already is.
        const belowFrom = box.bottom + 8 + tbH <= band.end
            ? box.bottom
            : box.firstRowBottom;

        // Steps 1 and 2 turn on one question: is there room above the
        // selection's GRABBER? Above it, not above the cell — the grip is what
        // the user clicked and what drags the column, and a bar seated against
        // the cell covered its top half. The scrolled-past test still reads the
        // CELL, because the grip pins itself to the same chrome the band is
        // measured from and so would never register as gone.
        //
        // Step 3 is the third answer: the top edge has scrolled past the
        // chrome, neither side of it is a place, and resolving to the (now
        // off-band) above-position is the cue for `pinIntoView` to seat the bar
        // at the band's top, alongside the pinned grip. The same call takes the
        // bar off screen with a selection whose bottom passes, which is why
        // step 4's early return is a visibility decision, not a placement one.
        const aboveTop = box.chromeTop - tbH - 8;
        const preferred = aboveTop >= band.start || box.top < band.start
            ? aboveTop
            : belowFrom + 8;
        const topY = pinIntoView(
            preferred,
            tbH,
            { start: aboveTop, end: box.bottom + tbH + 8 },
            band,
        );
        toolbar.style.left = `${clampLeft((box.left + box.right) / 2 - tbW / 2, tbW, viewport)}px`;
        toolbar.style.top = `${topY}px`;
        toolbar.style.visibility = "visible";
    }

    function showAndPosition(view: EditorView): void {
        // Every control on this bar acts on the document — formatting, links,
        // block moves, table row and column edits — so read-only retires the
        // whole surface rather than dimming a dozen buttons (MAR-53). Selecting
        // text to read or copy is exactly what the mode is for, and a palette
        // of dead buttons appearing over the selection would fight that.
        // Copy stays reachable on Cmd+C and the native context menu.
        if (isReadOnly()) {
            hideToolbar();
            return;
        }
        lastView = view;
        // Start tracking scroll/reflow on first show (view.dom is live by now),
        // re-running showAndPosition so the bar follows its selection.
        if (!reflowOff) {
            reflowOff = trackEditorReflow(view.dom, () => {
                // A bar hidden for being off screen still tracks: its selection
                // is live, and scrolling back must bring it straight back.
                if ((toolbar.style.display !== "none" || hiddenOffScreen) && lastView) {
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
            // The menu button shows the selection's gutter symbol (¶ / H2 /
            // list / image / table …) whenever every covered block agrees on
            // one — so it reads as the same handle the margin shows — and the
            // neutral grip for a mixed run. Only rewrite when it changes
            // (this branch re-runs on scroll/reflow).
            const symbol = rangeSymbolHTML(view, selection.from, selection.to);
            if (symbol !== lastBlockSymbol) {
                blockMenuBtn.innerHTML = symbol;
                lastBlockSymbol = symbol;
            }
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
            sectionLinkBtn.style.display = "none";
            insertSep.style.display = "none";
            clearFmtBtn.style.display = "none";
            mathBtn.style.display = "none";
            agentSep.style.display = "none";
            agentRefBtn.style.display = "none";
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

        // What the caret is in and what it can become, from the same
        // derivation the top toolbar uses, so the two surfaces can never
        // disagree. It decides visibility below and lights the buttons
        // further down.
        const active = computeToolbarActiveState(view.state);

        // Text mode: each inline button honors its per-item visibility setting
        // (birta.floatingToolbar.items.*). The format dropdown is additionally
        // hidden where the caret's block cannot become a heading at all
        // (`formatApplicable`, the same probe that greys the top toolbar's
        // format control — a table cell holds a paragraph and nothing else)
        // and on a substring selection (block op on a phrase — see wholeBlock).
        const showFormat = active.formatApplicable && visible.has("format") && wholeBlock;
        const showBold = visible.has("bold");
        const showItalic = visible.has("italic");
        const showStrike = visible.has("strikethrough");
        const showCode = visible.has("inlineCode");
        const showHighlight = visible.has("highlight");
        const showLink = visible.has("link");
        const showSectionLink = visible.has("sectionLink");
        const showClear = visible.has("clearFormatting");
        const showMath = visible.has("math");
        const showAgentRef = visible.has("agentReference");
        fmtWrap.style.display = showFormat ? "" : "none";
        boldBtn.style.display = showBold ? "" : "none";
        italicBtn.style.display = showItalic ? "" : "none";
        strikeBtn.style.display = showStrike ? "" : "none";
        codeBtn.style.display = showCode ? "" : "none";
        highlightBtn.style.display = showHighlight ? "" : "none";
        linkBtn.style.display = showLink ? "" : "none";
        sectionLinkBtn.style.display = showSectionLink ? "" : "none";
        clearFmtBtn.style.display = showClear ? "" : "none";
        mathBtn.style.display = showMath ? "" : "none";
        agentRefBtn.style.display = showAgentRef ? "" : "none";

        // A separator only appears between two non-empty groups, so hiding items
        // by config never leaves a leading, trailing, or doubled separator.
        // Inline math now groups with the marks (it moved beside inline code).
        // Link + Link-to-section share the one link group (and its separator).
        const hasMarks = showBold || showItalic || showStrike || showCode || showMath || showHighlight;
        const hasLinks = showLink || showSectionLink;
        const hasInsert = showClear;
        textFmtSep.style.display = showFormat && (hasMarks || hasLinks || hasInsert) ? "" : "none";
        linkSep.style.display = hasLinks && (showFormat || hasMarks) ? "" : "none";
        insertSep.style.display = hasInsert && (showFormat || hasMarks || hasLinks) ? "" : "none";
        agentSep.style.display =
            showAgentRef && (showFormat || hasMarks || hasLinks || hasInsert) ? "" : "none";

        // Nothing to show (every inline item opted out) → don't flash an empty bar.
        if (!showFormat && !hasMarks && !hasLinks && !hasInsert && !showAgentRef) {
            hideToolbar();
            return;
        }

        // Table-only and block-only elements: hidden in text mode
        hideAllTable();
        hideBlockButtons();

        // Reflect which inline marks/constructs are already applied.
        // Toggling a hidden button is harmless.
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
