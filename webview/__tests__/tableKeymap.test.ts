/**
 * Table keyboard navigation (tabKeymap.ts), tested against a REAL editor built
 * with the same plugin order as editor.ts (gfm BEFORE tabKeymapPlugin), so the
 * assertions reflect actual keymap precedence — the one thing that can't be
 * verified by reading the code. Keys are fired through the assembled plugin
 * stack via `someProp("handleKeyDown")`, exactly as ProseMirror dispatches them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import { CellSelection, selectedRect, TableMap } from "@milkdown/prose/tables";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { tableKeymapPlugin } from "../plugins/tableKeymap";

const TABLE_MD = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";

describe("table keyboard navigation", () => {
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
            // tableKeymapPlugin FIRST — matches editor.ts, and must win over the
            // commonmark base keymap (whose Backspace only clears cell contents).
            .use(tableKeymapPlugin)
            .use(pureCommonmark)
            .use(gfmFidelity)
            .create();
    }

    function view(): EditorView {
        return editor.action((ctx) => ctx.get(editorViewCtx));
    }

    function findTable(): { node: import("@milkdown/prose/model").Node; pos: number } {
        let node: import("@milkdown/prose/model").Node | null = null;
        let pos = -1;
        v.state.doc.descendants((n, p) => {
            if (n.type.name === "table" && node === null) { node = n; pos = p; return false; }
            return true;
        });
        if (!node) { throw new Error("no table"); }
        return { node, pos };
    }

    /** Place the text cursor inside the body cell at (row, col). */
    function putCursor(row: number, col: number): void {
        const { node, pos } = findTable();
        const map = TableMap.get(node);
        const cellPos = pos + 1 + map.positionAt(row, col, node);
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(cellPos + 1))));
    }

    function fireKey(key: string, opts: KeyboardEventInit = {}): boolean {
        const event = new KeyboardEvent("keydown", { key, ...opts });
        return v.someProp("handleKeyDown", (f) => f(v, event)) || false;
    }

    beforeEach(async () => {
        editor = await makeEditor(TABLE_MD);
        v = view();
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("Enter in a table cell should move the cursor to the cell below (not exit the table)", () => {
        putCursor(1, 0); // header is row 0; first body row is row 1
        expect(selectedRect(v.state).top).toBe(1);
        const handled = fireKey("Enter");
        v = view();
        expect(handled).toBe(true);
        // Cursor is now one row down AND still inside the table.
        expect(selectedRect(v.state).top).toBe(2);
    });

    it("Enter on the last row should append a row and move into it", () => {
        putCursor(2, 1); // last body row
        const beforeHeight = TableMap.get(findTable().node).height; // 3
        fireKey("Enter");
        v = view();
        expect(TableMap.get(findTable().node).height).toBe(beforeHeight + 1);
        expect(selectedRect(v.state).top).toBe(3); // in the new last row
    });

    it("Tab in a table cell should move to the next cell, not insert spaces", () => {
        putCursor(1, 0);
        const before = findTable().node.textContent;
        fireKey("Tab");
        v = view();
        expect(selectedRect(v.state).left).toBe(1); // moved to the next column
        expect(findTable().node.textContent).toBe(before); // no spaces inserted
    });

    it("Shift-Tab in a table cell should move to the previous cell", () => {
        putCursor(1, 1);
        fireKey("Tab", { shiftKey: true });
        v = view();
        expect(selectedRect(v.state).left).toBe(0);
    });

    it("Tab on the last cell should append a row", () => {
        putCursor(2, 1); // bottom-right cell
        const beforeHeight = TableMap.get(findTable().node).height;
        fireKey("Tab");
        v = view();
        expect(TableMap.get(findTable().node).height).toBe(beforeHeight + 1);
    });
});
