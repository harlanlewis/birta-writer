/**
 * Table NodeView (components/table/tableView.ts) driven through a REAL Milkdown
 * editor — no mocks. The NodeView wraps the gfm `table` node in a
 * `.mw-table > table > tbody(contentDOM)` structure plus an affordance overlay;
 * these tests prove that structure exists AND that inserting the NodeView does
 * not disturb parsing, serialization, or in-cell editing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { revealBlockControls } from "./helpers/revealBlockControls";
import { revealTableAffordances } from "./helpers/revealTableAffordances";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
    nodeViewCtx,
} from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { TableMap, CellSelection, addRowAfter } from "../pm";
import { TextSelection } from "../pm";
import type { Node as PMNode } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
} from "../utils/minimalDiff";
import { createTableView } from "../components/table/tableView";
import { contentGuardPlugin } from "../plugins/contentGuard";

const TABLE_MD = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";

/** Build a real editor WITH the table NodeView registered. */
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

/** Same editor WITHOUT the NodeView — the serialization control group. */
async function makePlainEditor(markdown: string): Promise<Editor> {
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

function findTable(v: EditorView): { node: PMNode; pos: number } {
    let node: PMNode | null = null;
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (n.type.name === "table" && node === null) {
            node = n;
            pos = p;
            return false;
        }
        return true;
    });
    if (!node) {
        throw new Error("no table in doc");
    }
    return { node, pos };
}

describe("table NodeView — DOM structure", () => {
    let editor: Editor;
    beforeEach(async () => {
        document.body.innerHTML = "";
        editor = await makeEditor(TABLE_MD);
    });
    afterEach(async () => {
        await editor.destroy();
    });

    it("should wrap the table in .mw-table > table > tbody with one <tr> per row", () => {
        const wrapper = document.querySelector(".mw-table");
        expect(wrapper).not.toBeNull();

        const table = wrapper!.querySelector(":scope > table");
        expect(table).not.toBeNull();

        const tbody = table!.querySelector(":scope > tbody");
        expect(tbody).not.toBeNull();

        // header row + two body rows = 3 <tr>, rendered by PM into the tbody.
        const rows = tbody!.querySelectorAll(":scope > tr");
        expect(rows.length).toBe(3);
    });

    it("should render the affordance overlay as a sibling of the table", () => {
        const wrapper = document.querySelector(".mw-table")!;
        const overlay = wrapper.querySelector(":scope > .mw-table-overlay");
        expect(overlay).not.toBeNull();
    });

    it("an overlay nobody has pointed at should hold no grips or insert bars", () => {
        // MAR-317: the overlay is a table's whole grip/insert layer and every
        // node of it is invisible at rest, so on a table-heavy document
        // building it at mount puts a large share of the first paint's DOM
        // into chrome nobody asked to see. The strip itself still mounts — it
        // is the frame the affordances are placed in — but it mounts empty.
        const overlay = document.querySelector(".mw-table-overlay")!;
        expect(overlay.querySelectorAll(".mw-grip")).toHaveLength(0);
        expect(overlay.querySelectorAll(".mw-insert")).toHaveLength(0);
    });

    it("should build one grip per row and per column plus an insert bar per gap", () => {
        const wrapper = document.querySelector<HTMLElement>(".mw-table")!;
        revealTableAffordances(wrapper);
        const overlay = document.querySelector(".mw-table-overlay")!;
        // 3 rows, 2 columns.
        expect(overlay.querySelectorAll(".mw-grip--row").length).toBe(3);
        expect(overlay.querySelectorAll(".mw-grip--col").length).toBe(2);
        // gaps = count + 1.
        expect(overlay.querySelectorAll(".mw-insert--row").length).toBe(4);
        expect(overlay.querySelectorAll(".mw-insert--col").length).toBe(3);
    });

    it("further pointer movement should reuse the grips, not rebuild them", () => {
        // Counting elements cannot catch this: a rebuild clears before it
        // builds, so the counts come out right either way. Element identity is
        // what a per-move rebuild would break — along with the `.mw-near`
        // reveal state and the drag in progress that happen to be riding on
        // those exact nodes.
        const wrapper = document.querySelector<HTMLElement>(".mw-table")!;
        revealTableAffordances(wrapper, { clientX: 0, clientY: 0 });
        const overlay = document.querySelector(".mw-table-overlay")!;
        const first = overlay.querySelector('.mw-grip--row[data-row="0"]');
        expect(first).not.toBeNull();
        revealTableAffordances(wrapper, { clientX: 40, clientY: 40 });
        expect(overlay.querySelector('.mw-grip--row[data-row="0"]')).toBe(first);
    });

    it("a structural edit before any reveal should still build the new row's grip", async () => {
        // The rebuild-on-structure-change path is skipped while unbuilt, so
        // the dimensions recorded then are all the first reveal has to go on.
        const v = view(editor);
        const { pos } = findTable(v);
        const $cell = v.state.doc.resolve(pos + 3);
        v.dispatch(v.state.tr.setSelection(TextSelection.near($cell)));
        addRowAfter(v.state, v.dispatch);
        await Promise.resolve();

        const wrapper = document.querySelector<HTMLElement>(".mw-table")!;
        const bodyRows = wrapper.querySelectorAll("tbody > tr").length;
        expect(bodyRows).toBe(4);
        revealTableAffordances(wrapper);
        const overlay = document.querySelector(".mw-table-overlay")!;
        expect(overlay.querySelectorAll(".mw-grip--row").length).toBe(4);
        expect(overlay.querySelectorAll(".mw-insert--row").length).toBe(5);
    });

    it("should mount the control column empty and fill it on the first reveal", () => {
        const wrapper = document.querySelector<HTMLElement>(".mw-table")!;
        const col = wrapper.querySelector(":scope > .bc-col");
        // The strip is there — it is the hover target that carries the reveal
        // — but its Full Width button is not, until a reveal arrives
        // (MAR-251). A call site that appended straight to `col.el` instead of
        // going through `add()` would fail here.
        expect(col).not.toBeNull();
        expect(col!.querySelectorAll(".bc-btn")).toHaveLength(0);
        revealBlockControls(wrapper);
        expect(col!.querySelectorAll(".mw-bc-width")).toHaveLength(1);
    });

    it("should read layout once per row and column, never once per affordance", async () => {
        // reposition() must stay strictly read-then-write (MAR-251): a
        // `style.top` write dirties layout, so a getBoundingClientRect() after
        // one forces a synchronous re-layout of the whole document. Re-reading
        // a row's or cell's rect inside the write loops — values the read phase
        // has already captured — is a forced layout per affordance, paid once
        // per table before first paint. Counting the reads makes that loud:
        // the budget scales with the TABLE (rows + columns), not with the
        // grips and insert bars being positioned (about twice as many).
        const wrapper = document.querySelector<HTMLElement>(".mw-table")!;
        // Nothing is positioned before the first reveal, so the read budget
        // only exists once the affordances do (MAR-317).
        revealTableAffordances(wrapper);
        const rows = wrapper.querySelectorAll("tbody > tr").length;
        const cols = wrapper.querySelectorAll("tbody > tr:first-child > *").length;
        const frame = (): Promise<void> =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

        await frame(); // let the mount-time pass drain
        const original = Element.prototype.getBoundingClientRect;
        let reads = 0;
        Element.prototype.getBoundingClientRect = function (this: Element) {
            reads++;
            return original.call(this);
        };
        try {
            // The capture-phase scroll listener is the cheapest way to ask for
            // exactly one more pass.
            window.dispatchEvent(new Event("scroll"));
            await frame();
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }
        // wrapper + table + one per row + one per first-row cell.
        expect(reads).toBe(2 + rows + cols);
    });

    it("a table nobody has pointed at should read no layout at all", async () => {
        // The other half of the read budget above (MAR-317). Every table on
        // the page runs this pass on the frames before first paint, and each
        // controller's reads land after the previous one's writes, so the
        // read-then-write discipline that makes ONE table's pass cheap does
        // not compose across a document full of them. An untouched table must
        // therefore read nothing, not read efficiently.
        const frame = (): Promise<void> =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        await frame(); // let the mount-time pass drain

        const original = Element.prototype.getBoundingClientRect;
        let reads = 0;
        Element.prototype.getBoundingClientRect = function (this: Element) {
            reads++;
            return original.call(this);
        };
        try {
            window.dispatchEvent(new Event("scroll"));
            await frame();
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }
        expect(reads).toBe(0);
    });

    it("a structural edit under the pointer should re-reveal, not leave the new grips dark", async () => {
        // The reveal keeps two pieces of state — the elements currently
        // carrying `.mw-near`, and the indices they were computed for, which
        // exist so an unchanged pointer position costs no DOM writes. A
        // rebuild throws away the elements but not the indices, so the
        // early-out then reports "nothing changed" against grips that no
        // longer exist and the freshly built ones stay invisible until the
        // pointer crosses into a different row.
        const frame = (): Promise<void> =>
            new Promise((r) => requestAnimationFrame(() => r()));
        const wrapper = document.querySelector<HTMLElement>(".mw-table")!;
        revealTableAffordances(wrapper);
        await frame(); // the reveal itself is rAF-coalesced
        const overlay = document.querySelector(".mw-table-overlay")!;
        expect(overlay.querySelectorAll(".mw-near").length).toBeGreaterThan(0);

        const v = view(editor);
        const { pos } = findTable(v);
        const $cell = v.state.doc.resolve(pos + 3);
        v.dispatch(v.state.tr.setSelection(TextSelection.near($cell)));
        addRowAfter(v.state, v.dispatch);
        await Promise.resolve();

        // Same pointer position, same nearest indices — the case the
        // early-out is built to skip.
        revealTableAffordances(wrapper);
        await frame();
        const near = overlay.querySelectorAll(".mw-near");
        expect(near.length).toBeGreaterThan(0);
        for (const el of near) {
            expect(overlay.contains(el)).toBe(true);
        }
    });

    it("a CellSelection made with no pointer should build the overlay and light the grip", () => {
        // The keyboard path (MAR-317). Shift+arrow produces a CellSelection
        // with no pointer anywhere near the table, and the lit grip is the
        // only chrome that answers it — so a pointer-only build trigger would
        // silently stop the highlight working. Nothing here reveals by
        // pointer: the selection dispatch is the whole gesture.
        const v = view(editor);
        const { node, pos } = findTable(v);
        const map = TableMap.get(node);
        const start = pos + 1;
        const $a = v.state.doc.resolve(start + map.positionAt(1, 0, node));
        const $h = v.state.doc.resolve(
            start + map.positionAt(1, map.width - 1, node),
        );
        v.dispatch(v.state.tr.setSelection(new CellSelection($a, $h)));

        const overlay = document.querySelector(".mw-table-overlay")!;
        expect(overlay.querySelectorAll(".mw-grip--row")).toHaveLength(3);
        const active = overlay.querySelectorAll<HTMLElement>(".mw-grip--active");
        expect(active).toHaveLength(1);
        expect(active[0]!.dataset.row).toBe("1");
    });
});

describe("table NodeView — serialization is unaffected", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("should serialize a table identically with and without the NodeView", async () => {
        const withView = await makeEditor(TABLE_MD);
        const withoutView = await makePlainEditor(TABLE_MD);

        const a = withView.action(getMarkdown());
        const b = withoutView.action(getMarkdown());

        expect(a).toBe(b);
        expect(a).toContain("| A | B |");

        await withView.destroy();
        await withoutView.destroy();
    });

    it("should round-trip a table byte-identically through the NodeView (with minimal-diff merge)", async () => {
        // Mirrors corpus invariant A: the raw serializer normalizes the
        // delimiter row, and the production minimal-diff + round-trip
        // protection layer restores the original bytes. The NodeView must not
        // change that outcome.
        const editor = await makeEditor(TABLE_MD);
        const serialized = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(TABLE_MD, serialized);
        const merged = applyMinimalChanges(TABLE_MD, serialized, protection);
        expect(merged).toBe(TABLE_MD);
        await editor.destroy();
    });
});

describe("table NodeView — editing a cell still serializes correctly", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("should reflect inserted cell text in the serialized markdown", async () => {
        const editor = await makeEditor(TABLE_MD);
        const v = view(editor);

        // Put the cursor inside body cell (1, 0) — the cell holding "1" — then
        // type "Z" at the selection (the same path real typing takes).
        const { node, pos } = findTable(v);
        const map = TableMap.get(node);
        const cellPos = pos + 1 + map.positionAt(1, 0, node);
        v.dispatch(
            v.state.tr.setSelection(
                TextSelection.near(v.state.doc.resolve(cellPos + 1)),
            ),
        );
        v.dispatch(v.state.tr.insertText("Z"));

        const out = editor.action(getMarkdown());
        expect(out).toContain("Z1");
        // Structure intact: still 3 rows, 2 columns.
        const after = findTable(v);
        const map2 = TableMap.get(after.node);
        expect(map2.height).toBe(3);
        expect(map2.width).toBe(2);

        await editor.destroy();
    });
});
