/**
 * The host's link scanner against the editor's own reading of the same bytes.
 *
 * `shared/noteLinks.ts` reads links out of Markdown SOURCE so a host can index
 * a folder without building an editor per file. Whatever it finds is what the
 * Backlinks tab and the graph believe about a note, so it has to find what the
 * editor finds: this parses every corpus fixture with the live editor, runs the
 * page's own Links scanner (`webview/links/scan.ts`) over the document, and
 * holds the two lists of destinations equal, fixture by fixture.
 *
 * The comparison is over NOTE destinations (`isNoteHref`) in source order.
 * Autolinks are left out on purpose: `<scheme:...>` and a bare `https://` or
 * `www.` both always carry a scheme, so none can ever name a note, and the
 * scanner does not look for them. The page scanner merges
 * two adjacent runs that share an href into one item, which a source scanner
 * cannot see, so consecutive duplicates are collapsed on both sides first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import type { Node as ProseNode } from "../pm";
import { scanLinks } from "../links/scan";
import { isNoteHref, scanBodyLinks } from "../../shared/noteLinks";
import { extractFrontmatter } from "../../shared/contentTransform";
import { budget } from "./helpers/testBudget";
import { loadCorpusFixtures, makeCorpusEditor, type CorpusFixture } from "./helpers/moveFuzz"; // corpus-sweep-kept: the only oracle shared/noteLinks.ts's body scanner has, and one parse per fixture

const fixtures: CorpusFixture[] = loadCorpusFixtures();

let live: Editor;
let parse: (text: string) => ProseNode;

beforeAll(async () => {
    live = await makeCorpusEditor("");
    parse = (text) => live.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode;
});
afterAll(async () => {
    await live.destroy();
});

/** Consecutive equal entries collapsed: the page scanner's run merge. */
function collapse(list: string[]): string[] {
    return list.filter((v, i) => i === 0 || v !== list[i - 1]);
}

/** A note destination, with the wikilink marker taken off to classify it. */
function keep(tagged: string): boolean {
    return isNoteHref(tagged.startsWith("wiki:") ? tagged.slice(5) : tagged);
}

function editorHrefs(body: string): string[] {
    return collapse(scanLinks(parse(body)).map((l) => (l.wiki ? "wiki:" : "") + l.href).filter(keep));
}

function scannerHrefs(body: string): string[] {
    return collapse(scanBodyLinks(body).map((l) => (l.wiki ? "wiki:" : "") + l.href).filter(keep));
}

/**
 * The places a link's SHAPE appears and the editor still sees text, plus the
 * spellings a destination can take. The corpus holds almost no note links in
 * any of these, so without them the parity below would pass on a scanner that
 * never masks a fence. Judged by the editor like the corpus is: nothing here
 * states what the answer should be.
 */
const CONTEXTS: readonly string[] = [
    "```js\n// [fenced](fence.md) and [[Fence Wiki]]\n```\n\n[after](after.md)\n",
    "~~~\n[tilde](tilde.md)\n~~~\n",
    "````\n```\n[still fenced](still.md)\n````\n",
    "    [indented](indented.md)\n\n[after](after.md)\n",
    "Para\n    [lazy continuation](lazy.md)\n",
    "- item\n\n      [code in item](item-code.md)\n",
    "- a\n  - b\n\n        [code in nested item](nested-code.md)\n\n  [back in a](back.md)\n",
    "1. one [ordered](ordered.md)\n2. two [[Ordered Two|the second]]\n",
    "> quoted [q](q.md)\n>\n> > nested [nq](nq.md)\n\n> ```\n> [quoted fence](qf.md)\n> ```\n",
    "<!-- [commented](comment.md) [[Commented]] -->\n\nText <!-- [inline comment](ic.md) --> [kept](kept.md)\n",
    "<div>\n[html block](html.md)\n</div>\n\n[after html](after-html.md)\n",
    "<details>\n<summary>S</summary>\n\n[inside details](details.md)\n\n</details>\n",
    "$$\n[math](math.md)\n$$\n\n[after math](after-math.md)\n",
    "`[code](code.md)` and ``a [double](tick.md) span`` and [real](real.md)\n",
    "\\[escaped](nope.md) and [real](real.md)\n",
    "[spec](<specs/api spec.md>) [v2](design\\(v2\\).md) [t](g.md \"Terms\") [r](/index.md) [e](drafts/first%20draft.md) [amp](r&amp;d.md) [n](&#x41;.md)\n",
    "[a long\nlabel](wrapped.md) and [x](\nnext-line.md)\n",
    "[full][ref] [collapsed][] [ref] [missing][nope]\n\n[ref]: ref-target.md\n",
    "Call.[^1]\n\n[^1]: The source is [[Footnote Source]] and [the appendix](appendix.md).\n",
    "![image](images/i.png) ![[Embedded]] [[Cited]](https://example.com/c) [![badge](b.png)](badge-target.md)\n",
    "| Page | Link |\n| --- | --- |\n| One | [one](table/one.md) |\n| Two | [[Table Two]] |\n",
    "# Heading with [link](heading-link.md)\n\nSetext [s](setext.md)\n===\n",
];

/** A naive reading that finds every `[text](target)` shape, masked or not. */
function naiveShapes(body: string): number {
    return (body.match(/\[[^\]\n]*\]\([^)\s]+/g) ?? []).length;
}

describe("noteLinks against the editor's own Links scan", { timeout: budget(60_000) }, () => {
    it("the corpus should hold enough links for the parity below to mean something", () => {
        const withLinks = fixtures.filter((f) => editorHrefs(extractFrontmatter(f.content).body).length > 0);
        expect(fixtures.length).toBeGreaterThan(20);
        expect(withLinks.length).toBeGreaterThan(5);
        // Wikilinks dominate the corpus; a Markdown link to a note is the more
        // common spelling in a real vault, so it needs a floor of its own
        // (note-links.md is the fixture that carries most of them).
        const markdownNoteLinks = fixtures.reduce(
            (n, f) => n + editorHrefs(extractFrontmatter(f.content).body).filter((h) => !h.startsWith("wiki:")).length, 0);
        expect(markdownNoteLinks).toBeGreaterThanOrEqual(20);
    });

    it("the contexts should reach both links the editor keeps and shapes it reads as text", () => {
        // A context where the editor finds fewer links than a naive reading
        // does is one that exercises a mask; the parity below only means
        // something for masks if enough of them are here.
        const masking = CONTEXTS.filter((c) => editorHrefs(c).length < naiveShapes(c));
        const kept = CONTEXTS.reduce((n, c) => n + editorHrefs(c).length, 0);
        expect(masking.length).toBeGreaterThanOrEqual(12);
        expect(kept).toBeGreaterThanOrEqual(25);
    });

    it("every fixture and context should yield the destinations the editor finds, in order", () => {
        const sources = [
            ...fixtures.map((f) => ({ name: f.name, body: extractFrontmatter(f.content).body })),
            ...CONTEXTS.map((body, i) => ({ name: `context ${i}`, body })),
        ];
        const disagreements: string[] = [];
        for (const { name, body } of sources) {
            const theirs = editorHrefs(body);
            const ours = scannerHrefs(body);
            if (JSON.stringify(theirs) !== JSON.stringify(ours)) {
                disagreements.push(`${name}: editor ${JSON.stringify(theirs)} scanner ${JSON.stringify(ours)}`);
            }
        }
        expect(disagreements).toEqual([]);
    });
});
