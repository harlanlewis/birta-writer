/**
 * editorCommands.ts tests (MAR-9).
 *
 * The registry is the single implementation behind the toolbar, the command
 * palette and the right-click menu. These tests verify:
 *   - Milkdown-command entries call the expected command key (via a mock
 *     commandsCtx), including heading level payloads;
 *   - UI-bound entries delegate to the host hooks;
 *   - copy-as-Markdown / copy-as-HTML serialize the selection and post a
 *     clipboardWrite message (exercised against a REAL editor);
 *   - runEditorCommand dispatches by id and no-ops on an unknown id.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { commandsCtx, editorViewCtx, Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import {
    toggleStrongCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    turnIntoTextCommand,
    wrapInHeadingCommand,
    wrapInBulletListCommand,
    wrapInOrderedListCommand,
    wrapInBlockquoteCommand,
    createCodeBlockCommand,
    insertHrCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand, toggleStrikethroughCommand, gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { CellSelection, TableMap } from "@milkdown/prose/tables";
import { configureSerialization, pureCommonmark } from "../serialization";
import { editorCommands, runEditorCommand, setEditorCommandHost } from "../editorCommands";
import { mockVscodeApi } from "./setup";

/** A lightweight fake editor whose action() hands back a mock ctx. */
function fakeEditor(selectionEmpty = true) {
    const call = vi.fn();
    const dispatch = vi.fn();
    const focus = vi.fn();
    // A cursor at document root so isInNode() reports "not inside" any block.
    const $from = { depth: 0, node: () => ({ type: { name: "doc" }, attrs: {} }) };
    const view = {
        state: {
            selection: { empty: selectionEmpty, from: 1, to: selectionEmpty ? 1 : 5, $from },
            schema: { marks: {} },
        },
        dispatch,
        focus,
    } as unknown as EditorView;
    const map = new Map<unknown, unknown>([
        [commandsCtx, { call }],
        [editorViewCtx, view],
    ]);
    const editor = { action: (fn: (ctx: { get: (k: unknown) => unknown }) => unknown) => fn({ get: (k) => map.get(k) }) };
    return { editor: editor as unknown as import("@milkdown/core").Editor, call, dispatch, focus };
}

describe("editorCommands registry — Milkdown command entries", () => {
    beforeEach(() => vi.clearAllMocks());

    it.each([
        ["toggleBold", toggleStrongCommand],
        ["toggleItalic", toggleEmphasisCommand],
        ["toggleStrikethrough", toggleStrikethroughCommand],
        ["setParagraph", turnIntoTextCommand],
        ["insertCodeBlock", createCodeBlockCommand],
        ["insertHorizontalRule", insertHrCommand],
    ] as const)("%s should call its command key", (id, command) => {
        // Arrange
        const { editor, call } = fakeEditor();
        // Act
        editorCommands[id](() => editor);
        // Assert
        expect(call).toHaveBeenCalledWith(command.key, undefined);
    });

    it("insertTable should call insertTableCommand with a 3x3 payload", () => {
        const { editor, call } = fakeEditor();
        editorCommands.insertTable(() => editor);
        expect(call).toHaveBeenCalledWith(insertTableCommand.key, { row: 3, col: 3 });
    });

    it.each([
        ["setHeading1", 1],
        ["setHeading3", 3],
        ["setHeading6", 6],
    ] as const)("%s should call wrapInHeadingCommand with the level", (id, level) => {
        const { editor, call } = fakeEditor();
        editorCommands[id](() => editor);
        expect(call).toHaveBeenCalledWith(wrapInHeadingCommand.key, level);
    });

    it("toggleInlineCode with a selection should toggle the inline-code mark", () => {
        const { editor, call } = fakeEditor(false);
        editorCommands.toggleInlineCode(() => editor);
        expect(call).toHaveBeenCalledWith(toggleInlineCodeCommand.key);
    });

    it.each([
        ["toggleBulletList", wrapInBulletListCommand],
        ["toggleOrderedList", wrapInOrderedListCommand],
        ["toggleBlockquote", wrapInBlockquoteCommand],
    ] as const)("%s (not already inside) should wrap via its command key", (id, command) => {
        const { editor, call } = fakeEditor();
        editorCommands[id](() => editor);
        expect(call).toHaveBeenCalledWith(command.key);
    });

    it("a null editor should be a safe no-op", () => {
        expect(() => editorCommands.toggleBold(() => null)).not.toThrow();
    });
});

describe("editorCommands registry — host-delegating entries", () => {
    const hooks = {
        openLinkPrompt: vi.fn(),
        openImagePanel: vi.fn(),
        openFind: vi.fn(),
        openFindReplace: vi.fn(),
        findNext: vi.fn(),
        findPrevious: vi.fn(),
        findSelection: vi.fn(),
        toggleToc: vi.fn(),
        editFrontmatter: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        setEditorCommandHost(hooks);
    });

    it.each([
        ["insertLink", "openLinkPrompt"],
        ["insertImage", "openImagePanel"],
        ["openFind", "openFind"],
        ["openFindReplace", "openFindReplace"],
        ["findNext", "findNext"],
        ["findPrevious", "findPrevious"],
        ["findSelection", "findSelection"],
        ["toggleToc", "toggleToc"],
        ["editFrontmatter", "editFrontmatter"],
    ] as const)("%s should delegate to host.%s", (id, hook) => {
        editorCommands[id](() => null);
        expect(hooks[hook]).toHaveBeenCalledTimes(1);
    });
});

describe("editorCommands registry — copy commands", () => {
    let editor: Editor;
    let v: EditorView;

    async function makeEditor(markdown: string): Promise<Editor> {
        const root = document.createElement("div");
        document.body.appendChild(root);
        return Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, markdown);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfm)
            .create();
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("hello world\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("copyAsMarkdown should post the serialized selection as markdown", () => {
        // Arrange — select "hello"
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        // Act
        editorCommands.copyAsMarkdown(() => editor);
        // Assert
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "clipboardWrite", format: "markdown", data: expect.stringContaining("hello") }),
        );
    });

    it("copyAsHtml should post the selection serialized as HTML", () => {
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        editorCommands.copyAsHtml(() => editor);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "clipboardWrite", format: "html", data: expect.stringContaining("hello") }),
        );
    });

    it("an empty selection should not post anything", () => {
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));
        editorCommands.copyAsMarkdown(() => editor);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });
});

describe("editorCommands registry — table row/column commands", () => {
    let editor: Editor;
    let v: EditorView;

    const TABLE_MD = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";

    async function makeEditor(markdown: string): Promise<Editor> {
        const root = document.createElement("div");
        document.body.appendChild(root);
        return Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, markdown);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfm)
            .create();
    }

    function findTable(): { node: import("@milkdown/prose/model").Node | null; pos: number } {
        let node: import("@milkdown/prose/model").Node | null = null;
        let pos = -1;
        v.state.doc.descendants((n, p) => {
            if (n.type.name === "table" && node === null) { node = n; pos = p; return false; }
            return true;
        });
        return { node, pos };
    }

    function tableHeight(): number {
        const { node } = findTable();
        return node ? TableMap.get(node).height : 0;
    }

    /** Select rows [r0..r1] (inclusive, 0-indexed) across all columns. */
    function selectRows(r0: number, r1: number): void {
        const { node, pos } = findTable();
        if (!node) { throw new Error("no table"); }
        const map = TableMap.get(node);
        const start = pos + 1;
        const anchor = v.state.doc.resolve(start + map.positionAt(r0, 0, node));
        const head = v.state.doc.resolve(start + map.positionAt(r1, map.width - 1, node));
        v.dispatch(v.state.tr.setSelection(new CellSelection(anchor, head)));
    }

    /** Select columns [c0..c1] (inclusive, 0-indexed) across all rows. */
    function selectCols(c0: number, c1: number): void {
        const { node, pos } = findTable();
        if (!node) { throw new Error("no table"); }
        const map = TableMap.get(node);
        const start = pos + 1;
        const anchor = v.state.doc.resolve(start + map.positionAt(0, c0, node));
        const head = v.state.doc.resolve(start + map.positionAt(map.height - 1, c1, node));
        v.dispatch(v.state.tr.setSelection(new CellSelection(anchor, head)));
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor(TABLE_MD);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
    });

    afterEach(async () => {
        await editor.destroy();
    });

    /** The document position inside the body cell at (row, col). */
    function cellPosAt(row: number, col: number): number {
        const { node, pos } = findTable();
        if (!node) { throw new Error("no table"); }
        const map = TableMap.get(node);
        return pos + 1 + map.positionAt(row, col, node) + 1;
    }

    it("insert commands insert exactly one row/column", () => {
        const before = tableHeight();
        selectRows(1, 1);
        editorCommands.tableInsertRowBelow(() => editor);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(before + 1);
    });

    it("a menu command with a cellPos target operates on that cell regardless of the live selection", () => {
        // Selection is elsewhere (row 1); the passed target points at row 2.
        selectRows(1, 1);
        const before = tableHeight(); // 3
        editorCommands.tableInsertRowBelow(() => editor, { cellPos: cellPosAt(2, 0) });
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(before + 1);
        // And a delete via target with NO cell selection at all still deletes the row.
        const h = tableHeight();
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1))); // caret at doc start
        editorCommands.tableDeleteRow(() => editor, { cellPos: cellPosAt(1, 0) });
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(h - 1);
    });

    it("a menu command whose cellPos target no longer resolves to a cell is a no-op", () => {
        // A deletable cell selection is live, so a fall-through to the ambient
        // selection (the old behavior) would visibly delete a row. The command
        // must bail instead of acting on that unreliable selection.
        selectRows(1, 1);
        const before = tableHeight();

        // cellPos past the document end (e.g. an inbound sync shrank the doc).
        editorCommands.tableDeleteRow(() => editor, { cellPos: v.state.doc.content.size + 50 });
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(before);

        // cellPos at doc start: resolvable, but not inside any table cell.
        editorCommands.tableDeleteRow(() => editor, { cellPos: 0 });
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(before);
    });

    /** Put a plain text cursor inside the body cell at (row, col). */
    function putCursor(row: number, col: number): void {
        const { node, pos } = findTable();
        if (!node) { throw new Error("no table"); }
        const map = TableMap.get(node);
        const cellPos = pos + 1 + map.positionAt(row, col, node);
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(cellPos + 1))));
    }

    it("tableDeleteRow with a single-cell selection should remove that row (not clear contents)", () => {
        const beforeH = tableHeight(); // header + 2 body = 3
        selectRows(1, 1); // single-cell-ish CellSelection on the first body row
        editorCommands.tableDeleteRow(() => editor);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(beforeH - 1); // row removed, not just emptied
    });

    it("tableDeleteRow with only a text cursor should still remove the row", () => {
        const beforeH = tableHeight();
        putCursor(1, 0); // just a caret, no cell selection
        editorCommands.tableDeleteRow(() => editor);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(tableHeight()).toBe(beforeH - 1);
    });

    it("tableDeleteColumn with a single-cell selection should remove that column", () => {
        const widthOf = () => { const { node } = findTable(); return node ? TableMap.get(node).width : 0; };
        const beforeW = widthOf(); // 2
        selectCols(0, 0);
        editorCommands.tableDeleteColumn(() => editor);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(widthOf()).toBe(beforeW - 1);
    });

    it("tableDeleteTable should remove the whole table", () => {
        selectRows(1, 1);
        editorCommands.tableDeleteTable(() => editor);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        expect(findTable().node).toBeNull();
    });
});

describe("runEditorCommand", () => {
    beforeEach(() => vi.clearAllMocks());

    it("a known id should dispatch into the registry", () => {
        const { editor, call } = fakeEditor();
        runEditorCommand("toggleBold", () => editor);
        expect(call).toHaveBeenCalledWith(toggleStrongCommand.key, undefined);
    });

    it("an unknown id should be a no-op", () => {
        const { editor, call } = fakeEditor();
        expect(() => runEditorCommand("doesNotExist", () => editor)).not.toThrow();
        expect(call).not.toHaveBeenCalled();
    });
});
