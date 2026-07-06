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
import { insertFootnoteCommand } from "@/plugins";
import { insertInlineMathCommand } from "@/plugins/math";
import { lift } from "@milkdown/prose/commands";
import { TextSelection } from "@milkdown/prose/state";
import { DOMSerializer } from "@milkdown/prose/model";
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
} from "@milkdown/prose/tables";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import type { EditorCommandId } from "../shared/editorCommands";
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
            view.dispatch(view.state.tr.setSelection(new CellSelection($cell)));
        }
        fn(view.state, view.dispatch);
        view.focus();
    });
}

/** Serializes the current selection and hands it to the extension's clipboard. */
function copySelection(getEditor: GetEditor, format: "html" | "markdown"): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to, empty } = view.state.selection;
        if (empty) { return; }
        const slice = view.state.doc.slice(from, to);
        if (format === "markdown") {
            const serializer = ctx.get(serializerCtx);
            const doc = view.state.schema.topNodeType.create(null, slice.content);
            notifyClipboardWrite("markdown", serializer(doc));
        } else {
            const domSerializer = DOMSerializer.fromSchema(view.state.schema);
            const fragment = domSerializer.serializeFragment(slice.content);
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
    toggleInlineCode: (getEditor) => toggleInlineCode(getEditor),
    clearFormatting: (getEditor) => clearFormatting(getEditor),
    setParagraph: (getEditor) => callCmd(getEditor, turnIntoTextCommand),
    setHeading1: (getEditor) => callCmd(getEditor, wrapInHeadingCommand, 1),
    setHeading2: (getEditor) => callCmd(getEditor, wrapInHeadingCommand, 2),
    setHeading3: (getEditor) => callCmd(getEditor, wrapInHeadingCommand, 3),
    setHeading4: (getEditor) => callCmd(getEditor, wrapInHeadingCommand, 4),
    setHeading5: (getEditor) => callCmd(getEditor, wrapInHeadingCommand, 5),
    setHeading6: (getEditor) => callCmd(getEditor, wrapInHeadingCommand, 6),
    toggleBulletList: (getEditor) => toggleWrap(getEditor, "bullet_list", wrapInBulletListCommand),
    toggleOrderedList: (getEditor) => toggleWrap(getEditor, "ordered_list", wrapInOrderedListCommand),
    toggleTaskList: (getEditor) => toggleTaskList(getEditor),
    toggleBlockquote: (getEditor) => toggleWrap(getEditor, "blockquote", wrapInBlockquoteCommand),
    insertCodeBlock: (getEditor) => callCmd(getEditor, createCodeBlockCommand),
    insertHorizontalRule: (getEditor) => callCmd(getEditor, insertHrCommand),
    insertTable: (getEditor) => callCmd(getEditor, insertTableCommand, { row: 3, col: 3 }),
    insertLink: () => host.openLinkPrompt?.(),
    insertImage: () => host.openImagePanel?.(),
    insertMath: (getEditor) => callCmd(getEditor, insertInlineMathCommand),
    insertFootnote: (getEditor) => insertFootnote(getEditor),
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
    tableDeleteRow: (getEditor, args) => tableCmd(getEditor, deleteRow, args),
    tableDeleteColumn: (getEditor, args) => tableCmd(getEditor, deleteColumn, args),
    tableDeleteTable: (getEditor, args) => tableCmd(getEditor, deleteTable, args),
    copyAsHtml: (getEditor) => copySelection(getEditor, "html"),
    copyAsMarkdown: (getEditor) => copySelection(getEditor, "markdown"),
};

/** Dispatches an editor command by id; an unknown id is a safe no-op. */
export function runEditorCommand(id: string, getEditor: GetEditor, args?: unknown): void {
    const fn = (editorCommands as Record<string, EditorCommandFn | undefined>)[id];
    fn?.(getEditor, args);
}
