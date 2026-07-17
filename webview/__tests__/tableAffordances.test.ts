/**
 * Table affordance BEHAVIOR, driven through a real editor with the table
 * NodeView registered — no mocks. jsdom has no layout, so only the
 * index-based, layout-independent parts are asserted here:
 *
 *   • clicking a row/column grip produces the right CellSelection,
 *   • clicking an insert "+" adds a row/column at the right index.
 *
 * The pure reorder math (reorderRow / reorderColumn / resolveDropIndex) is
 * covered by tableReorder.test.ts. The geometry-dependent pieces — grip/insert
 * POSITIONING, the drag ghost, and the drop indicator — require a real layout
 * engine and are verified manually in the GUI (see tableView.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
    nodeViewCtx,
} from "@milkdown/core";
import { CellSelection, TableMap } from "../pm";
import type { Node as PMNode } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    createTableView,
    nearestTargets,
} from "../components/table/tableView";

import { contentGuardPlugin } from "../plugins/contentGuard";

const TABLE_MD = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
            ctx.set(nodeViewCtx, [["table", createTableView]]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        // Real guard in the loop (MAR-108): these suites exercise guarded ops.
        .use(contentGuardPlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function tableNode(v: EditorView): PMNode {
    let node: PMNode | null = null;
    v.state.doc.descendants((n) => {
        if (n.type.name === "table" && node === null) {
            node = n;
            return false;
        }
        return true;
    });
    if (!node) {
        throw new Error("no table");
    }
    return node;
}

/** A grip is click-selected via a mousedown with no travel, then a mouseup. */
function pressGrip(el: Element): void {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // beginDrag listens on document for mouseup; no mousemove ⇒ treated as click.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

describe("nearestTargets (contextual reveal math)", () => {
    // Injected cached bounds — no layout engine needed (that is the point of
    // caching in reposition() and hit-testing purely off the numbers).
    const rowBounds = [
        { top: 0, bottom: 20 },
        { top: 20, bottom: 40 },
        { top: 40, bottom: 60 },
    ];
    const colBounds = [
        { left: 0, right: 50 },
        { left: 50, right: 100 },
        { left: 100, right: 150 },
    ];

    it("a pointer inside a cell should select that row and column", () => {
        const n = nearestTargets(75, 35, rowBounds, colBounds);
        expect(n.row).toBe(1); // py 35 ∈ [20,40]
        expect(n.col).toBe(1); // px 75 ∈ [50,100]
    });

    it("should clamp to the first/last line when the pointer is outside the table", () => {
        expect(nearestTargets(-100, -100, rowBounds, colBounds).row).toBe(0);
        expect(nearestTargets(999, 999, rowBounds, colBounds).row).toBe(2);
        expect(nearestTargets(-100, -100, rowBounds, colBounds).col).toBe(0);
        expect(nearestTargets(999, 999, rowBounds, colBounds).col).toBe(2);
    });

    it("should pick the nearest interior gap for the insert reveal", () => {
        // py 35 is 5px from the gridline at y=40 (gap index 2) → nearest gap 2.
        expect(nearestTargets(0, 35, rowBounds, colBounds).rowGap).toBe(2);
        // px 95 is 5px from the gridline at x=100 (gap index 2).
        expect(nearestTargets(95, 0, rowBounds, colBounds).colGap).toBe(2);
    });

    it("should pick the trailing gap past the last line", () => {
        // py 58 is closest to the bottom edge (y=60) → trailing gap = height.
        expect(nearestTargets(0, 58, rowBounds, colBounds).rowGap).toBe(3);
        expect(nearestTargets(148, 0, rowBounds, colBounds).colGap).toBe(3);
    });

    it("empty bounds should yield -1 indices", () => {
        const n = nearestTargets(10, 10, [], []);
        expect(n).toEqual({ row: -1, col: -1, rowGap: -1, colGap: -1 });
    });
});

describe("grip click selection", () => {
    let editor: Editor;
    let v: EditorView;
    beforeEach(async () => {
        document.body.innerHTML = "";
        editor = await makeEditor(TABLE_MD);
        v = view(editor);
    });
    afterEach(async () => {
        await editor.destroy();
    });

    it("clicking a row grip should select the whole row (CellSelection.isRowSelection)", () => {
        const grip = document.querySelector('.mw-grip--row[data-row="1"]');
        expect(grip).not.toBeNull();
        pressGrip(grip!);

        v = view(editor);
        const sel = v.state.selection;
        expect(sel instanceof CellSelection).toBe(true);
        expect((sel as CellSelection).isRowSelection()).toBe(true);
    });

    it("clicking a column grip should select the whole column (CellSelection.isColSelection)", () => {
        const grip = document.querySelector('.mw-grip--col[data-col="2"]');
        expect(grip).not.toBeNull();
        pressGrip(grip!);

        v = view(editor);
        const sel = v.state.selection;
        expect(sel instanceof CellSelection).toBe(true);
        expect((sel as CellSelection).isColSelection()).toBe(true);
    });

    it("clicking the header row grip should still select it (header is click-selectable)", () => {
        const grip = document.querySelector('.mw-grip--row[data-row="0"]');
        pressGrip(grip!);
        v = view(editor);
        expect(v.state.selection instanceof CellSelection).toBe(true);
        expect((v.state.selection as CellSelection).isRowSelection()).toBe(true);
    });
});

describe("insert + buttons", () => {
    let editor: Editor;
    let v: EditorView;
    beforeEach(async () => {
        document.body.innerHTML = "";
        editor = await makeEditor(TABLE_MD);
        v = view(editor);
    });
    afterEach(async () => {
        await editor.destroy();
    });

    function clickInsert(kind: "row" | "col", gap: number): void {
        const btn = document.querySelector(
            `.mw-insert--${kind}[data-gap="${gap}"] .mw-insert-btn`,
        );
        expect(btn, `insert button for ${kind} gap ${gap}`).not.toBeNull();
        btn!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }

    it("clicking a row insert should add exactly one row", () => {
        const before = TableMap.get(tableNode(v)).height;
        clickInsert("row", 1); // between header (0) and first body row (1)
        v = view(editor);
        expect(TableMap.get(tableNode(v)).height).toBe(before + 1);
    });

    it("a row insert at gap 1 should place the new row directly below the header", () => {
        // Body cell (1,0) currently holds "1"; after inserting at gap 1 the new
        // (empty) row becomes row 1 and "1" shifts down to row 2.
        clickInsert("row", 1);
        v = view(editor);
        const node = tableNode(v);
        const map = TableMap.get(node);
        const rowText = (r: number): string[] => {
            const out: string[] = [];
            for (let c = 0; c < map.width; c++) {
                out.push(node.nodeAt(map.positionAt(r, c, node))!.textContent);
            }
            return out;
        };
        expect(rowText(1)).toEqual(["", "", ""]);
        expect(rowText(2)).toEqual(["1", "2", "3"]);
    });

    it("clicking a row insert at the trailing gap should append a row at the end", () => {
        const before = TableMap.get(tableNode(v)).height; // 3
        clickInsert("row", before); // gap after the last row
        v = view(editor);
        expect(TableMap.get(tableNode(v)).height).toBe(before + 1);
    });

    it("clicking a column insert should add exactly one column", () => {
        const before = TableMap.get(tableNode(v)).width; // 3
        clickInsert("col", 1);
        v = view(editor);
        expect(TableMap.get(tableNode(v)).width).toBe(before + 1);
    });

    it("clicking a column insert at the trailing gap should append a column", () => {
        const before = TableMap.get(tableNode(v)).width;
        clickInsert("col", before);
        v = view(editor);
        expect(TableMap.get(tableNode(v)).width).toBe(before + 1);
    });
});

/** Give each <tr> a distinct vertical band so drag hit-tests are deterministic. */
function stubRowLayout(bandHeight = 20): void {
    const rows = Array.from(
        document.querySelectorAll(".mw-table tbody tr"),
    ) as HTMLElement[];
    rows.forEach((row, i) => {
        const top = i * bandHeight;
        const bottom = top + bandHeight;
        row.getBoundingClientRect = () =>
            ({ top, bottom, left: 0, right: 100, width: 100, height: bandHeight, x: 0, y: top }) as DOMRect;
        Array.from(row.children).forEach((cell) => {
            (cell as HTMLElement).getBoundingClientRect = () =>
                ({ top, bottom, left: 0, right: 100, width: 100, height: bandHeight, x: 0, y: top }) as DOMRect;
        });
    });
}

describe("grip drag reorder", () => {
    const MD = "| A | B |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |\n| 3 | 3 |\n";
    let editor: Editor;
    let v: EditorView;
    beforeEach(async () => {
        document.body.innerHTML = "";
        editor = await makeEditor(MD);
        v = view(editor);
    });
    afterEach(async () => {
        await editor.destroy();
    });

    function tablePos(view: EditorView): number {
        let pos = -1;
        view.state.doc.descendants((n, p) => {
            if (n.type.name === "table" && pos < 0) {
                pos = p;
                return false;
            }
            return true;
        });
        return pos;
    }

    function selectRowRange(top: number, bottom: number): void {
        const node = tableNode(v);
        const pos = tablePos(v);
        const map = TableMap.get(node);
        const start = pos + 1;
        const $a = v.state.doc.resolve(start + map.positionAt(top, 0, node));
        const $h = v.state.doc.resolve(
            start + map.positionAt(bottom, map.width - 1, node),
        );
        v.dispatch(v.state.tr.setSelection(new CellSelection($a, $h)));
        v = view(editor);
    }

    it("should add .mw-table--dragging during a drag and remove it after", () => {
        const wrapper = document.querySelector(".mw-table") as HTMLElement;
        const grip = document.querySelector('.mw-grip--row[data-row="1"]')!;
        grip.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 25 }),
        );
        expect(wrapper.classList.contains("mw-table--dragging")).toBe(false);
        // Travel past the drag threshold flips the gesture into a real drag.
        document.dispatchEvent(
            new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 75 }),
        );
        expect(wrapper.classList.contains("mw-table--dragging")).toBe(true);
        document.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 75 }),
        );
        expect(wrapper.classList.contains("mw-table--dragging")).toBe(false);
    });

    it("dragging a grip inside a multi-row selection should move the whole block", () => {
        // Select body rows 1 and 2, then drag the row-1 grip below row 3.
        selectRowRange(1, 2);
        stubRowLayout();
        const grip = document.querySelector('.mw-grip--row[data-row="1"]')!;
        grip.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 25 }),
        );
        // Move to y=75 → past the last row's band (row 3 spans 60..80).
        document.dispatchEvent(
            new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 75 }),
        );
        document.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 75 }),
        );
        v = view(editor);
        const node = tableNode(v);
        const map = TableMap.get(node);
        const rowText = (r: number): string =>
            node.nodeAt(map.positionAt(r, 0, node))!.textContent;
        // Block ["1","2"] moved below "3": header, 3, 1, 2.
        expect([rowText(1), rowText(2), rowText(3)]).toEqual(["3", "1", "2"]);
    });

    it("dragging a grip OUTSIDE the selection should move just that one row", () => {
        selectRowRange(1, 2); // selection on rows 1..2
        stubRowLayout();
        // Drag row 3's grip (not in the selection) up above the selection.
        const grip = document.querySelector('.mw-grip--row[data-row="3"]')!;
        grip.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 65 }),
        );
        // Drop into the leading half of row 2's band (40..60) → between 1 and 2.
        document.dispatchEvent(
            new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 45 }),
        );
        document.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 45 }),
        );
        v = view(editor);
        const node = tableNode(v);
        const map = TableMap.get(node);
        const rowText = (r: number): string =>
            node.nodeAt(map.positionAt(r, 0, node))!.textContent;
        // Only "3" moved (block was NOT dragged): header, 1, 3, 2.
        expect([rowText(1), rowText(2), rowText(3)]).toEqual(["1", "3", "2"]);
    });
});
