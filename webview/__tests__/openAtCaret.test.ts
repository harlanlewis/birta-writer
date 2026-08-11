/**
 * Tests for the keyboard path into the gutter block menu
 * (components/blockMenu/openAtCaret.ts): caret → owning gutter unit →
 * openBlockMenu in keyboard mode.
 *
 * Drives the REAL Milkdown editor with the headingFold plugin (which renders
 * the gutter markers the resolver anchors to). jsdom renders the menu's DOM
 * but no layout — assertions target presence, focus, and anchor identity,
 * matching the existing blockMenu/headingFold suites. acquireVsCodeApi is
 * injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { NodeSelection, TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { BlockRangeSelection } from "../plugins/blockRange";
import { closeBlockMenu, openBlockMenuAtCaret, setBlockMenuContext } from "../components/blockMenu";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

// The Table section's rows dispatch through runEditorCommand, which needs
// the Editor ctx (the same wiring webview/index.ts performs).
setBlockMenuContext({ getEditor: () => activeEditor });

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    closeBlockMenu(); // release the menu's document/window listeners
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.className = "";
    document.body.innerHTML = "";
});

function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".block-menu");
}

/** The gutter marker the open menu is anchored to (openBlockMenu marks it). */
function openMarker(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".heading-fold-marker--menu-open");
}

/** Document position of the first node of `typeName` (descendants order). */
function posOf(v: EditorView, typeName: string, nth = 0): number {
    let found = -1;
    let seen = 0;
    v.state.doc.descendants((node, pos) => {
        if (found === -1 && node.type.name === typeName && seen++ === nth) {
            found = pos;
        }
        return found === -1;
    });
    expect(found, `no ${typeName} #${nth} in doc`).toBeGreaterThanOrEqual(0);
    return found;
}

function setCaret(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))));
}

describe("openBlockMenuAtCaret", () => {
    it("a caret in a top-level paragraph should open the menu on its P marker with the search focused", async () => {
        // Arrange
        const editor = await makeEditor("Alpha paragraph");
        const v = view(editor);
        setCaret(v, 2);
        document.body.classList.add("handles-quiet"); // mid-typing state

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: menu open, keyboard mode (focus in the search input),
        // anchored to the paragraph's own marker — and the quiet gutter is
        // left alone (no reveal flicker; --menu-open surfaces the anchor).
        expect(opened).toBe(true);
        expect(menu()).not.toBeNull();
        expect(document.activeElement).toBe(menu()!.querySelector(".block-menu-search"));
        expect(openMarker()!.dataset["pill"]).toBe("Paragraph");
        expect(document.body.classList.contains("handles-quiet")).toBe(true);
    });

    it("a caret on a heading line should anchor the menu to the heading's own badge", async () => {
        // Arrange
        const editor = await makeEditor("intro\n\n## Title\n\nbody");
        const v = view(editor);
        setCaret(v, posOf(v, "heading") + 2);

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: the H2 badge is the anchor, and the heading flavor of the
        // menu (Copy Link) is offered.
        expect(opened).toBe(true);
        expect(openMarker()!.dataset["pill"]).toBe("H2");
        const labels = Array.from(menu()!.querySelectorAll(".block-menu-item-label"))
            .map((el) => el.textContent);
        expect(labels).toContain("Copy Link");
    });

    it("a caret in a list should open the menu for the list ITEM unit", async () => {
        // Arrange: caret in the second item's text
        const editor = await makeEditor("- one\n- two");
        const v = view(editor);
        setCaret(v, posOf(v, "list_item", 1) + 2);

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: item-flavored menu (list-level conversions header), the
        // anchor marker living inside the second item's own <li>.
        expect(opened).toBe(true);
        const headers = Array.from(menu()!.querySelectorAll(".block-menu-header"))
            .map((el) => el.textContent);
        expect(headers).toContain("Turn list into");
        expect(openMarker()!.closest("li")!.textContent).toBe("two");
    });

    it("a caret in a nested list should resolve to the INNERMOST item", async () => {
        // Arrange: "two" lives in an item nested inside "one"'s item
        const editor = await makeEditor("- one\n  - two");
        const v = view(editor);
        setCaret(v, posOf(v, "list_item", 1) + 2);

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: the inner <li> (textContent exactly "two"; the outer item
        // concatenates both) owns the anchor.
        expect(opened).toBe(true);
        expect(openMarker()!.closest("li")!.textContent).toBe("two");
    });

    it("a caret in a quoted paragraph should fall through to the blockquote's marker", async () => {
        // Arrange: nested text paragraphs render no marker of their own —
        // the container is their handle.
        const editor = await makeEditor("> quoted text");
        const v = view(editor);
        setCaret(v, 3);

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert
        expect(opened).toBe(true);
        expect(openMarker()!.dataset["pill"]).toBe("Blockquote");
    });

    it("a caret inside a table cell should open the table's menu with a leading Table section", async () => {
        // Arrange (MAR-118): ⌘. inside a table used to bail; it now opens
        // the table's own menu, carrying the caret's cell so the Table rows
        // target the same row/column unit a right-click on the cell would.
        const editor = await makeEditor("| a | b |\n| - | - |\n| c | d |");
        const v = view(editor);
        setCaret(v, posOf(v, "table_cell") + 1);

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: keyboard mode, anchored to the table's own marker, Table
        // section FIRST (the caret's unit outranks table-block actions),
        // with the cell/row/column rows and the generic actions both present.
        expect(opened).toBe(true);
        expect(menu()).not.toBeNull();
        expect(document.activeElement).toBe(menu()!.querySelector(".block-menu-search"));
        expect(openMarker()!.dataset["pill"]).toBe("Table");
        const headers = Array.from(menu()!.querySelectorAll(".block-menu-header"))
            .map((el) => el.textContent);
        expect(headers[0]).toBe("Table");
        const labels = Array.from(menu()!.querySelectorAll(".block-menu-item-label"))
            .map((el) => el.textContent);
        for (const label of [
            "Insert Row Above", "Insert Row Below",
            "Insert Column Left", "Insert Column Right",
            "Align Column Left", "Align Column Center", "Align Column Right",
            "Delete Row", "Delete Column",
        ]) {
            expect(labels).toContain(label);
        }
        expect(labels).toContain("Delete"); // the table-block actions follow
    });

    it("activating Insert Row Below through the search combobox should add a row below the caret's row", async () => {
        // Arrange: caret in the first BODY cell ("c") — header + 1 body row.
        const editor = await makeEditor("| a | b |\n| - | - |\n| c | d |");
        const v = view(editor);
        setCaret(v, posOf(v, "table_cell") + 1);
        expect(openBlockMenuAtCaret(v)).toBe(true);
        const search = menu()!.querySelector<HTMLInputElement>(".block-menu-search")!;

        // Act: the real keyboard path — filter, then Enter on the top match.
        search.value = "insert row below";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        // Assert: one new (empty) row, landing after the caret's row.
        const table = v.state.doc.nodeAt(posOf(v, "table"))!;
        expect(table.childCount).toBe(3);
        expect(table.child(1).textContent).toBe("cd");
        expect(table.child(2).textContent).toBe("");
    });

    it("a table reached from the OUTSIDE (node selection) should keep the actions-only menu without a Table section", async () => {
        // Arrange: the depth-0 branch — no caret cell to carry.
        const editor = await makeEditor("| a | b |\n| - | - |\n| c | d |");
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, posOf(v, "table"))));

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert
        expect(opened).toBe(true);
        expect(openMarker()!.dataset["pill"]).toBe("Table");
        const headers = Array.from(menu()!.querySelectorAll(".block-menu-header"))
            .map((el) => el.textContent);
        expect(headers).not.toContain("Table");
    });

    it("a selected marker-less block (HR) should return false without opening anything", async () => {
        // Arrange: HR is a leaf atom with no gutter marker (nodeSize 1 — no
        // content position for the in-block widget to ride on)
        const editor = await makeEditor("---\n\ntext");
        const v = view(editor);
        const hrPos = posOf(v, "hr");
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, hrPos)));

        // Act + Assert
        expect(openBlockMenuAtCaret(v)).toBe(false);
        expect(menu()).toBeNull();
    });

    it("a multi-block selection should open the menu for its HEAD block", async () => {
        // Arrange: forward block range over paragraph + heading — the head
        // sits at the range's end, so the heading is the head block.
        const editor = await makeEditor("Alpha\n\n## Title");
        const v = view(editor);
        const headingPos = posOf(v, "heading");
        const headingEnd = headingPos + v.state.doc.nodeAt(headingPos)!.nodeSize;
        const range = BlockRangeSelection.tryCreate(v.state.doc, 0, headingEnd);
        expect(range).not.toBeNull();
        v.dispatch(v.state.tr.setSelection(range!));

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: anchored to the heading (the head block), not the paragraph
        expect(opened).toBe(true);
        expect(openMarker()!.dataset["pill"]).toBe("H2");
    });

    it("a block-range selection whose head block is a LIST should fall back to the head-side (last) item's marker", async () => {
        // Arrange: forward block range over the whole doc — the head block is
        // the list, which carries no list-level marker (items own them); the
        // no-fallback shape made ⌘. a silent no-op here (regression).
        const editor = await makeEditor("Alpha\n\n- one\n- two");
        const v = view(editor);
        const range = BlockRangeSelection.tryCreate(v.state.doc, 0, v.state.doc.content.size);
        expect(range).not.toBeNull();
        v.dispatch(v.state.tr.setSelection(range!));

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert: anchored to the LAST item (the head side of a forward
        // selection), matching gutter unit semantics.
        expect(opened).toBe(true);
        expect(openMarker()!.closest("li")!.textContent).toBe("two");
    });

    it("a BACKWARD block-range selection headed at a list should fall back to its FIRST item's marker", async () => {
        // Arrange: backward range (anchor at the end, head at 0) — the head
        // block is the list from its start side.
        const editor = await makeEditor("- one\n- two\n\nOmega");
        const v = view(editor);
        const range = BlockRangeSelection.tryCreate(v.state.doc, v.state.doc.content.size, 0);
        expect(range).not.toBeNull();
        v.dispatch(v.state.tr.setSelection(range!));

        // Act
        const opened = openBlockMenuAtCaret(v);

        // Assert
        expect(opened).toBe(true);
        expect(openMarker()!.closest("li")!.textContent).toBe("one");
    });

    it("Escape after a keyboard open should close the menu and focus the anchor marker", async () => {
        // Arrange
        const editor = await makeEditor("Alpha paragraph");
        const v = view(editor);
        setCaret(v, 2);
        expect(openBlockMenuAtCaret(v)).toBe(true);
        const anchor = openMarker()!;

        // Act
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        // Assert: viaKeyboard mode — focus returns to the marker, not the editor
        expect(menu()).toBeNull();
        expect(document.activeElement).toBe(anchor);
    });
});
