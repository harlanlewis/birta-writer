/**
 * webview/editorCommands.ts
 *
 * The action registry behind every editor command (MAR-9). Each entry maps an
 * `EditorCommandId` to a function that performs the action against the live
 * Milkdown editor. The SAME registry is invoked from three places, so every
 * surface behaves identically:
 *   - the top toolbar buttons (webview/components/toolbar);
 *   - the VS Code command palette / right-click menu (via the `editorCommand`
 *     message dispatched in webview/messageHandlers.ts);
 *   - keyboard shortcuts that reuse these entries.
 *
 * Commands that need surrounding UI (the link prompt, image panel, find bar,
 * TOC panel, frontmatter panel) delegate to a host wired up by webview/index.ts
 * through `setEditorCommandHost`. Everything else is a pure editor mutation.
 */
import { commandsCtx, editorViewCtx, serializerCtx } from "@milkdown/core";
import {
    createCodeBlockCommand,
    insertHrCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
    turnIntoTextCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
    wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import {
    insertCalloutCommand,
    insertFootnoteCommand,
    toggleHighlightCommand,
} from "@/plugins";
import { insertInlineMathCommand } from "@/plugins/math";
import { lift } from "@milkdown/prose/commands";
import { liftListItem } from "@milkdown/prose/schema-list";
import { TextSelection } from "@milkdown/prose/state";
import { DOMSerializer, Fragment } from "@milkdown/prose/model";
import {
    addColumnAfter,
    addColumnBefore,
    addRowAfter,
    addRowBefore,
    cellAround,
    deleteColumn,
    deleteRow,
    deleteTable,
    CellSelection,
    TableMap,
} from "@milkdown/prose/tables";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import type { EditorCommandId } from "../shared/editorCommands";
import type { FontPreset, ProofreadOptionKey } from "../shared/messages";
import { notifyClipboardWrite } from "@/messaging";

export type GetEditor = () => Editor | null;

/**
 * UI-bound actions the registry delegates to. webview/index.ts populates this
 * after building the toolbar/find/TOC/frontmatter components; a missing hook is
 * simply a no-op (e.g. before wiring, or in a unit test that only cares about
 * the pure editor commands).
 */
export interface EditorCommandHost {
    openLinkPrompt(): void;
    openImagePanel(): void;
    openFind(): void;
    openFindReplace(): void;
    findNext(): void;
    findPrevious(): void;
    findSelection(): void;
    toggleToc(): void;
    editFrontmatter(): void;
    editRawMarkdown(): void;
    hideToolbar(): void;
    showToolbar(): void;
    customizeToolbar(): void;
    openExtensionSettings(): void;
    openKeyboardShortcuts(): void;
    // View controls owned by the toolbar controller / TOC panel. Wired the same
    // way as the toolbar's own hooks, so the palette reaches the exact code
    // paths the toolbar and slash menu use — and they work with the bar hidden.
    chooseFontPreset(preset: FontPreset): void;
    stepFontSize(delta: 1 | -1): void;
    toggleProofread(key: ProofreadOptionKey): void;
    toggleToolbar(): void;
    swapTocSide(): void;
}

let host: Partial<EditorCommandHost> = {};

/** Wires the UI-bound command hooks (called once from webview/index.ts). */
export function setEditorCommandHost(next: Partial<EditorCommandHost>): void {
    host = { ...host, ...next };
}

/** Calls a Milkdown command by its CmdKey through the commands manager. */
function callCmd<T>(getEditor: GetEditor, command: { key: unknown }, payload?: T): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const mgr = ctx.get(commandsCtx);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mgr.call(command.key as any, payload as any);
    });
}

/** Runs a ProseMirror command (state, dispatch) against the live view, then refocuses. */
function runProse(
    getEditor: GetEditor,
    fn: (view: EditorView) => void,
): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        fn(view);
    });
}

/** True when the cursor sits inside a node of the given type. */
function isInNode(view: EditorView, typeName: string): boolean {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth >= 0; depth--) {
        if ($from.node(depth).type.name === typeName) { return true; }
    }
    return false;
}

/** Inline code toggle: with a selection, toggle the mark; without one, drop a
 * zero-width placeholder carrying the mark and place the caret inside it. */
function toggleInlineCode(getEditor: GetEditor): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        if (!state.selection.empty) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.get(commandsCtx).call(toggleInlineCodeCommand.key as any);
            return;
        }
        const codeMark = state.schema.marks["inlineCode"];
        if (!codeMark) { return; }
        const { from } = state.selection;
        const textNode = state.schema.text("​", [codeMark.create()]);
        const tr = state.tr.insert(from, textNode);
        tr.setSelection(TextSelection.create(tr.doc, from + 1));
        view.dispatch(tr);
        view.focus();
    });
}

/** Removes every mark from the current (non-empty) selection. */
function clearFormatting(getEditor: GetEditor): void {
    runProse(getEditor, (view) => {
        const { state } = view;
        const { from, to, empty } = state.selection;
        if (empty) { return; }
        let tr = state.tr;
        Object.values(state.schema.marks).forEach((markType) => {
            tr = tr.removeMark(from, to, markType);
        });
        view.dispatch(tr);
        view.focus();
    });
}

/**
 * Set the current block's heading level. A heading cannot live inside a list
 * item — the schema's `list_item` content is `paragraph block*`, so its required
 * first child must be a paragraph — so `wrapInHeading` silently no-ops on a list
 * line. When the caret is inside one or more lists we first lift the block all
 * the way out (promoting it to a top-level block, splitting the surrounding
 * list) and only then apply the heading. This mirrors Notion/Obsidian: choosing
 * a heading on a list line turns that line into a heading and drops it from the
 * list. Paragraph (turnIntoText) is deliberately NOT lifted — a list item's
 * content is already a paragraph, so "P" is a no-op there and list membership
 * stays a separate concern owned by the Lists control.
 */
function setHeading(getEditor: GetEditor, level: number): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const liType = view.state.schema.nodes["list_item"];
        // liftListItem climbs one list level per call, so nested lists need
        // repeats. Bound the loop by the caret's initial depth (+slack) so it
        // can never spin — and stop early if a lift makes no progress.
        if (liType) {
            let guard = view.state.selection.$from.depth + 1;
            while (guard-- > 0 && isInNode(view, "list_item")) {
                if (!liftListItem(liType)(view.state, view.dispatch)) { break; }
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.get(commandsCtx).call(wrapInHeadingCommand.key as any, level);
        view.focus();
    });
}

/** Toggles a wrapping block: lifts out when already inside it, wraps otherwise. */
function toggleWrap(
    getEditor: GetEditor,
    nodeName: string,
    command: { key: unknown },
): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (isInNode(view, nodeName)) {
            lift(view.state, view.dispatch);
        } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.get(commandsCtx).call(command.key as any);
        }
    });
}

/** Task list toggle: lift out of a task item, or wrap in a bullet list and
 * mark its items as checkable. Mirrors the original toolbar behavior. */
function toggleTaskList(getEditor: GetEditor): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const { $from } = state.selection;
        let isTaskList = false;
        for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === "list_item" && node.attrs["checked"] != null) {
                isTaskList = true;
                break;
            }
        }
        if (isTaskList) {
            lift(state, view.dispatch);
            return;
        }
        const mgr = ctx.get(commandsCtx);
        mgr.call(wrapInBulletListCommand.key as never);
        const { state: newState, dispatch } = view;
        const { from, to } = newState.selection;
        let tr = newState.tr;
        let changed = false;
        newState.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === "list_item" && node.attrs["checked"] == null) {
                tr = tr.setNodeMarkup(pos, null, { ...node.attrs, checked: false });
                changed = true;
            }
        });
        if (changed) { dispatch(tr); }
    });
}

/** Inserts a footnote reference/definition pair and refocuses the editor. */
function insertFootnote(getEditor: GetEditor): void {
    callCmd(getEditor, insertFootnoteCommand);
    getEditor()?.action((ctx) => ctx.get(editorViewCtx).focus());
}

/** Wraps the selection in a callout of the given kind. Always a wrap —
 * callouts nest at any depth (block+), so inserting one inside a callout
 * NESTS rather than lifting out (the old toggle made "/tip" inside a note
 * silently destroy the outer callout). Unwrapping lives in the block
 * menu's turn-into, where it reads as an explicit conversion. */
function insertCallout(getEditor: GetEditor, args?: unknown): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        ctx.get(commandsCtx).call(
            insertCalloutCommand.key as never,
            typeof args === "string" ? args : undefined,
        );
        ctx.get(editorViewCtx).focus();
    });
}

/**
 * Runs a ProseMirror table command against the live view. When `args` carries a
 * `cellPos` (the document position of a right-clicked cell, passed through the
 * context menu), the selection is first moved to that cell so the command
 * targets exactly the cell the user clicked — the ProseMirror selection does not
 * survive VS Code's native context-menu round-trip, so relying on it would make
 * the command a no-op. Without a target it operates on the current selection
 * (command palette / keybinding).
 *
 * If a target WAS supplied but no longer resolves to a cell — e.g. an inbound
 * external-sync diff changed the document between the right-click and the
 * command arriving — bail rather than falling through to the ambient selection,
 * which is exactly the unreliable selection this targeting exists to avoid
 * (acting on it could mutate the wrong row/column). This guards the
 * no-longer-a-cell case; a doc shift that leaves cellPos resolving to a
 * DIFFERENT valid cell can't be detected from position alone and is accepted.
 */
function tableCmd(
    getEditor: GetEditor,
    fn: (state: EditorView["state"], dispatch: EditorView["dispatch"]) => boolean,
    args?: unknown,
): void {
    runProse(getEditor, (view) => {
        const cellPos = (args as { cellPos?: number } | undefined)?.cellPos;
        if (typeof cellPos === "number") {
            if (cellPos < 0 || cellPos > view.state.doc.content.size) {
                return;
            }
            const $cell = cellAround(view.state.doc.resolve(cellPos));
            if (!$cell) {
                return;
            }
            // Right-click inside an existing cell selection acts on THAT
            // selection (align/delete the grip-selected columns), the native
            // convention; a click outside it re-targets the clicked cell.
            // Membership is per-cell (`ranges`), not the flat from/to span —
            // a CellSelection's from/to cover only the anchor/head corners.
            const sel = view.state.selection;
            const clickedInsideSelection =
                sel instanceof CellSelection &&
                sel.ranges.some((r) => cellPos >= r.$from.pos && cellPos <= r.$to.pos);
            if (!clickedInsideSelection) {
                view.dispatch(view.state.tr.setSelection(new CellSelection($cell)));
            }
        }
        fn(view.state, view.dispatch);
        view.focus();
    });
}

/**
 * GFM column alignment (MAR-75): set the `alignment` attr on EVERY cell of the
 * column(s) the selection touches. The header row's attrs drive the serialized
 * `:---:` / `---:` / `:---` markers (serialization.ts reads `node.align` built
 * from the first row), and each body cell's attr drives its rendered
 * `text-align` — so both must move together. Re-picking a column's current
 * alignment TOGGLES it off (attr null → the unmarked `---` separator), which
 * is the only path back to the default in a menu with no state display.
 */
function columnAlignCommand(align: "left" | "center" | "right") {
    return (state: EditorView["state"], dispatch: EditorView["dispatch"]): boolean => {
        const sel = state.selection;
        let $anchorCell;
        let $headCell;
        if (sel instanceof CellSelection) {
            $anchorCell = sel.$anchorCell;
            $headCell = sel.$headCell;
        } else {
            const $cell = cellAround(sel.$from);
            if (!$cell) {
                return false;
            }
            $anchorCell = $cell;
            $headCell = $cell;
        }
        const table = $anchorCell.node(-1);
        const tableStart = $anchorCell.start(-1);
        const map = TableMap.get(table);
        const rect = map.rectBetween($anchorCell.pos - tableStart, $headCell.pos - tableStart);

        // Every cell of every spanned column, header included (deduped —
        // row/col-spanning cells appear at several map slots).
        const cellPositions = new Set<number>();
        for (let col = rect.left; col < rect.right; col++) {
            for (let row = 0; row < map.height; row++) {
                cellPositions.add(map.map[row * map.width + col]!);
            }
        }

        const allAlready = [...cellPositions].every(
            (pos) => table.nodeAt(pos)?.attrs["alignment"] === align,
        );
        const target = allAlready ? null : align;

        const tr = state.tr;
        for (const pos of cellPositions) {
            const cell = table.nodeAt(pos);
            if (!cell || cell.attrs["alignment"] === target) {
                continue;
            }
            tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, alignment: target });
        }
        if (!tr.docChanged) {
            return false;
        }
        dispatch(tr);
        return true;
    };
}

/**
 * The top-level block containing `blockPos` (right-click menus stamp the
 * position under the pointer), or undefined when it doesn't resolve. A caret
 * is the normal state when right-clicking, so "copy the block you clicked"
 * — a paragraph, list, or whole table — is the useful fallback.
 */
function blockContentAt(view: EditorView, blockPos: number): Fragment | undefined {
    if (blockPos < 0 || blockPos > view.state.doc.content.size) { return undefined; }
    const $pos = view.state.doc.resolve(blockPos);
    const node = $pos.depth >= 1 ? $pos.node(1) : ($pos.nodeAfter ?? $pos.nodeBefore);
    return node ? Fragment.from(node) : undefined;
}

/**
 * Serializes the selection — or, when it's empty, the block under the
 * right-click target — and hands it to the extension's clipboard.
 */
function copySelection(getEditor: GetEditor, format: "html" | "markdown", args?: unknown): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to, empty } = view.state.selection;
        let content: Fragment | undefined;
        if (!empty) {
            content = view.state.doc.slice(from, to).content;
        } else {
            const blockPos = (args as { blockPos?: number } | undefined)?.blockPos;
            if (typeof blockPos !== "number") { return; }
            content = blockContentAt(view, blockPos);
        }
        if (!content) { return; }
        if (format === "markdown") {
            const serializer = ctx.get(serializerCtx);
            const doc = view.state.schema.topNodeType.create(null, content);
            notifyClipboardWrite("markdown", serializer(doc));
        } else {
            const domSerializer = DOMSerializer.fromSchema(view.state.schema);
            const fragment = domSerializer.serializeFragment(content);
            const div = document.createElement("div");
            div.appendChild(fragment);
            notifyClipboardWrite("html", div.innerHTML);
        }
    });
}

export type EditorCommandFn = (getEditor: GetEditor, args?: unknown) => void;

/**
 * The action registry. Using `Record<EditorCommandId, …>` makes a missing or
 * misnamed entry a compile error, keeping the registry in lockstep with the
 * shared id list (and therefore with package.json via the drift-guard test).
 */
export const editorCommands: Record<EditorCommandId, EditorCommandFn> = {
    toggleBold: (getEditor) => callCmd(getEditor, toggleStrongCommand),
    toggleItalic: (getEditor) => callCmd(getEditor, toggleEmphasisCommand),
    toggleStrikethrough: (getEditor) => callCmd(getEditor, toggleStrikethroughCommand),
    toggleHighlight: (getEditor) => callCmd(getEditor, toggleHighlightCommand),
    toggleInlineCode: (getEditor) => toggleInlineCode(getEditor),
    clearFormatting: (getEditor) => clearFormatting(getEditor),
    setParagraph: (getEditor) => callCmd(getEditor, turnIntoTextCommand),
    setHeading1: (getEditor) => setHeading(getEditor, 1),
    setHeading2: (getEditor) => setHeading(getEditor, 2),
    setHeading3: (getEditor) => setHeading(getEditor, 3),
    setHeading4: (getEditor) => setHeading(getEditor, 4),
    setHeading5: (getEditor) => setHeading(getEditor, 5),
    setHeading6: (getEditor) => setHeading(getEditor, 6),
    toggleBulletList: (getEditor) => toggleWrap(getEditor, "bullet_list", wrapInBulletListCommand),
    toggleOrderedList: (getEditor) => toggleWrap(getEditor, "ordered_list", wrapInOrderedListCommand),
    toggleTaskList: (getEditor) => toggleTaskList(getEditor),
    toggleBlockquote: (getEditor) => toggleWrap(getEditor, "blockquote", wrapInBlockquoteCommand),
    // Optional string arg = fence language ("mermaid" from the slash menu)
    insertCodeBlock: (getEditor, args) =>
        callCmd(getEditor, createCodeBlockCommand, typeof args === "string" ? args : undefined),
    insertHorizontalRule: (getEditor) => callCmd(getEditor, insertHrCommand),
    insertTable: (getEditor) => callCmd(getEditor, insertTableCommand, { row: 3, col: 3 }),
    insertLink: () => host.openLinkPrompt?.(),
    insertImage: () => host.openImagePanel?.(),
    insertMath: (getEditor) => callCmd(getEditor, insertInlineMathCommand),
    insertFootnote: (getEditor) => insertFootnote(getEditor),
    // Optional string arg = callout kind ("warning" from the slash menu / picker)
    insertCallout: (getEditor, args) => insertCallout(getEditor, args),
    openFind: () => host.openFind?.(),
    openFindReplace: () => host.openFindReplace?.(),
    findNext: () => host.findNext?.(),
    findPrevious: () => host.findPrevious?.(),
    findSelection: () => host.findSelection?.(),
    toggleToc: () => host.toggleToc?.(),
    editFrontmatter: () => host.editFrontmatter?.(),
    tableInsertRowAbove: (getEditor, args) => tableCmd(getEditor, addRowBefore, args),
    tableInsertRowBelow: (getEditor, args) => tableCmd(getEditor, addRowAfter, args),
    tableInsertColumnLeft: (getEditor, args) => tableCmd(getEditor, addColumnBefore, args),
    tableInsertColumnRight: (getEditor, args) => tableCmd(getEditor, addColumnAfter, args),
    tableAlignColumnLeft: (getEditor, args) => tableCmd(getEditor, columnAlignCommand("left"), args),
    tableAlignColumnCenter: (getEditor, args) => tableCmd(getEditor, columnAlignCommand("center"), args),
    tableAlignColumnRight: (getEditor, args) => tableCmd(getEditor, columnAlignCommand("right"), args),
    tableDeleteRow: (getEditor, args) => tableCmd(getEditor, deleteRow, args),
    tableDeleteColumn: (getEditor, args) => tableCmd(getEditor, deleteColumn, args),
    tableDeleteTable: (getEditor, args) => tableCmd(getEditor, deleteTable, args),
    copyAsHtml: (getEditor, args) => copySelection(getEditor, "html", args),
    copyAsMarkdown: (getEditor, args) => copySelection(getEditor, "markdown", args),
    editRawMarkdown: () => host.editRawMarkdown?.(),
    hideToolbar: () => host.hideToolbar?.(),
    showToolbar: () => host.showToolbar?.(),
    customizeToolbar: () => host.customizeToolbar?.(),
    openExtensionSettings: () => host.openExtensionSettings?.(),
    openKeyboardShortcuts: () => host.openKeyboardShortcuts?.(),
    fontEditor: () => host.chooseFontPreset?.("editor"),
    fontSans: () => host.chooseFontPreset?.("sans"),
    fontSerif: () => host.chooseFontPreset?.("serif"),
    fontMono: () => host.chooseFontPreset?.("mono"),
    increaseFontSize: () => host.stepFontSize?.(1),
    decreaseFontSize: () => host.stepFontSize?.(-1),
    toggleSpellCheck: () => host.toggleProofread?.("spellCheck"),
    toggleGrammarCheck: () => host.toggleProofread?.("grammarCheck"),
    toggleStyleCheck: () => host.toggleProofread?.("styleCheck"),
    toggleToolbar: () => host.toggleToolbar?.(),
    swapTocSide: () => host.swapTocSide?.(),
};

/** Dispatches an editor command by id; an unknown id is a safe no-op. */
export function runEditorCommand(id: string, getEditor: GetEditor, args?: unknown): void {
    const fn = (editorCommands as Record<string, EditorCommandFn | undefined>)[id];
    fn?.(getEditor, args);
}
