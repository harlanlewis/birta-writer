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

    // A long loose list drifts everything after it by (items − 1) — here 7,
    // one past the old fixed reconciliation span, which silently returned the
    // nominal (wrong) pairing. The search must reach the whole map.
    const items = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    const longSource = `${items.map((t) => `- ${t}`).join("\n\n")}\n\nAfter the list.\n`;
    const longDoc = () => doc(list(...items), p("After the list."));

    it("a block drifted past the old fixed span should still report its real line", () => {
        const d = longDoc();
        expect(sourceLineForBlock(d, computeLineMap(longSource), longSource.split("\n"), 1)).toBe(17);
    });

    it("a caret drifted past the old fixed span should still report its real line", () => {
        const d = longDoc();
        const pos = inBlock(d, 1, 6);
        expect(sourceCaretAt(d, computeLineMap(longSource), longSource.split("\n"), pos))
            .toEqual({ line: 17, column: 6 });
    });

    // Inside a loose list the anchors are NOT contiguous from the block's
    // first line — items sit blank lines apart — so each anchor's line must be
    // resolved against the source, not assumed as blockLine + index.

    /** Doc position `offset` chars into the textblock whose text is `blockText`. */
    const posIn = (d: ReturnType<typeof doc>, blockText: string, offset: number): number => {
        let found = -1;
        d.descendants((node, pos) => {
            if (found >= 0) { return false; }
            if (node.isTextblock && node.textContent === blockText) {
                found = pos + 1 + offset;
                return false;
            }
            return true;
        });
        if (found < 0) { throw new Error(`no textblock "${blockText}"`); }
        return found;
    };

    it("a caret in a loose list item should report the item's own line, not a contiguous guess", () => {
        const d = doc(list("alpha", "beta"), p("After the list."));
        const source = "- alpha\n\n- beta\n\nAfter the list.\n";
        // Caret 2 chars into "beta": the item lives on source line 3 (line 2 is
        // the blank between the loose items), and its column includes the bullet.
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), posIn(d, "beta", 2)))
            .toEqual({ line: 3, column: 4 });
    });

    it("a caret in a nested sub-item separated by a blank line should report its real line", () => {
        const item = schema.node("list_item", null, [p("item head:"), list("sub a", "sub b")]);
        const d = doc(schema.node("bullet_list", null, [item]), p("Tail."));
        const source = "- item head:\n\n  - sub a\n  - sub b\n\nTail.\n";
        // Caret at the start of "sub b" — the fourth source line, behind its
        // "  - " marker.
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), posIn(d, "sub b", 0)))
            .toEqual({ line: 4, column: 4 });
    });

    it("a caret in a loose list item should survive the round trip", () => {
        const d = doc(list("alpha", "beta"), p("After the list."));
        const source = "- alpha\n\n- beta\n\nAfter the list.\n";
        const lineMap = computeLineMap(source);
        const lines = source.split("\n");
        const pos = posIn(d, "beta", 2);
        const caret = sourceCaretAt(d, lineMap, lines, pos);
        expect(docPosForSourceCaret(d, lineMap, lines, caret!)).toBe(pos);
    });

    it("a source line with a trailing space should still verify its block", () => {
        // The invisible trailing space used to fail the exact suffix match and
        // derail reconciliation for the whole neighbourhood.
        const source = "- alpha\n\n- beta\n\nGamma delta. \n";
        const d = doc(list("alpha", "beta"), p("Gamma delta. "));
        expect(sourceLineForBlock(d, computeLineMap(source), source.split("\n"), 1)).toBe(5);
    });

    it("a block whose first line carries inline markup should still verify by its words", () => {
        // Rendered text drops a link's URL and emphasis asterisks, so the exact
        // suffix can never match — the normalized letters+digits prefix must.
        const source =
            "- one\n\n- two\n\n- three\n\n- four\n\n" +
            "- Data fidelity: see [FOAM](https://example.com) and *tolerance* rules.\n" +
            '- As Teller put it, *"magic is more time than expected."* Powerful.\n';
        const d = doc(
            list("one", "two", "three", "four"),
            list(
                "Data fidelity: see FOAM and tolerance rules.",
                'As Teller put it, "magic is more time than expected." Powerful.',
            ),
        );
        // The marked-up tight list starts at source line 9…
        expect(sourceLineForBlock(d, computeLineMap(source), source.split("\n"), 1)).toBe(9);
        // …and a caret in its second item reports line 10 (column degrades to
        // 0 as documented — the rendered text is not a suffix of the source).
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), posIn(d, 'As Teller put it, "magic is more time than expected." Powerful.', 3)))
            .toEqual({ line: 10, column: 0 });
    });

    it("a line drifted past the old fixed span should still resolve to its real block", () => {
        // Enough paragraphs after the list that the nominal child index is a
        // real (but wrong) node, so only the search — not the childCount clamp
        // — can rescue it.
        const paras = ["p one", "p two", "p three", "p four", "p five", "p six", "p seven", "p eight", "p nine", "p ten"];
        const source = `${items.map((t) => `- ${t}`).join("\n\n")}\n\n${paras.join("\n\n")}\n`;
        const d = doc(list(...items), ...paras.map((t) => p(t)));
        // "p one" starts at source line 17; its node is child 1, but the
        // nominal pairing says child 8.
        expect(blockIndexForSourceLine(d, computeLineMap(source), source.split("\n"), 17))
            .toEqual({ index: 1, blockLine: 17 });
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
