/**
 * Table column alignment (MAR-75) against a REAL editor: the command sets the
 * `alignment` attr on every cell of the targeted column (header drives the
 * serialized `:---:` markers, body cells drive rendering), re-picking the
 * current alignment clears back to the unmarked `---`, and the whole loop
 * round-trips through the production serializer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection, NodeSelection } from "@milkdown/prose/state";
import { CellSelection, cellAround } from "@milkdown/prose/tables";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { runEditorCommand } from "../editorCommands";

const TABLE = "| aa | bb |\n|---|---|\n| cc | dd |\n";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView =>
    editor.action((ctx) => ctx.get(editorViewCtx));

/** Document position just inside the first cell whose text is `text`. */
function cellPosOf(v: EditorView, text: string): number {
    let pos = -1;
    v.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && (n.text ?? "").includes(text)) { pos = p; }
    });
    if (pos < 0) { throw new Error(`cell text not found: ${text}`); }
    return pos;
}

/** The separator line (`|---|...`) of the serialized table. */
function separatorLine(editor: Editor): string {
    const line = editor.action(getMarkdown()).split("\n").find((l) => /^\|[-:| ]+\|$/.test(l));
    expect(line, "no separator line in serialized table").toBeDefined();
    return line!;
}

/** Every `alignment` attr in the given column (header row + body rows). */
function columnAlignments(v: EditorView, colIndex: number): (string | null)[] {
    const out: (string | null)[] = [];
    v.state.doc.descendants((n) => {
        // The header row's node type differs from the body rows' — match both.
        if (/^table.*row$/.test(n.type.name)) {
            const cell = n.child(colIndex);
            out.push((cell.attrs["alignment"] as string | null) ?? null);
        }
        return true;
    });
    return out;
}

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("tableAlignColumn* commands", () => {
    it("center on the first column should mark every cell and serialize :---:", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        runEditorCommand("tableAlignColumnCenter", () => editor, { cellPos: cellPosOf(v, "aa") });
        expect(separatorLine(editor)).toBe("|:---:|---|");
        // Header AND body cell both carry the attr (rendering needs the body).
        expect(columnAlignments(view(editor), 0)).toEqual(["center", "center"]);
        expect(columnAlignments(view(editor), 1)).toEqual([null, null]);
    });

    it("right via a body cell should serialize ---: for that column", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        runEditorCommand("tableAlignColumnRight", () => editor, { cellPos: cellPosOf(v, "dd") });
        expect(separatorLine(editor)).toBe("|---|---:|");
    });

    it("explicit left should serialize :--- (distinct from the unmarked default)", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        runEditorCommand("tableAlignColumnLeft", () => editor, { cellPos: cellPosOf(v, "aa") });
        expect(separatorLine(editor)).toBe("|:---|---|");
    });

    it("re-picking the current alignment should clear back to ---", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const args = { cellPos: cellPosOf(v, "aa") };
        runEditorCommand("tableAlignColumnCenter", () => editor, args);
        expect(separatorLine(editor)).toBe("|:---:|---|");
        runEditorCommand("tableAlignColumnCenter", () => editor, args);
        expect(separatorLine(editor)).toBe("|---|---|");
        expect(columnAlignments(view(editor), 0)).toEqual([null, null]);
    });

    it("switching alignments should replace, not toggle off", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const args = { cellPos: cellPosOf(v, "bb") };
        runEditorCommand("tableAlignColumnCenter", () => editor, args);
        runEditorCommand("tableAlignColumnRight", () => editor, args);
        expect(separatorLine(editor)).toBe("|---|---:|");
    });

    it("a loaded :---: column should toggle off from its parsed state", async () => {
        // The parsed attr and the command's writes must speak the same
        // vocabulary — a center column loaded from a FILE clears the same way.
        const editor = await makeEditor("| aa | bb |\n|:---:|---|\n| cc | dd |\n");
        const v = view(editor);
        runEditorCommand("tableAlignColumnCenter", () => editor, { cellPos: cellPosOf(v, "aa") });
        expect(separatorLine(editor)).toBe("|---|---|");
    });

    it("with the caret already in a cell (no cellPos) it should align that column", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cellPosOf(v, "cc") + 1)));
        runEditorCommand("tableAlignColumnCenter", () => editor);
        expect(separatorLine(editor)).toBe("|:---:|---|");
    });

    it("right-clicking inside a multi-column cell selection should align every spanned column", async () => {
        // A grip-drag column selection followed by the context menu: the
        // stamped cellPos falls INSIDE the CellSelection, which must be kept
        // (acting on the selection), not collapsed to the clicked cell.
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const $a = cellAround(v.state.doc.resolve(cellPosOf(v, "aa")))!;
        const $b = cellAround(v.state.doc.resolve(cellPosOf(v, "bb")))!;
        v.dispatch(v.state.tr.setSelection(new CellSelection($a, $b)));
        runEditorCommand("tableAlignColumnCenter", () => editor, { cellPos: cellPosOf(v, "aa") });
        expect(separatorLine(editor)).toBe("|:---:|:---:|");
    });

    it("a cellPos OUTSIDE the current cell selection should re-target that cell", async () => {
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const $a = cellAround(v.state.doc.resolve(cellPosOf(v, "aa")))!;
        v.dispatch(v.state.tr.setSelection(new CellSelection($a)));
        // Right-click lands in the OTHER column: only that column aligns.
        runEditorCommand("tableAlignColumnRight", () => editor, { cellPos: cellPosOf(v, "dd") });
        expect(separatorLine(editor)).toBe("|---|---:|");
    });

    it("inserting a column should NOT write an alignment marker (null default)", async () => {
        // Regression: preset-gfm defaults cells to alignment "left", so an
        // inserted column silently serialized an explicit `:---` marker the
        // user never chose. tableAlignDefault nulls the default.
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cellPosOf(v, "aa") + 1)));
        runEditorCommand("tableInsertColumnRight", () => editor);
        expect(separatorLine(editor)).toBe("|---|---|---|");
    });

    it("a column inserted next to an aligned column keeps that column's markers", async () => {
        const editor = await makeEditor("| aa | bb |\n|:---:|---|\n| cc | dd |\n");
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cellPosOf(v, "aa") + 1)));
        runEditorCommand("tableInsertColumnRight", () => editor);
        expect(separatorLine(editor)).toBe("|:---:|---|---|");
    });

    it("outside any table it should be a safe no-op", async () => {
        const editor = await makeEditor("just a paragraph\n");
        const before = editor.action(getMarkdown());
        expect(() => runEditorCommand("tableAlignColumnCenter", () => editor)).not.toThrow();
        expect(editor.action(getMarkdown())).toBe(before);
    });

    it("a NodeSelection outside a table (e.g. an hr) should be a safe no-op", async () => {
        const editor = await makeEditor("above\n\n---\n\nbelow\n");
        const v = view(editor);
        let pos = -1;
        v.state.doc.descendants((n, p) => {
            if (pos < 0 && (n.type.name === "hr" || n.type.name === "horizontal_rule")) { pos = p; }
        });
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, pos)));
        const before = editor.action(getMarkdown());
        expect(() => runEditorCommand("tableAlignColumnRight", () => editor)).not.toThrow();
        expect(editor.action(getMarkdown())).toBe(before);
    });
});
