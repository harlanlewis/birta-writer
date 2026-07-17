/**
 * After Delete Row / Delete Column the caret must stay on the edited table
 * rather than teleporting to the top of the document (which, on a long file,
 * scrolls the user away from where they were working).
 *
 * Exercised through the real selection toolbar + a real Milkdown editor: a row
 * is row-selected, the Delete Row button is clicked, and the resulting caret is
 * asserted to be inside the surviving table — not in the leading paragraph.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
} from "@milkdown/core";
import { CellSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    setupSelectionToolbar,
    setPendingToolbarPos,
} from "../components/selectionToolbar";

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
        .use(gfmFidelity)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Position of the cell whose text content equals `text`. */
function cellPosByText(v: EditorView, text: string): number {
    let pos = -1;
    v.state.doc.descendants((node, p) => {
        if (pos >= 0) return false;
        if (
            (node.type.name === "table_cell" ||
                node.type.name === "table_header") &&
            node.textContent === text
        ) {
            pos = p;
            return false;
        }
        return true;
    });
    if (pos < 0) {
        throw new Error(`no cell with text "${text}"`);
    }
    return pos;
}

/** True when resolving `pos` lands inside a table node. */
function isInsideTable(v: EditorView, pos: number): boolean {
    const $pos = v.state.doc.resolve(Math.min(pos, v.state.doc.content.size));
    for (let d = $pos.depth; d >= 0; d--) {
        if ($pos.node(d).type.name === "table") {
            return true;
        }
    }
    return false;
}

describe("delete row/column caret placement", () => {
    let editor: Editor | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("deleting a data row should leave the caret inside the table, not at the document top", async () => {
        // Arrange — a paragraph precedes the table so document position 1 is
        // clearly the intro paragraph, distinct from any table position.
        editor = await makeEditor(
            "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
        );
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );

        // Row-select the "1 2" data row (first cell → last cell of that row).
        const anchor = cellPosByText(v, "1");
        const head = cellPosByText(v, "2");
        const rowSel = CellSelection.create(v.state.doc, anchor, head);
        expect(rowSel.isRowSelection()).toBe(true);
        v.dispatch(v.state.tr.setSelection(rowSel));

        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        const delBtn = document.querySelector<HTMLButtonElement>(
            ".sel-tb-del-row-btn",
        );
        expect(delBtn).not.toBeNull();
        expect(delBtn!.style.display).not.toBe("none");

        // Act — click Delete Row
        delBtn!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );

        // Assert — the "1 2" row is gone and the caret sits inside the table
        const cellTexts: string[] = [];
        v.state.doc.descendants((node) => {
            if (
                node.type.name === "table_cell" ||
                node.type.name === "table_header"
            ) {
                cellTexts.push(node.textContent);
            }
            return true;
        });
        expect(cellTexts).toEqual(["a", "b", "3", "4"]);

        const caret = v.state.selection.from;
        expect(isInsideTable(v, caret)).toBe(true);
        // Not parked in the leading "intro" paragraph near the document start.
        expect(caret).toBeGreaterThan(2);
    });

    it("deleting a column should leave the caret inside the table, not at the document top", async () => {
        // deleteColumn leaves a residual CellSelection (unlike deleteRow, which
        // leaves a TextSelection), so this exercises the CellSelection → $headCell
        // branch of the caret-collapse fix.
        editor = await makeEditor(
            "intro\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
        );
        const v = view(editor);
        const selTb = setupSelectionToolbar(
            () => v,
            () => editor,
            vi.fn(),
        );

        // Column-select the middle column (header "b" → data "2").
        const anchor = cellPosByText(v, "b");
        const head = cellPosByText(v, "2");
        const colSel = CellSelection.create(v.state.doc, anchor, head);
        expect(colSel.isColSelection()).toBe(true);
        v.dispatch(v.state.tr.setSelection(colSel));

        setPendingToolbarPos(100, 100);
        selTb.onSelectionChange(v);

        const delBtn = document.querySelector<HTMLButtonElement>(
            ".sel-tb-del-col-btn",
        );
        expect(delBtn).not.toBeNull();
        expect(delBtn!.style.display).not.toBe("none");

        // Act — click Delete Column
        delBtn!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );

        // Assert — the "b"/"2" column is gone and the caret sits inside the table
        const cellTexts: string[] = [];
        v.state.doc.descendants((node) => {
            if (
                node.type.name === "table_cell" ||
                node.type.name === "table_header"
            ) {
                cellTexts.push(node.textContent);
            }
            return true;
        });
        expect(cellTexts).toEqual(["a", "c", "1", "3"]);

        const caret = v.state.selection.from;
        expect(isInsideTable(v, caret)).toBe(true);
        expect(caret).toBeGreaterThan(2);
    });
});
