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
    sourceEndOfBlock,
    sourceSelectionEnds,
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
        horizontal_rule: { group: "block" },
        callout: { group: "block", content: "block+" },
        container_directive: { group: "block", content: "block+" },
        notion_callout: { group: "block", content: "block+" },
        hardbreak: { group: "inline", inline: true },
        math_inline: { group: "inline", inline: true, content: "text*" },
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

    it("a line with inline markup should align the column past the invisible markup", () => {
        // The source carries **…** the rendered text doesn't; the rendered text
        // is aligned to the source as a subsequence, so a caret 8 chars in
        // (before the 'o' of "word") maps to source column 12 — past both
        // closing asterisks.
        const source = "a **bold** word\n";
        const d = doc(schema.node("paragraph", null, [
            schema.text("a "),
            schema.text("bold", [schema.mark("strong")]),
            schema.text(" word"),
        ]));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, 8));
        expect(caret).toEqual({ line: 1, column: 12 });
    });

    it("a rendered text that cannot embed in the source line should degrade to column 0", () => {
        // Rendered text that is NOT a subsequence of the source line (the
        // renderer substituted content, e.g. an image's alt text) claims no
        // column rather than guessing.
        const source = "zzz\n";
        const d = doc(p("abc"));
        const caret = sourceCaretAt(d, computeLineMap(source), source.split("\n"), inBlock(d, 0, 2));
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
        // …and a caret 3 chars into its second item reports line 10 with the
        // column aligned through the "- " marker (rendered offset 3 = before
        // the 'T' of Teller = source column 5).
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), posIn(d, 'As Teller put it, "magic is more time than expected." Powerful.', 3)))
            .toEqual({ line: 10, column: 5 });
    });

    it("a no-text block must not swallow a drifted line (the arriving caret would vanish)", () => {
        // The field failure behind "scrolls but no caret": drift pushed a
        // line's nominal pairing onto a horizontal rule, whose empty anchors
        // were accepted on trust — and an hr has no text position, so the
        // caret arrival then had nowhere to land. Evidence must outrank trust.
        const items = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
        const paras = Array.from({ length: 16 }, (_, i) => `Para number ${i + 1} here.`);
        const source =
            `${items.map((t) => `- ${t}`).join("\n\n")}\n\n${paras.join("\n\n")}\n\n---\n\n---\n\n---\n`;
        const hr = () => schema.node("horizontal_rule");
        const d = doc(list(...items), ...paras.map((t) => p(t)), hr(), hr(), hr());
        const lineMap = computeLineMap(source);
        const lines = source.split("\n");
        // "Para number 10 here." starts at source line 35; its entry index is
        // 17, which nominally pairs with child 17 — the first hr.
        const target = lines.findIndex((l) => l === "Para number 10 here.") + 1;
        expect(blockIndexForSourceLine(d, lineMap, lines, target)?.index).toBe(10);
        const pos = docPosForSourceCaret(d, lineMap, lines, { line: target, column: 3 });
        expect(pos).toBeDefined();
        expect(sourceCaretAt(d, lineMap, lines, pos!)).toEqual({ line: target, column: 3 });
    });

    it("a caret inside inline markup should survive the round trip", () => {
        // Through the subsequence alignment: rendered offset → source column →
        // back to the same document position.
        const source = "a **bold** word\n";
        const d = doc(schema.node("paragraph", null, [
            schema.text("a "),
            schema.text("bold", [schema.mark("strong")]),
            schema.text(" word"),
        ]));
        const lineMap = computeLineMap(source);
        const lines = source.split("\n");
        const pos = inBlock(d, 0, 8);
        const caret = sourceCaretAt(d, lineMap, lines, pos);
        expect(caret).toEqual({ line: 1, column: 12 });
        expect(docPosForSourceCaret(d, lineMap, lines, caret!)).toBe(pos);
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

describe("sourceEndOfBlock", () => {
    it("a paragraph should end at its own line's last column", () => {
        const source = "First paragraph.\n\nSecond paragraph.\n";
        const d = doc(p("First paragraph."), p("Second paragraph."));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 1, column: "First paragraph.".length });
    });

    it("a tight list should end at its LAST item's line", () => {
        const source = "- alpha\n- beta\n\nafter\n";
        const d = doc(list("alpha", "beta"), p("after"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 2, column: "- beta".length });
    });

    it("a loose list should end at its last item's RESOLVED line, past the gaps", () => {
        const source = "- one\n\n- two\n\n- three tail words\n\nafter\n";
        const d = doc(list("one", "two", "three tail words"), p("after"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 5, column: "- three tail words".length });
    });

    it("a fenced code block should include its closing fence line", () => {
        const source = "```js\nlet x = 1;\nlet y = 2;\n```\n\nafter\n";
        const d = doc(code("let x = 1;\nlet y = 2;"), p("after"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 4, column: 3 });
    });

    it("a fence inside a blockquote should include its '> '-marked closing line", () => {
        const source = "> ```js\n> let x = 1;\n> ```\n\nafter\n";
        const d = doc(schema.node("blockquote", null, [code("let x = 1;")]), p("after"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 3, column: "> ```".length });
    });

    it("a heading directly above another block should not swallow the blank separator", () => {
        const source = "## Title\n\nbody\n";
        const d = doc(h(2, "Title"), p("body"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 1, column: "## Title".length });
    });
});

describe("sourceSelectionEnds", () => {
    const source = "First paragraph.\n\n- alpha\n- beta\n\nlast\n";
    const build = () => doc(p("First paragraph."), list("alpha", "beta"), p("last"));

    it("a text selection should map both ends as carets, drag roles preserved", () => {
        const d = build();
        const ends = sourceSelectionEnds(d, computeLineMap(source), source.split("\n"), {
            from: inBlock(d, 0, 2), to: inBlock(d, 0, 8),
            anchor: inBlock(d, 0, 8), head: inBlock(d, 0, 2), empty: false,
        });
        expect(ends).toEqual({
            head: { line: 1, column: 2 },
            anchor: { line: 1, column: 8 },
        });
    });

    it("a block-boundary selection should cover its blocks' whole source lines", () => {
        // Blocks 0..1 selected as a block range: depth-0 boundaries.
        const d = build();
        const to = d.child(0).nodeSize + d.child(1).nodeSize;
        const ends = sourceSelectionEnds(d, computeLineMap(source), source.split("\n"), {
            from: 0, to, anchor: 0, head: to, empty: false,
        });
        expect(ends).toEqual({
            anchor: { line: 1, column: 0 },
            head: { line: 4, column: "- beta".length },
        });
    });

    it("a BACKWARD block-boundary selection should keep the head at the top", () => {
        const d = build();
        const to = d.child(0).nodeSize + d.child(1).nodeSize;
        const ends = sourceSelectionEnds(d, computeLineMap(source), source.split("\n"), {
            from: 0, to, anchor: to, head: 0, empty: false,
        });
        expect(ends).toEqual({
            head: { line: 1, column: 0 },
            anchor: { line: 4, column: "- beta".length },
        });
    });

    it("an empty selection should report its caret as both ends", () => {
        const d = build();
        const pos = inBlock(d, 0, 5);
        const ends = sourceSelectionEnds(d, computeLineMap(source), source.split("\n"), {
            from: pos, to: pos, anchor: pos, head: pos, empty: true,
        });
        expect(ends).toEqual({
            anchor: { line: 1, column: 5 },
            head: { line: 1, column: 5 },
        });
    });

    it("an empty line map should map to undefined, not a guess", () => {
        const d = build();
        expect(sourceSelectionEnds(d, [], source.split("\n"), {
            from: 0, to: 2, anchor: 0, head: 2, empty: false,
        })).toBeUndefined();
    });
});

describe("wrapped paragraphs (source newlines as break leaves)", () => {
    // One paragraph over three source lines: the author's newlines live in the
    // document as hardbreak leaves — the failure mode where every caret and
    // selection in a wrapped paragraph collapsed to line start, column 0.
    const source = "Wrapped first line\ncontinues **bold** here\nand ends.\n";
    const wrapped = () =>
        doc(schema.node("paragraph", null, [
            schema.text("Wrapped first line"),
            schema.node("hardbreak"),
            schema.text("continues "),
            schema.text("bold", [schema.mark("strong")]),
            schema.text(" here"),
            schema.node("hardbreak"),
            schema.text("and ends."),
        ]));
    // Content offsets: "Wrapped first line" 0–18, break 18–19, "continues "
    // 19–29, "bold" 29–33, " here" 33–38, break 38–39, "and ends." 39–48.
    const beforeHere = 1 + 34; // contentStart + offset of "here"

    it("a caret on the second wrapped line should report ITS line, column aligned past markup", () => {
        const caret = sourceCaretAt(wrapped(), computeLineMap(source), source.split("\n"), beforeHere);
        expect(caret).toEqual({ line: 2, column: "continues **bold** ".length });
    });

    it("a source caret on the second wrapped line should map back to the same position", () => {
        expect(docPosForSourceCaret(wrapped(), computeLineMap(source), source.split("\n"), {
            line: 2, column: "continues **bold** ".length,
        })).toBe(beforeHere);
    });

    it("a caret on the LAST wrapped line should not be dragged to the paragraph start", () => {
        const caret = sourceCaretAt(wrapped(), computeLineMap(source), source.split("\n"), 1 + 43);
        expect(caret).toEqual({ line: 3, column: 4 });
    });

    it("sourceEndOfBlock should end at the last wrapped line's end", () => {
        expect(sourceEndOfBlock(wrapped(), computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 3, column: "and ends.".length });
    });

    it("a selection across wrapped lines should carry each end on its own line", () => {
        const d = wrapped();
        const ends = sourceSelectionEnds(d, computeLineMap(source), source.split("\n"), {
            from: 1 + 8, to: beforeHere, anchor: 1 + 8, head: beforeHere, empty: false,
        });
        expect(ends).toEqual({
            anchor: { line: 1, column: 8 },
            head: { line: 2, column: "continues **bold** ".length },
        });
    });
});

describe("wrapped lines containing an inline node with text content", () => {
    // Inline math stores its LaTeX as literal text CONTENT: textBetween counts
    // those characters, so the segment text must too, or every column after
    // the math on a wrapped line skews (the segment used to accumulate only
    // direct text children).
    const source = "sum $E=mc^2$ done\nnext line\n";
    const d = () =>
        doc(schema.node("paragraph", null, [
            schema.text("sum "),
            schema.node("math_inline", null, [schema.text("E=mc^2")]),
            schema.text(" done"),
            schema.node("hardbreak"),
            schema.text("next line"),
        ]));
    // Content offsets: "sum " 0–4, math 4–12 (its text at 5–11), " done"
    // 12–17, break 17–18, "next line" 18–27.

    it("a caret after the math should count its LaTeX and align past the $ markers", () => {
        const caret = sourceCaretAt(d(), computeLineMap(source), source.split("\n"), 1 + 13);
        expect(caret).toEqual({ line: 1, column: "sum $E=mc^2$ ".length });
    });

    it("the second wrapped line should still map to its own line", () => {
        const caret = sourceCaretAt(d(), computeLineMap(source), source.split("\n"), 1 + 18 + 4);
        expect(caret).toEqual({ line: 2, column: 4 });
    });
});

describe("tables (one source line per row)", () => {
    // Node names mirror Milkdown's GFM preset. A row is ONE source line; the
    // old per-cell anchors could never be verified against `| a | b |` rows,
    // and the failed verification sent carets in and around tables to wildly
    // wrong lines.
    const tableSchema = new Schema({
        nodes: {
            doc: { content: "block+" },
            paragraph: { group: "block", content: "inline*" },
            table: { group: "block", content: "table_header_row table_row*" },
            table_header_row: { content: "table_header+" },
            table_row: { content: "table_cell+" },
            table_header: { content: "paragraph" },
            table_cell: { content: "paragraph" },
            text: { group: "inline" },
        },
    });
    const tp = (t: string) => tableSchema.node("paragraph", null, t ? [tableSchema.text(t)] : []);
    const cell = (t: string) => tableSchema.node("table_cell", null, [tp(t)]);
    const hcell = (t: string) => tableSchema.node("table_header", null, [tp(t)]);
    const source = "before\n\n| Tool | Note |\n| --- | --- |\n| Alpha | works well |\n| Beta | mostly fine |\n\nafter\n";
    const table = () =>
        tableSchema.node("table", null, [
            tableSchema.node("table_header_row", null, [hcell("Tool"), hcell("Note")]),
            tableSchema.node("table_row", null, [cell("Alpha"), cell("works well")]),
            tableSchema.node("table_row", null, [cell("Beta"), cell("mostly fine")]),
        ]);
    const d = () => tableSchema.node("doc", null, [tp("before"), table(), tp("after")]);
    // Positions: doc → p("before") size 8, table starts at 8. Row content
    // starts at rowStart+1; each cell is cell(1)+p(1) around its text.

    it("a caret in a body-row cell should report the ROW's source line, column past the pipes", () => {
        // Second body row, second cell, before "fine": table 8, header row
        // size = 2 + 2*(2 + 2 + 4|4) …computed from the doc itself instead.
        const doc2 = d();
        let pos = -1;
        doc2.descendants((node, p2) => {
            if (node.isText && node.text === "mostly fine") { pos = p2 + "mostly ".length; }
            return true;
        });
        expect(pos).toBeGreaterThan(0);
        const caret = sourceCaretAt(doc2, computeLineMap(source), source.split("\n"), pos);
        expect(caret).toEqual({ line: 6, column: "| Beta | mostly ".length });
    });

    it("a source caret inside a row should map back into the right cell", () => {
        const doc2 = d();
        let pos = -1;
        doc2.descendants((node, p2) => {
            if (node.isText && node.text === "mostly fine") { pos = p2 + "mostly ".length; }
            return true;
        });
        expect(docPosForSourceCaret(doc2, computeLineMap(source), source.split("\n"), {
            line: 6, column: "| Beta | mostly ".length,
        })).toBe(pos);
    });

    it("the header row should sit on the table's first line, body rows past the delimiter", () => {
        const doc2 = d();
        let headerPos = -1;
        doc2.descendants((node, p2) => {
            if (node.isText && node.text === "Tool") { headerPos = p2 + 2; }
            return true;
        });
        expect(sourceCaretAt(doc2, computeLineMap(source), source.split("\n"), headerPos))
            .toEqual({ line: 3, column: "| To".length });
    });

    it("a selection across cells should carry both ends on their own rows", () => {
        const doc2 = d();
        let from = -1, to = -1;
        doc2.descendants((node, p2) => {
            if (node.isText && node.text === "Alpha") { from = p2; }
            if (node.isText && node.text === "mostly fine") { to = p2 + "mostly".length; }
            return true;
        });
        const ends = sourceSelectionEnds(doc2, computeLineMap(source), source.split("\n"), {
            from, to, anchor: from, head: to, empty: false,
        });
        expect(ends).toEqual({
            anchor: { line: 5, column: "| ".length },
            head: { line: 6, column: "| Beta | mostly".length },
        });
    });

    it("sourceEndOfBlock should end at the LAST row's line", () => {
        expect(sourceEndOfBlock(d(), computeLineMap(source), source.split("\n"), 1))
            .toEqual({ line: 6, column: "| Beta | mostly fine |".length });
    });
});

describe("tables after map drift (short cells)", () => {
    // A loose list is one node with one map entry PER ITEM, so the table's
    // nominal pairing is off by one — and short cells ("Tool", "Note") are
    // under the fuzzy floor, so only whole-line normalized equality can
    // verify the table at its own line. Without it, an arriving caret for a
    // row line fell through to the block AFTER the table.
    const tableSchema = new Schema({
        nodes: {
            doc: { content: "block+" },
            paragraph: { group: "block", content: "inline*" },
            bullet_list: { group: "block", content: "list_item+" },
            list_item: { content: "paragraph" },
            table: { group: "block", content: "table_header_row table_row*" },
            table_header_row: { content: "table_header+" },
            table_row: { content: "table_cell+" },
            table_header: { content: "paragraph" },
            table_cell: { content: "paragraph" },
            text: { group: "inline" },
        },
    });
    const tp = (t: string) => tableSchema.node("paragraph", null, t ? [tableSchema.text(t)] : []);
    const source = "- loose one\n\n- loose two\n\n| Tool | Note |\n| --- | --- |\n| Al | ok |\n\nAfterward paragraph.\n";
    const d = () =>
        tableSchema.node("doc", null, [
            tableSchema.node("bullet_list", null, [
                tableSchema.node("list_item", null, [tp("loose one")]),
                tableSchema.node("list_item", null, [tp("loose two")]),
            ]),
            tableSchema.node("table", null, [
                tableSchema.node("table_header_row", null, [
                    tableSchema.node("table_header", null, [tp("Tool")]),
                    tableSchema.node("table_header", null, [tp("Note")]),
                ]),
                tableSchema.node("table_row", null, [
                    tableSchema.node("table_cell", null, [tp("Al")]),
                    tableSchema.node("table_cell", null, [tp("ok")]),
                ]),
            ]),
            tp("Afterward paragraph."),
        ]);

    it("a source caret on a short-celled row should land in the drifted table, not past it", () => {
        const doc2 = d();
        let pos = -1;
        doc2.descendants((node, p2) => {
            if (node.isText && node.text === "ok") { pos = p2; }
            return true;
        });
        // Line 7 is "| Al | ok |"; column after "| Al | " is the 'o'.
        expect(docPosForSourceCaret(doc2, computeLineMap(source), source.split("\n"), {
            line: 7, column: "| Al | ".length,
        })).toBe(pos);
    });

    it("a caret in a short cell should still report its row's line", () => {
        const doc2 = d();
        let pos = -1;
        doc2.descendants((node, p2) => {
            if (node.isText && node.text === "ok") { pos = p2 + 1; }
            return true;
        });
        expect(sourceCaretAt(doc2, computeLineMap(source), source.split("\n"), pos))
            .toEqual({ line: 7, column: "| Al | o".length });
    });
});

describe("marker-line containers (callouts, directives, asides)", () => {
    // Their marker lines live in ATTRS, not content — `> [!NOTE]`, `:::name`,
    // `<aside>`, and the `:::`/`</aside>` closers — so without marker anchors
    // every body anchor paired one line early (more when nested) and
    // verification never fit the block at its own line.
    const callout = (...blocks: ReturnType<typeof p>[]) => schema.node("callout", null, blocks);
    const directive = (...blocks: ReturnType<typeof p>[]) => schema.node("container_directive", null, blocks);
    const aside = (...blocks: ReturnType<typeof p>[]) => schema.node("notion_callout", null, blocks);

    it("a caret in a callout body should land on ITS line, past the marker line", () => {
        const source = "> [!NOTE]\n> Callout body words.\n\nafter\n";
        const d = doc(callout(p("Callout body words.")), p("after"));
        const pos = inBlock(d, 0, 0) + 1 + 8; // 8 chars into the body paragraph
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), pos))
            .toEqual({ line: 2, column: "> ".length + 8 });
        expect(docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), {
            line: 2, column: "> ".length + 8,
        })).toBe(pos);
    });

    it("a nested directive body should land on its own line through both markers", () => {
        const source = ":::danger Nesting\nOuter body.\n::note Inner\nFewer colons inside.\n::\n:::\n\nafter\n";
        const d = doc(
            directive(p("Outer body."), directive(p("Fewer colons inside."))),
            p("after"),
        );
        let pos = -1;
        d.descendants((node, p2) => {
            if (node.isText && node.text === "Fewer colons inside.") { pos = p2 + 6; }
            return true;
        });
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), pos))
            .toEqual({ line: 4, column: 6 });
        expect(docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), {
            line: 4, column: 6,
        })).toBe(pos);
    });

    it("a directive's block end should claim its closing ::: line", () => {
        const source = ":::tip Title\nDirective body.\n:::\n\nafter\n";
        const d = doc(directive(p("Directive body.")), p("after"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 3, column: 3 });
    });

    it("a notion aside should map its body and claim its closing </aside> line", () => {
        const source = "<aside>\nAside body text.\n</aside>\n\nafter\n";
        const d = doc(aside(p("Aside body text.")), p("after"));
        const pos = inBlock(d, 0, 0) + 1 + 3;
        expect(sourceCaretAt(d, computeLineMap(source), source.split("\n"), pos))
            .toEqual({ line: 2, column: 3 });
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 3, column: "</aside>".length });
    });

    it("a callout after map drift should still be found for an arriving line", () => {
        const source = "- loose a\n\n- loose b\n\n> [!TIP]\n> Tip body words here.\n\nAfter paragraph.\n";
        const d = doc(
            list("loose a", "loose b"),
            callout(p("Tip body words here.")),
            p("After paragraph."),
        );
        let pos = -1;
        d.descendants((node, p2) => {
            if (node.isText && node.text === "Tip body words here.") { pos = p2 + 4; }
            return true;
        });
        expect(docPosForSourceCaret(d, computeLineMap(source), source.split("\n"), {
            line: 6, column: "> ".length + 4,
        })).toBe(pos);
    });

    it("a math block's end should claim its closing $$ line", () => {
        const source = "$$\nE = mc^2\n$$\n\nafter\n";
        const d = doc(code("E = mc^2"), p("after"));
        expect(sourceEndOfBlock(d, computeLineMap(source), source.split("\n"), 0))
            .toEqual({ line: 3, column: 2 });
    });
});
