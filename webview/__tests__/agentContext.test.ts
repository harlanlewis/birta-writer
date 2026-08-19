/**
 * buildSelectionContext (webview/agentContext.ts): mapping the live ProseMirror
 * selection into the canonical document-coordinate context the agent bridge
 * carries. The position mapping itself is covered by sourceCaret.test.ts; here
 * we pin the context shape, the frontmatter line offset, and the caret/range
 * distinction.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { CellSelection, Schema } from "../pm";
import type { EditorView, Node } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { computeLineMap } from "../../shared/lineMap";
import { buildSelectionContext } from "../agentContext";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
        text: { group: "inline" },
    },
    marks: {},
});

const p = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
const doc = (...blocks: Node[]) => schema.node("doc", null, blocks);

/** Caret `offset` chars into the `index`-th top-level block's text. */
const inBlock = (d: Node, index: number, offset: number): number => {
    let pos = 0;
    for (let i = 0; i < index; i++) { pos += d.child(i).nodeSize; }
    return pos + 1 + offset;
};

/**
 * A minimal EditorView stand-in: buildSelectionContext only reads
 * state.doc/selection.
 *
 * `ranges` is not decoration. A real `Selection` carries one range per
 * selected span and buildSelectionContext reads them to find the outer span;
 * a stand-in without them would take a fallback path no editor produces and
 * pin nothing. One range is what every selection this schema can express has,
 * and the multi-range case (a table CellSelection) is checked against a real
 * editor at the bottom of this file, because this schema has no table to
 * select cells in.
 */
const view = (d: Node, anchor: number, head: number) => {
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    return {
        state: {
            doc: d,
            selection: {
                anchor,
                head,
                from,
                to,
                empty: from === to,
                ranges: [{ $from: { pos: from }, $to: { pos: to } }],
            },
        },
    } as unknown as Parameters<typeof buildSelectionContext>[0];
};

describe("buildSelectionContext", () => {
    it("a caret mid-paragraph should produce a single empty selection at that line/column", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        const pos = inBlock(d, 1, 7);
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 0);
        expect(ctx).toEqual({
            selections: [
                {
                    anchor: { line: 3, column: 7 },
                    active: { line: 3, column: 7 },
                    text: "",
                },
            ],
            primary: 0,
            isEmpty: true,
        });
    });

    it("a forward selection should carry anchor, active and the plain selected text", () => {
        const source = "Hello world.\n";
        const d = doc(p("Hello world."));
        const anchor = inBlock(d, 0, 0);
        const head = inBlock(d, 0, 5); // "Hello"
        const ctx = buildSelectionContext(view(d, anchor, head), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.isEmpty).toBe(false);
        expect(ctx.selections[0].anchor).toEqual({ line: 1, column: 0 });
        expect(ctx.selections[0].active).toEqual({ line: 1, column: 5 });
        expect(ctx.selections[0].text).toBe("Hello");
    });

    it("a block-range selection should report its blocks' whole lines, not the next block", () => {
        // Depth-0 boundaries around block 0 — what Escape's block selection
        // produces. Mapped as carets these resolve INTO block 1 and an agent
        // would be told #L1-L3 for a one-line selection.
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        const ctx = buildSelectionContext(
            view(d, 0, d.child(0).nodeSize), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.selections[0].anchor).toEqual({ line: 1, column: 0 });
        expect(ctx.selections[0].active).toEqual({ line: 1, column: "First paragraph.".length });
        expect(ctx.selections[0].text).toBe("First paragraph.");
    });

    it("a caret in an empty paragraph below a block should name the blank line after that block, not the next block", () => {
        // Enter after "First paragraph.", then `/ai <request>` on the fresh
        // line (MAR-376): the source has no line for the empty paragraph, and
        // the generic mapping named "Second paragraph." (line 3). The writer
        // means the separator, line 2, which is where an agent inserts.
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p(""), p("Second paragraph."));
        const pos = inBlock(d, 1, 0);
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.selections[0].anchor).toEqual({ line: 2, column: 0 });
        expect(ctx.selections[0].active).toEqual({ line: 2, column: 0 });
    });

    it("a caret in an empty paragraph ending the document should name one past its last line", () => {
        const source = "First paragraph.\n";
        const d = doc(p("First paragraph."), p(""));
        const pos = inBlock(d, 1, 0);
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.selections[0].active).toEqual({ line: 2, column: 0 });
    });

    it("two empty paragraphs in a row should both name the blank line after the block above them", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p(""), p(""), p("Second paragraph."));
        const pos = inBlock(d, 2, 0);
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.selections[0].active).toEqual({ line: 2, column: 0 });
    });

    it("an empty FIRST paragraph should keep the generic mapping (there is no block before it)", () => {
        const source = "Second paragraph.\n";
        const d = doc(p(""), p("Second paragraph."));
        const pos = inBlock(d, 0, 0);
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 0)!;
        expect(ctx.selections[0].active.line).toBe(1);
    });

    it("should add the frontmatter line offset to the reported document line", () => {
        const source = "Body line.\n";
        const d = doc(p("Body line."));
        const pos = inBlock(d, 0, 0);
        // 4 frontmatter source lines precede the body.
        const ctx = buildSelectionContext(view(d, pos, pos), computeLineMap(source), source.split("\n"), 4)!;
        expect(ctx.selections[0].anchor.line).toBe(5);
    });

    it("should return null when the line map is empty (pre-first-sync)", () => {
        const d = doc(p("x"));
        expect(buildSelectionContext(view(d, 1, 1), [], [], 0)).toBeNull();
    });
});

/**
 * A table CellSelection, against a real editor, because it is the one
 * selection that holds MORE THAN ONE range and the schema above has no table
 * to make one in.
 *
 * A `Selection`'s `from`/`to` are its first range's, so reading them named a
 * single cell: a column dragged down four rows referenced one row, and the
 * quoted text was one cell's. The reference is what an agent is pointed at, so
 * the span has to be the whole of what the writer selected.
 */
describe("buildSelectionContext over a table cell selection", () => {
    let editor: Editor | null = null;

    afterEach(async () => {
        if (editor) {
            await editor.destroy();
            editor = null;
        }
    });

    // A table whose body rows sit on known source lines: `| c | d |` is line 5
    // and each later row is one line further down.
    const SOURCE = "intro\n\n| a | b |\n| --- | --- |\n| c | d |\n| e | f |\n| g | h |\n\nafter\n";

    /** The document positions of every cell, in document order. */
    async function tableCells(): Promise<{ v: EditorView; cells: number[] }> {
        const root = document.createElement("div");
        document.body.appendChild(root);
        editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, SOURCE);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .create();
        const v = editor.action((ctx) => ctx.get(editorViewCtx));
        const cells: number[] = [];
        v.state.doc.descendants((node, pos) => {
            const name = node.type.name;
            if (name === "table_cell" || name === "table_header") { cells.push(pos); }
        });
        // 4 rows of 2: the header, then c/d, e/f, g/h.
        expect(cells.length, "cells found").toBe(8);
        return { v, cells };
    }

    function contextFor(v: EditorView) {
        return buildSelectionContext(v, computeLineMap(SOURCE), SOURCE.split("\n"), 0)!;
    }

    it("a selection across one row's cells should report that row's line and both cells' text", async () => {
        // Arrange
        const { v, cells } = await tableCells();

        // Act
        v.dispatch(v.state.tr.setSelection(CellSelection.create(v.state.doc, cells[2], cells[3])));
        const ctx = contextFor(v);

        // Assert — `| c | d |` is source line 5, and the quote is the row, not
        // whichever cell happened to be range zero.
        expect(ctx.selections[0].anchor.line).toBe(5);
        expect(ctx.selections[0].active.line).toBe(5);
        expect(ctx.selections[0].text).toContain("c");
        expect(ctx.selections[0].text).toContain("d");
    });

    it("a selection down a column should span every row it covers, not just the first", async () => {
        // Arrange — the whole first column: header (line 3) down to `g` (line 7)
        const { v, cells } = await tableCells();

        // Act
        v.dispatch(v.state.tr.setSelection(CellSelection.create(v.state.doc, cells[0], cells[6])));
        const ctx = contextFor(v);

        // Assert — a four-row drag references four rows. Reading the first
        // range alone collapsed this to a single line.
        const { anchor, active } = ctx.selections[0];
        expect(Math.min(anchor.line, active.line)).toBe(3);
        expect(Math.max(anchor.line, active.line)).toBe(7);
        expect(ctx.isEmpty).toBe(false);
    });
});
