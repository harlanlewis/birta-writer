/**
 * Pure table-reorder logic: drop-index math and the row/column node rebuilds
 * that back the drag-handle reorder gesture (handles.ts), plus the
 * transaction-veto decision that protects a fresh cross-cell CellSelection
 * without ever dropping a document-changing transaction (tableCellClickFix.ts).
 *
 * Real table nodes are produced by a real Milkdown editor so the rebuilds run
 * against the actual GFM schema. acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
} from "@milkdown/core";
import type { Node as PMNode } from "@milkdown/prose/model";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    resolveDropIndex,
    resolveDropIndexRange,
    reorderRow,
    reorderColumn,
    reorderRowRange,
    reorderColumnRange,
} from "../components/table/reorder";
import { shouldVetoTransaction } from "../plugins/tableCellClickFix";

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

function findTable(editor: Editor): PMNode {
    return editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let table: PMNode | null = null;
        view.state.doc.descendants((node) => {
            if (node.type.name === "table") {
                table = node;
                return false;
            }
            return true;
        });
        if (!table) {
            throw new Error("no table found in doc");
        }
        return table;
    });
}

/** Row-major grid of cell text, for readable assertions. */
function grid(table: PMNode): string[][] {
    const rows: string[][] = [];
    table.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(cell.textContent));
        rows.push(cells);
    });
    return rows;
}

describe("resolveDropIndex", () => {
    it("dropping after a later target should shift back by one for the removed source", () => {
        // from=1 moved onto the trailing half of target 3 → lands at 3
        expect(resolveDropIndex(1, 3, false)).toBe(3);
    });

    it("dropping before an earlier target should keep the target index", () => {
        // from=3 moved onto the leading half of target 1 → lands at 1
        expect(resolveDropIndex(3, 1, true)).toBe(1);
    });

    it("dropping onto the trailing half of its own slot should be a no-op index", () => {
        expect(resolveDropIndex(1, 1, false)).toBe(1);
    });

    it("dropping a first element before a later target should shift back by one", () => {
        expect(resolveDropIndex(0, 2, true)).toBe(1);
    });
});

describe("resolveDropIndexRange", () => {
    it("should reduce to resolveDropIndex for a single-element block", () => {
        // Same args, block of one → identical result to the single-line helper.
        for (const [from, target, before] of [
            [1, 3, false],
            [3, 1, true],
            [1, 1, false],
            [0, 2, true],
        ] as const) {
            expect(resolveDropIndexRange(from, from, target, before)).toBe(
                resolveDropIndex(from, target, before),
            );
        }
    });

    it("dropping a block after a later target should shift back by the block size", () => {
        // Block [1..2] (size 2) dropped on the trailing half of target 4.
        // Original gap = 5; two removed elements precede it → 5 - 2 = 3.
        expect(resolveDropIndexRange(1, 2, 4, false)).toBe(3);
    });

    it("dropping a block before an earlier target should keep that gap", () => {
        // Block [3..4] dropped on the leading half of target 1 → gap 1, nothing
        // before it was removed.
        expect(resolveDropIndexRange(3, 4, 1, true)).toBe(1);
    });

    it("dropping inside the block itself should be a no-op at the block start", () => {
        // Any gap strictly inside [2..4] returns from0 (== 2).
        expect(resolveDropIndexRange(2, 4, 2, false)).toBe(2); // gap 3
        expect(resolveDropIndexRange(2, 4, 3, true)).toBe(2); // gap 3
        expect(resolveDropIndexRange(2, 4, 3, false)).toBe(2); // gap 4
    });
});

describe("reorderRowRange", () => {
    let editor: Editor | null = null;
    beforeEach(() => {
        document.body.innerHTML = "";
    });
    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("moving a two-row block down should relocate the whole block", async () => {
        editor = await makeEditor(
            "| h | h |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |\n| 3 | 3 |\n| 4 | 4 |\n",
        );
        const table = findTable(editor);
        // Move rows [1..2] ("1","2") to start at post-splice index 2.
        const out = reorderRowRange(table, 1, 2, 2);
        expect(grid(out)).toEqual([
            ["h", "h"],
            ["3", "3"],
            ["1", "1"],
            ["2", "2"],
            ["4", "4"],
        ]);
    });

    it("moving a block up should relocate it directly below the header", async () => {
        editor = await makeEditor(
            "| h | h |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |\n| 3 | 3 |\n",
        );
        const table = findTable(editor);
        // Move rows [2..3] ("2","3") to post-splice index 1 (below header).
        const out = reorderRowRange(table, 2, 3, 1);
        expect(grid(out)).toEqual([
            ["h", "h"],
            ["2", "2"],
            ["3", "3"],
            ["1", "1"],
        ]);
    });

    it("a block that includes the header should not move", async () => {
        editor = await makeEditor(
            "| h | h |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |\n",
        );
        const table = findTable(editor);
        // Block starts at row 0 → guard returns the node unchanged.
        const out = reorderRowRange(table, 0, 1, 2);
        expect(out).toBe(table);
    });

    it("dropping above the header (to === 0) should not move", async () => {
        editor = await makeEditor(
            "| h | h |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |\n",
        );
        const table = findTable(editor);
        const out = reorderRowRange(table, 2, 2, 0);
        expect(out).toBe(table);
    });

    it("moving a block onto its own start should be a no-op arrangement", async () => {
        editor = await makeEditor(
            "| h | h |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |\n| 3 | 3 |\n",
        );
        const table = findTable(editor);
        const out = reorderRowRange(table, 1, 2, 1);
        expect(grid(out)).toEqual(grid(table));
    });
});

describe("reorderColumnRange", () => {
    let editor: Editor | null = null;
    beforeEach(() => {
        document.body.innerHTML = "";
    });
    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("moving a two-column block to the end should move it in every row", async () => {
        editor = await makeEditor(
            "| a | b | c | d |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n",
        );
        const table = findTable(editor);
        // Move columns [0..1] (a,b / 1,2) to post-splice index 2 (the end).
        const out = reorderColumnRange(table, 0, 1, 2);
        expect(grid(out)).toEqual([
            ["c", "d", "a", "b"],
            ["3", "4", "1", "2"],
        ]);
    });

    it("moving a column block left should keep row and column counts", async () => {
        editor = await makeEditor(
            "| a | b | c | d |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n",
        );
        const table = findTable(editor);
        const out = reorderColumnRange(table, 2, 3, 0);
        expect(grid(out)).toEqual([
            ["c", "d", "a", "b"],
            ["3", "4", "1", "2"],
        ]);
    });
});

describe("reorderRow", () => {
    let editor: Editor | null = null;
    beforeEach(() => {
        document.body.innerHTML = "";
    });
    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("moving a data row down should reposition only that row", async () => {
        editor = await makeEditor(
            "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n",
        );
        const table = findTable(editor);
        // Move row index 1 ("1 2") to index 2.
        const out = reorderRow(table, 1, 2);
        expect(grid(out)).toEqual([
            ["a", "b"],
            ["3", "4"],
            ["1", "2"],
            ["5", "6"],
        ]);
        // Original node is untouched (pure transform).
        expect(grid(table)[1]).toEqual(["1", "2"]);
    });

    it("the rebuilt table should preserve the node type and attrs", async () => {
        editor = await makeEditor(
            "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
        );
        const table = findTable(editor);
        const out = reorderRow(table, 1, 2);
        expect(out.type.name).toBe("table");
        expect(out.childCount).toBe(table.childCount);
    });
});

describe("reorderColumn", () => {
    let editor: Editor | null = null;
    beforeEach(() => {
        document.body.innerHTML = "";
    });
    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    it("moving a column to the end should move that cell in every row", async () => {
        editor = await makeEditor(
            "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
        );
        const table = findTable(editor);
        // Move column 0 to index 2.
        const out = reorderColumn(table, 0, 2);
        expect(grid(out)).toEqual([
            ["b", "c", "a"],
            ["2", "3", "1"],
        ]);
    });

    it("swapping two columns should keep row count and column count", async () => {
        editor = await makeEditor(
            "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
        );
        const table = findTable(editor);
        const out = reorderColumn(table, 2, 0);
        expect(grid(out)).toEqual([
            ["c", "a", "b"],
            ["3", "1", "2"],
        ]);
    });
});

describe("shouldVetoTransaction", () => {
    it("with no armed veto should never block", () => {
        expect(shouldVetoTransaction(false, true, false, false)).toBe(false);
    });

    it("a document-changing transaction should pass even while the veto is armed", () => {
        // The regression guard: an inbound external-sync diff (docChanged,
        // non-cell selection) must not be dropped during the post-drag window.
        expect(shouldVetoTransaction(true, true, false, true)).toBe(false);
    });

    it("a pure selection replacement clobbering a CellSelection should be vetoed", () => {
        expect(shouldVetoTransaction(true, true, false, false)).toBe(true);
    });

    it("a selection change that keeps a CellSelection should pass", () => {
        expect(shouldVetoTransaction(true, true, true, false)).toBe(false);
    });
});
