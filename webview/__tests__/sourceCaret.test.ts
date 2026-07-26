/**
 * sourceCaret: the caret exchange behind a mode switch (MAR-23).
 *
 * Both directions are checked against the same hand-built documents, because
 * the property that matters is the ROUND TRIP — a caret handed to the raw
 * editor and back must not drift. The column rule is deliberately narrow, so
 * the degrade-to-column-0 cases are asserted just as explicitly as the hits.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { computeLineMap } from "../../shared/lineMap";
import {
    sourceCaretAt,
    docPosForSourceCaret,
    blockIndexForSourceLine,
    sourceLineForBlock,
} from "../utils/sourceCaret";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
        code_block: { group: "block", content: "text*", code: true, marks: "" },
        blockquote: { group: "block", content: "block+" },
        bullet_list: { group: "block", content: "list_item+" },
        list_item: { content: "paragraph block*" },
        image: { group: "inline", inline: true, attrs: { src: {} } },
        text: { group: "inline" },
    },
    marks: {
        strong: {},
    },
});

const text = (t: string) => (t ? [schema.text(t)] : []);
const p = (t: string) => schema.node("paragraph", null, text(t));
const h = (level: number, t: string) => schema.node("heading", { level }, text(t));
const code = (t: string) => schema.node("code_block", null, text(t));
const li = (t: string) => schema.node("list_item", null, [p(t)]);
const list = (...items: string[]) => schema.node("bullet_list", null, items.map(li));
const quote = (t: string) => schema.node("blockquote", null, [p(t)]);
const doc = (...blocks: ReturnType<typeof p>[]) => schema.node("doc", null, blocks);

/** Position of the caret `column` characters into the `index`-th block's text. */
const inBlock = (d: ReturnType<typeof doc>, index: number, offset: number): number => {
    let pos = 0;
    for (let i = 0; i < index; i++) { pos += d.child(i).nodeSize; }
    return pos + 1 + offset;
};

describe("sourceCaretAt", () => {
    it("a caret mid-paragraph should report that paragraph's line and column", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 1, 7));
        expect(caret).toEqual({ line: 3, column: 7 });
    });

    it("a caret in a heading should account for the source-only '# ' marker", () => {
        const source = "## Title\n\nbody\n";
        const d = doc(h(2, "Title"), p("body"));
        // Caret after "Ti" in the rendered heading → after "## Ti" in source.
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, 2));
        expect(caret).toEqual({ line: 1, column: 5 });
    });

    it("a caret in a list item should report that item's own line", () => {
        const source = "- alpha\n- beta\n- gamma\n";
        const d = doc(list("alpha", "beta", "gamma"));
        // Third item's paragraph: bullet_list(1) + item(1) + paragraph(1) offsets.
        const gamma = 0 + 1 + 1 + 1 + li("alpha").nodeSize + li("beta").nodeSize;
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), gamma + 3);
        expect(caret).toEqual({ line: 3, column: 5 });
    });

    it("a caret inside a fenced code block should count the fence line and the code's own newlines", () => {
        const source = "```js\nconst a = 1;\nconst b = 2;\n```\n";
        const d = doc(code("const a = 1;\nconst b = 2;"));
        // Start of the second code line.
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, "const a = 1;\n".length));
        expect(caret).toEqual({ line: 3, column: 0 });
    });

    it("a caret in a blockquote should keep the '> ' marker in the column", () => {
        const source = "> quoted text\n";
        const d = doc(quote("quoted text"));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, 0) + 1 + 3);
        expect(caret).toEqual({ line: 1, column: 5 });
    });

    it("a line whose markup is inline should keep the line but drop to column 0", () => {
        // The source carries **…**; the rendered text does not, so no column can
        // be claimed without guessing a position inside invisible markup.
        const source = "a **bold** word\n";
        const d = doc(schema.node("paragraph", null, [
            schema.text("a "),
            schema.text("bold", [schema.mark("strong")]),
            schema.text(" word"),
        ]));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, 8));
        expect(caret).toEqual({ line: 1, column: 0 });
    });

    it("a soft-wrapped paragraph should report the line it starts on", () => {
        const source = "one two\nthree four\n";
        const d = doc(p("one two three four"));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, 12));
        expect(caret?.line).toBe(1);
    });

    it("an empty line map should report no caret", () => {
        const d = doc(p("text"));
        expect(sourceCaretAt(d, [], ["text"], 1)).toBeUndefined();
    });

    it("a position past the end of the document should clamp to the last block", () => {
        const source = "one\n\ntwo\n";
        const d = doc(p("one"), p("two"));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), 9999);
        expect(caret).toEqual({ line: 3, column: 3 });
    });
});

describe("docPosForSourceCaret", () => {
    it("a paragraph column should map back to the same document position", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        const pos = docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), { line: 3, column: 7 });
        expect(pos).toBe(inBlock(d, 1, 7));
    });

    it("a column inside a heading's marker should clamp to the start of its text", () => {
        const source = "## Title\n";
        const d = doc(h(2, "Title"));
        // Column 1 sits between the two hashes — before any rendered text.
        expect(docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), { line: 1, column: 1 }))
            .toBe(inBlock(d, 0, 0));
    });

    it("a code line and column should map into the code block's text", () => {
        const source = "```js\nconst a = 1;\nconst b = 2;\n```\n";
        const d = doc(code("const a = 1;\nconst b = 2;"));
        const pos = docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), { line: 3, column: 6 });
        expect(pos).toBe(inBlock(d, 0, "const a = 1;\n".length + 6));
    });

    it("the fence line itself should map to the start of the code", () => {
        const source = "```js\ncode\n```\n";
        const d = doc(code("code"));
        expect(docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), { line: 1, column: 3 }))
            .toBe(inBlock(d, 0, 0));
    });

    it("a caret after an inline image should land after it in the document", () => {
        // The rendered text is a suffix of the source line, so the column still
        // maps — the image node itself carries no text to count.
        const source = "![a](b.png) tail\n";
        const d = doc(schema.node("paragraph", null, [
            schema.node("image", { src: "b.png" }),
            schema.text(" tail"),
        ]));
        const pos = docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), { line: 1, column: 16 });
        // paragraph start (0) + 1 + image (1) + " tail" (5)
        expect(pos).toBe(7);
    });

    it("a line past the map should clamp inside the last block rather than fail", () => {
        const source = "one\n\ntwo\n";
        const d = doc(p("one"), p("two"));
        const pos = docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), { line: 99, column: 0 });
        expect(pos).toBe(inBlock(d, 1, 0));
    });

    it("an empty line map should report no position", () => {
        const d = doc(p("text"));
        expect(docPosForSourceCaret(d, [], ["text"], { line: 1, column: 0 })).toBeUndefined();
    });
});

describe("reconciling the line map against the document", () => {
    // A loose list is several source blocks but ONE document node, so from the
    // list onward the nominal entry-per-child pairing is wrong — and silently
    // so, which is what makes it worth verifying rather than trusting.
    const looseSource = "- alpha\n\n- beta\n\nAfter the list.\n";
    const looseDoc = () => doc(list("alpha", "beta"), p("After the list."));

    it("the nominal pairing should be used when it holds", () => {
        const source = "one\n\ntwo\n\nthree\n";
        const d = doc(p("one"), p("two"), p("three"));
        expect(blockIndexForSourceLine(d, computeLineMap(source), source.split("\n"), 5))
            .toEqual({ index: 2, blockLine: 5 });
    });

    it("a line after a loose list should resolve to the block that really holds it", () => {
        const d = looseDoc();
        // lineMap is [1, 3, 5]; entry 2 nominally means doc.child(2), which
        // doesn't exist — the paragraph is child 1.
        expect(blockIndexForSourceLine(d, computeLineMap(looseSource), looseSource.split("\n"), 5))
            .toEqual({ index: 1, blockLine: 5 });
    });

    it("a block after a loose list should report the line it really starts on", () => {
        const d = looseDoc();
        expect(sourceLineForBlock(d, computeLineMap(looseSource), looseSource.split("\n"), 1)).toBe(5);
    });

    it("a caret after a loose list should not drift onto the list's own line", () => {
        const d = looseDoc();
        const pos = inBlock(d, 1, 6);
        expect(sourceCaretAt(d, computeLineMap(looseSource), looseSource.split("\n"), pos))
            .toEqual({ line: 5, column: 6 });
    });

    it("a caret after a loose list should survive the round trip", () => {
        const d = looseDoc();
        const lineMap = computeLineMap(looseSource);
        const lines = looseSource.split("\n");
        const pos = inBlock(d, 1, 6);
        const caret = sourceCaretAt(d, lineMap, lines, pos);
        expect(docPosForSourceCaret(d, lineMap, lines, caret!)).toBe(pos);
    });

    it("a document the map cannot be reconciled with should keep the nominal answer", () => {
        // Nothing in this document matches the map, so there is no better
        // answer to find — it must degrade, not wander.
        const source = "alpha\n\nbeta\n";
        const d = doc(p("wholly"), p("different"));
        const block = blockIndexForSourceLine(d, computeLineMap(source), source.split("\n"), 3);
        expect(block).toEqual({ index: 1, blockLine: 3 });
    });
});

describe("round trip", () => {
    const cases: Array<[string, () => ReturnType<typeof doc>, string, number]> = [
        ["paragraph", () => doc(p("hello world")), "hello world\n", 6],
        ["heading", () => doc(h(3, "Some title")), "### Some title\n", 5],
        ["list item", () => doc(list("alpha", "beta")), "- alpha\n- beta\n", 3],
        ["code block", () => doc(code("let x = 1;\nlet y = 2;")), "```\nlet x = 1;\nlet y = 2;\n```\n", 15],
    ];

    for (const [name, build, source, pos] of cases) {
        it(`a caret in a ${name} should survive doc → source → doc`, () => {
            const d = build();
            const lineMap = computeLineMap(source);
            const lines = source.split("\n");
            const caret = sourceCaretAt(d, lineMap, lines, pos);
            expect(caret).toBeDefined();
            expect(docPosForSourceCaret(d, lineMap, lines, caret!)).toBe(pos);
        });
    }
});
