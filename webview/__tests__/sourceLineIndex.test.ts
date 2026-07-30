/**
 * sourceLineIndex: the line-number gutter's index.
 *
 * The property under test is not "does line 7 exist" but **which source lines
 * can be MEASURED and which can only be interpolated** — that split is the
 * whole reason a line-number gutter over a rendered document is hard. So every
 * case asserts the `pos === null` shape alongside the numbers, and several
 * assert the sequence is gap-free and strictly increasing, which is what stops
 * the gutter from silently skipping or double-claiming a line.
 *
 * Documents are hand-built (the sourceCaret.test.ts harness) so the source text
 * and the node tree can be stated independently — exactly where the drift these
 * functions exist to absorb comes from.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { computeLineMap } from "../../shared/lineMap";
import { sourceLineIndex, type SourceLineEntry } from "../utils/sourceCaret";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
        code_block: { group: "block", content: "text*", code: true, marks: "" },
        blockquote: { group: "block", content: "block+" },
        bullet_list: { group: "block", content: "list_item+" },
        list_item: { content: "paragraph block*" },
        horizontal_rule: { group: "block" },
        callout: { group: "block", content: "block+", markerLines: { closer: false } },
        container_directive: { group: "block", content: "block+", markerLines: { closer: true } },
        table: { group: "block", content: "table_row+" },
        table_row: { content: "table_cell+", tableRole: "row" },
        table_cell: { content: "paragraph+" },
        hardbreak: { group: "inline", inline: true },
        text: { group: "inline" },
    },
    marks: {},
});

type Block = ReturnType<Schema["node"]>;

const text = (t: string) => (t ? [schema.text(t)] : []);
const p = (t: string) => schema.node("paragraph", null, text(t));
const h = (level: number, t: string) => schema.node("heading", { level }, text(t));
const code = (t: string) => schema.node("code_block", null, text(t));
const li = (...blocks: Block[]) => schema.node("list_item", null, blocks);
const list = (...items: Block[]) => schema.node("bullet_list", null, items);
const quote = (...blocks: Block[]) => schema.node("blockquote", null, blocks);
const hr = () => schema.node("horizontal_rule");
const cell = (t: string) => schema.node("table_cell", null, [p(t)]);
const row = (...cells: string[]) => schema.node("table_row", null, cells.map(cell));
const table = (...rows: Block[]) => schema.node("table", null, rows);
const directive = (...blocks: Block[]) => schema.node("container_directive", null, blocks);
const doc = (...blocks: Block[]) => schema.node("doc", null, blocks);

/** A paragraph whose author newlines survive as break leaves. */
const wrapped = (...segments: string[]) => {
    const inline: ReturnType<typeof schema.text>[] = [];
    segments.forEach((seg, i) => {
        if (i > 0) { inline.push(schema.node("hardbreak")); }
        if (seg) { inline.push(schema.text(seg)); }
    });
    return schema.node("paragraph", null, inline);
};

/** Run the index over the whole document. */
const index = (source: string, d: Block): SourceLineEntry[] =>
    sourceLineIndex(d, computeLineMap(source), source.split("\n"), 0, d.childCount - 1);

/** Compact view: `12` for a measured line, `12?` for an interpolated one. */
const shape = (entries: SourceLineEntry[]): string[] =>
    entries.map((e) => `${e.line}${e.pos === null ? "?" : ""}${e.bottom ? "^" : ""}`);

const measuredLines = (entries: SourceLineEntry[]): number[] =>
    entries.filter((e) => e.pos !== null).map((e) => e.line);

describe("sourceLineIndex — the measurable/interpolated split", () => {
    it("two paragraphs should measure both and interpolate the blank between them", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        expect(shape(index(source, d))).toEqual(["1", "2?", "3", "4?"]);
    });

    it("a heading followed by prose should measure both lines", () => {
        const source = "## Title\n\nbody text\n";
        const d = doc(h(2, "Title"), p("body text"));
        expect(measuredLines(index(source, d))).toEqual([1, 3]);
    });

    it("a tight list should measure every item's own line", () => {
        const source = "- alpha\n- beta\n- gamma\n";
        const d = doc(list(li(p("alpha")), li(p("beta")), li(p("gamma"))));
        expect(shape(index(source, d))).toEqual(["1", "2", "3", "4?"]);
    });

    it("a LOOSE list should measure each item and interpolate the blank lines between", () => {
        // One node, three items, blank lines between them: the case where
        // `blockLine + i` drifts and the forward match has to rescue it.
        const source = "- alpha\n\n- beta\n\n- gamma\n";
        const d = doc(list(li(p("alpha")), li(p("beta")), li(p("gamma"))));
        expect(shape(index(source, d))).toEqual(["1", "2?", "3", "4?", "5", "6?"]);
    });

    it("a paragraph carrying author newlines should measure one line per segment", () => {
        const source = "one line\ntwo line\nthree line\n";
        const d = doc(wrapped("one line", "two line", "three line"));
        expect(measuredLines(index(source, d))).toEqual([1, 2, 3]);
    });

    it("a long soft-wrapping paragraph should claim ONE line, not one per visual row", () => {
        // A single source line that the renderer wraps: the gutter must number
        // it once. (Visual rows are the renderer's business; the source has one
        // line, so the index has one entry.)
        const source = `${"word ".repeat(80).trim()}\n`;
        const d = doc(p("word ".repeat(80).trim()));
        expect(measuredLines(index(source, d))).toEqual([1]);
    });

    it("a table should measure one line per ROW and interpolate the delimiter row", () => {
        const source = "| a | b |\n| --- | --- |\n| c | d |\n";
        const d = doc(table(row("a", "b"), row("c", "d")));
        // Row 1 → line 1, the `| --- |` delimiter renders nothing → line 2
        // interpolated, row 2 → line 3.
        expect(shape(index(source, d))).toEqual(["1", "2?", "3", "4?"]);
    });

    it("a blockquote's body should measure the line its `> ` marker shares", () => {
        const source = "> quoted text\n";
        const d = doc(quote(p("quoted text")));
        expect(measuredLines(index(source, d))).toEqual([1]);
    });

    it("a horizontal rule should still be numbered even though it has no text", () => {
        const source = "before\n\n---\n\nafter\n";
        const d = doc(p("before"), hr(), p("after"));
        expect(measuredLines(index(source, d))).toEqual([1, 3, 5]);
    });
});

describe("sourceLineIndex — code blocks are fence-only", () => {
    it("a fenced code block should number both fences and NOT its interior", () => {
        const source = "```js\nconst a = 1\nconst b = 2\n```\n";
        const d = doc(code("const a = 1\nconst b = 2"));
        // 2 and 3 are on screen — numbered by the block's own gutter — so they
        // are absent entirely, not interpolated back in as blanks.
        expect(shape(index(source, d))).toEqual(["1", "4^", "5?"]);
    });

    it("the closing fence should measure the code box's BOTTOM edge", () => {
        const source = "```\nx\n```\n";
        const d = doc(code("x"));
        const entries = index(source, d);
        const closer = entries.find((e) => e.line === 3);
        expect(closer).toMatchObject({ pos: 0, bottom: true });
        // ...and the opener the same box's top.
        const opener = entries.find((e) => e.line === 1);
        expect(opener?.pos).toBe(0);
        expect(opener?.bottom).toBeUndefined();
    });

    it("a code block with no closing fence should number only its opener", () => {
        // An unterminated fence at end of file: nothing closes it, so nothing
        // may be claimed for a line that does not exist.
        const source = "```js\nconst a = 1";
        const d = doc(code("const a = 1"));
        expect(shape(index(source, d))).toEqual(["1"]);
    });

    it("prose around a code block should keep its own lines measured", () => {
        const source = "intro\n\n```\nx\ny\n```\n\noutro\n";
        const d = doc(p("intro"), code("x\ny"), p("outro"));
        expect(shape(index(source, d))).toEqual(["1", "2?", "3", "6^", "7?", "8", "9?"]);
    });
});

describe("sourceLineIndex — marker-line containers", () => {
    it("a container directive should number its opener at the top and closer at the bottom", () => {
        const source = ":::note\nbody text\n:::\n";
        const d = doc(directive(p("body text")));
        const entries = index(source, d);
        expect(shape(entries)).toEqual(["1", "2", "3^", "4?"]);
        expect(entries[0].bottom).toBeUndefined();
    });

    it("a callout with no closer line should number its opener and body only", () => {
        const source = "> [!NOTE]\n> body text\n";
        const d = doc(schema.node("callout", null, [p("body text")]));
        expect(shape(index(source, d))).toEqual(["1", "2", "3?"]);
    });
});

describe("sourceLineIndex — the sequence contract", () => {
    const kitchenSink = {
        source: [
            "# Title",
            "",
            "Intro paragraph.",
            "",
            "- alpha",
            "",
            "- beta",
            "",
            "```js",
            "const a = 1",
            "```",
            "",
            "| a | b |",
            "| --- | --- |",
            "| c | d |",
            "",
            "Closing words.",
            "",
        ].join("\n"),
        doc: doc(
            h(1, "Title"),
            p("Intro paragraph."),
            list(li(p("alpha")), li(p("beta"))),
            code("const a = 1"),
            table(row("a", "b"), row("c", "d")),
            p("Closing words."),
        ),
    };

    it("every line should be strictly increasing with no repeats", () => {
        const lines = index(kitchenSink.source, kitchenSink.doc).map((e) => e.line);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
        expect(new Set(lines).size).toBe(lines.length);
    });

    it("the sequence should cover every source line except a code block's interior", () => {
        const entries = index(kitchenSink.source, kitchenSink.doc);
        const total = kitchenSink.source.split("\n").length;
        const covered = new Set(entries.map((e) => e.line));
        const missing = Array.from({ length: total }, (_, i) => i + 1).filter((l) => !covered.has(l));
        // Line 10 is `const a = 1` — the code block's own gutter numbers it.
        expect(missing).toEqual([10]);
    });

    it("a windowed range should not renumber from line 1", () => {
        // The gutter only ever asks for the blocks near the viewport; a window
        // starting at block 4 must report ITS lines, not the document's first.
        const entries = sourceLineIndex(
            kitchenSink.doc,
            computeLineMap(kitchenSink.source),
            kitchenSink.source.split("\n"),
            4,
            5,
        );
        expect(entries[0].line).toBe(13);
        expect(measuredLines(entries)).toEqual([13, 15, 17]);
    });

    it("each entry should name the top-level block it belongs to", () => {
        const entries = index(kitchenSink.source, kitchenSink.doc);
        expect(entries.find((e) => e.line === 1)?.blockIndex).toBe(0);
        expect(entries.find((e) => e.line === 3)?.blockIndex).toBe(1);
        expect(entries.find((e) => e.line === 17)?.blockIndex).toBe(5);
    });
});

describe("sourceLineIndex — degrading honestly", () => {
    it("an empty line map should yield nothing rather than guess", () => {
        const d = doc(p("text"));
        expect(sourceLineIndex(d, [], ["text"], 0, 0)).toEqual([]);
    });

    it("a block whose text matches nothing in the source should be left unnumbered", () => {
        // The document and the source disagree entirely (a stale source, which
        // is exactly what a mid-typing-burst refresh looks like). The paragraph
        // that DOES match keeps its number; the one that doesn't gets none of
        // its own — a wrong number is worse than a missing one.
        const source = "Alpha paragraph here.\n\nBeta paragraph here.\n";
        const d = doc(
            p("Alpha paragraph here."),
            p("Something else entirely, matching no source line at all."),
        );
        const entries = index(source, d);
        expect(measuredLines(entries)).toEqual([1]);
        // The unnumbered block's lines are still SEQUENCED (interpolated), so
        // the reader never sees the sequence jump.
        expect(entries.every((e) => e.line >= 1)).toBe(true);
    });

    it("a range outside the document should be clamped, not throw", () => {
        const source = "only line\n";
        const d = doc(p("only line"));
        expect(() => sourceLineIndex(d, computeLineMap(source), source.split("\n"), -5, 99)).not.toThrow();
        expect(measuredLines(sourceLineIndex(d, computeLineMap(source), source.split("\n"), -5, 99))).toEqual([1]);
    });
});
