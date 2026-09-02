/**
 * The block segmenter's one contract, held against the real parser over the
 * whole corpus: for every cut it proposes, the two halves parse and
 * concatenate to exactly the blocks the whole parses to.
 *
 * That is a differential oracle, so the file also proves the oracle can
 * disagree: a naive segmenter that cuts at every blank line must be refused
 * somewhere in the corpus, or the parity assertion is decoration. And it
 * asserts its own reach, because a segmenter that proposes no cuts passes the
 * parity check vacuously: the corpus-wide cut count has a floor, and the
 * fixtures that come back as one chunk are named rather than counted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import type { Node as ProseNode } from "../pm";
import { findSafeCuts, segmentBlocks } from "../utils/blockSegmenter";
import { loadCorpusFixtures, makeCorpusEditor, type CorpusFixture } from "./helpers/moveFuzz";

const fixtures: CorpusFixture[] = loadCorpusFixtures();

let editor: Editor;
let parse: (text: string) => ProseNode;

beforeAll(async () => {
    editor = await makeCorpusEditor("");
    parse = (text) => editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode;
});
afterAll(async () => {
    await editor.destroy();
});

const splitLines = (text: string): string[] => text.split(/\r?\n/);

/** The oracle: parse(whole).content equals parse(head).content followed by parse(tail).content. */
function cutIsSafe(text: string, cut: number): boolean {
    const starts = lineStartOffsets(text);
    const head = text.slice(0, starts[cut]);
    const tail = text.slice(starts[cut]);
    const whole = parse(text);
    return whole.content.eq(parse(head).content.append(parse(tail).content));
}

function lineStartOffsets(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    return starts;
}

/** Every blank-then-content boundary, with no argument about what is open. */
function naiveCuts(lines: string[]): number[] {
    const cuts: number[] = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i - 1].trim() === "" && lines[i].trim() !== "" && lines.slice(0, i).some((l) => l.trim() !== "")) {
            cuts.push(i);
        }
    }
    return cuts;
}

describe("findSafeCuts against the parser, over the corpus", () => {
    it("every proposed cut should split the text into halves that parse to the whole's blocks", () => {
        const failures: string[] = [];
        let cuts = 0;
        for (const f of fixtures) {
            for (const cut of findSafeCuts(splitLines(f.content))) {
                cuts++;
                if (!cutIsSafe(f.content, cut)) failures.push(`${f.name} before line ${cut + 1}`);
            }
        }
        expect(failures).toEqual([]);
        // Reach: a segmenter that proposes nothing passes the loop above.
        expect(cuts).toBeGreaterThan(300);
        // Two parses per cut over the whole corpus: seconds alone, and several
        // times that on a busy machine, so the timeout is sized from that.
    }, 60_000);

    it("the fixtures that come back as one chunk should be exactly the ones carrying definitions, plus the one-list outlines", () => {
        const whole = fixtures.filter((f) => findSafeCuts(splitLines(f.content)).length === 0).map((f) => f.name).sort();
        const withDefinitions = fixtures
            .filter((f) => /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:(?:[ \t]|$)/m.test(f.content))
            .map((f) => f.name);
        // A Logseq-style outline is ONE list from its first line to its last,
        // and one list is one block: the conservative answer and the true one.
        const oneList = ["logseq/journal.md", "outline-tables.md"];
        expect(whole).toEqual([...withDefinitions, ...oneList].sort());
        expect(whole.length).toBeLessThan(fixtures.length / 2);
    });

    it("cutting at every blank line should be refused by the oracle somewhere, so the oracle discriminates", () => {
        // A few naive-only cuts per fixture are enough to prove the point,
        // and each costs two parses; the full set takes over a minute.
        const PER_FIXTURE = 3;
        let refused = 0;
        let tried = 0;
        for (const f of fixtures) {
            const lines = splitLines(f.content);
            const safe = new Set(findSafeCuts(lines));
            for (const cut of naiveCuts(lines).filter((c) => !safe.has(c)).slice(0, PER_FIXTURE)) {
                tried++;
                if (!cutIsSafe(f.content, cut)) refused++;
            }
        }
        expect(tried).toBeGreaterThan(10);
        expect(refused).toBeGreaterThan(0);
    }, 60_000);
});

describe("findSafeCuts on the constructs it refuses", () => {
    const cutsOf = (text: string) => findSafeCuts(splitLines(text));

    it("plain paragraphs should cut at every blank run", () => {
        expect(cutsOf("a\n\nb\n\n\nc\n")).toEqual([2, 5]);
    });

    it("leading blank lines should never produce an empty first chunk", () => {
        expect(cutsOf("\n\na\n\nb")).toEqual([4]);
    });

    it("a blank inside a fence should not be a cut, nor the fence's closing line", () => {
        expect(cutsOf("a\n\n```\nx\n\ny\n\n```\n\nb\n")).toEqual([2, 9]);
    });

    it("a fence opened on a list-marker line should be closed by its own closer", () => {
        expect(cutsOf("- ```js\n  x\n\n  y\n  ```\n\nb\n")).toEqual([6]);
    });

    it("a blank between two items of one list should not be a cut, and the list's end should be", () => {
        expect(cutsOf("- a\n\n- b\n\nc\n")).toEqual([4]);
        expect(cutsOf("1. a\n\n2. b\n\n   still b\n\nc\n")).toEqual([6]);
    });

    it("an indented line after a blank should continue whatever is open", () => {
        expect(cutsOf("    code\n\n    more\n\nb\n")).toEqual([4]);
        expect(cutsOf("- a\n\n  para of a\n\nb\n")).toEqual([4]);
    });

    it("an HTML comment, pre block or Notion aside spanning blank lines should not be cut", () => {
        expect(cutsOf("a\n\n<!--\n\nhidden\n\n-->\n\nb\n")).toEqual([2, 8]);
        expect(cutsOf("<pre>\n\nx\n</pre>\n\nb\n")).toEqual([5]);
        expect(cutsOf("<aside>\n💡 lead\n\npara\n\n</aside>\n\nb\n")).toEqual([7]);
        // Closed on its own line: nothing stays open.
        expect(cutsOf("<!-- one line -->\n\nb\n")).toEqual([2]);
    });

    it("a $$ math block or a ::: directive spanning blank lines should not be cut", () => {
        expect(cutsOf("$$\nx\n\ny\n$$\n\nb\n")).toEqual([6]);
        expect(cutsOf("::: note\nx\n\ny\n:::\n\nb\n")).toEqual([6]);
        expect(cutsOf("::: outer\n:::: inner\n\nx\n::::\n\ny\n:::\n\nb\n")).toEqual([9]);
    });

    it("a frontmatter block at the top should not be cut, and an hr later should not be mistaken for one", () => {
        expect(cutsOf("---\ntitle: x\n\ntags: y\n---\n\nb\n\n---\n\nc\n")).toEqual([6, 8, 10]);
    });

    it("a link reference definition or a footnote definition should make the whole text one chunk", () => {
        expect(cutsOf("a [x]\n\n[x]: http://e\n\nb\n")).toEqual([]);
        expect(cutsOf("a[^1]\n\n[^1]: note\n\nb\n")).toEqual([]);
        // Inside a fence it is bytes, not a definition.
        expect(cutsOf("```\n[x]: http://e\n```\n\nb\n")).toEqual([4]);
        // Inside a quote, four spaces into an ordered item, or tab-indented,
        // it is still document-scoped.
        expect(cutsOf("para [x]\n\n> [x]: http://e\n")).toEqual([]);
        expect(cutsOf("1. a\n\n    [x]: http://e\n\nb [x]\n")).toEqual([]);
        expect(cutsOf("- a\n\n\t[x]: http://e\n\nb\n")).toEqual([]);
    });

    it("a closer indented four past its opener is content, and a flush closer under a marker-line fence opens a new fence", () => {
        // The diff engine's scanner closes at any indent; the parser does not.
        expect(cutsOf("```\ncode\n    ```\nmore\n\nafter\n")).toEqual([]);
        expect(cutsOf("```\ncode\n    ```\nmore\n```\n\nafter\n")).toEqual([6]);
        // A fence riding `- ` has its content column at 2: a column-0 run
        // ends the item and opens a fence of its own, which never closes here.
        expect(cutsOf("- ```js\n  x\n```\ny\n\nz\n")).toEqual([]);
        expect(cutsOf("- ```js\n  x\n  ```\n\nz\n")).toEqual([4]);
    });
});

describe("findSafeCuts against the parser, on the constructs the corpus lacks", () => {
    // Shapes a review found that no fixture carries, each pinned by the oracle
    // as well as by the expectation above, so a future loosening has to
    // survive the parser and not only the corpus.
    const SHAPES = [
        "```\ncode\n    ```\nmore\n\nafter\n",
        "```\ncode\n    ```\nmore\n```\n\nafter\n",
        "- ```js\n  x\n```\ny\n\nz\n",
        "- ```js\n  x\n  ```\n\nz\n",
        "para [x]\n\n> [x]: http://e\n",
        "1. a\n\n    [x]: http://e\n\nb [x]\n",
        "- a\n\n\t[x]: http://e\n\nb\n",
        "- item\n\n  ```\n  code\n```\n\nafter\n",
    ];

    it("every cut proposed on them should satisfy the oracle, and at least one shape should still get a cut", () => {
        let proposed = 0;
        for (const text of SHAPES) {
            for (const cut of findSafeCuts(splitLines(text))) {
                proposed++;
                expect(cutIsSafe(text, cut), `${JSON.stringify(text)} before line ${cut + 1}`).toBe(true);
            }
        }
        expect(proposed).toBeGreaterThan(0);
    });

    it("the naive cut each shape invites should be refused by the oracle, so the shapes test something", () => {
        let refused = 0;
        for (const text of SHAPES) {
            const lines = splitLines(text);
            const safe = new Set(findSafeCuts(lines));
            for (const cut of naiveCuts(lines)) {
                if (!safe.has(cut) && !cutIsSafe(text, cut)) refused++;
            }
        }
        expect(refused).toBeGreaterThanOrEqual(SHAPES.length - 2);
    });
});

describe("segmentBlocks", () => {
    it("the chunks should partition every corpus fixture byte for byte, line endings included", () => {
        let multi = 0;
        for (const f of fixtures) {
            const chunks = segmentBlocks(f.content, 8);
            expect(chunks.map((c) => c.text).join("")).toBe(f.content);
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].start).toBe(chunks[i - 1].end);
                expect(chunks[i].startLine).toBe(chunks[i - 1].endLine);
            }
            if (chunks.length > 1) multi++;
        }
        expect(multi).toBeGreaterThan(fixtures.length / 2);
    });

    it("every chunk but the last should hold at least the target line count", () => {
        const text = Array.from({ length: 40 }, (_, i) => `p${i}\n`).join("\n");
        const chunks = segmentBlocks(text, 5);
        expect(chunks.length).toBeGreaterThan(3);
        for (const c of chunks.slice(0, -1)) expect(c.endLine - c.startLine).toBeGreaterThanOrEqual(5);
    });

    it("CRLF endings should survive the partition", () => {
        const text = "a\r\n\r\nb\r\n\r\nc\r\n";
        const chunks = segmentBlocks(text, 1);
        expect(chunks.map((c) => c.text)).toEqual(["a\r\n\r\n", "b\r\n\r\n", "c\r\n"]);
    });

    it("a text with no safe cut should be one chunk", () => {
        const text = "a [x]\n\n[x]: http://e\n";
        // Four lines: the trailing newline ends a last, empty line.
        expect(segmentBlocks(text, 1)).toEqual([{ start: 0, end: text.length, startLine: 0, endLine: 4, text }]);
    });
});
