/**
 * The headless parser is the page's parser or it is nothing: a worker whose
 * schema or remark pipeline differed from the live editor's would answer the
 * reopen question about a document the user is not looking at, and the save
 * pipeline would act on that answer. So this holds the two equal, node for
 * node, over every fixture in the corpus, and proves the oracle can disagree
 * by building a parser from the commonmark preset alone and finding the
 * fixtures where that one differs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parserCtx, schemaCtx, type Editor } from "@milkdown/core";
import type { Node as ProseNode, Schema } from "../pm";
import { markdownParse } from "../format/markdown/parse";
import { pureCommonmark, configureSerialization } from "../serialization";
import { createHeadlessParser, type HeadlessParser } from "../utils/headlessParser";
import { loadCorpusFixtures, makeCorpusEditor, type CorpusFixture } from "./helpers/moveFuzz";

const fixtures: CorpusFixture[] = loadCorpusFixtures();

let live: Editor;
let liveParse: (text: string) => ProseNode;
let headless: HeadlessParser;
let commonmarkOnly: HeadlessParser;

beforeAll(async () => {
    live = await makeCorpusEditor("");
    liveParse = (text) => live.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode;
    headless = await createHeadlessParser(markdownParse);
    commonmarkOnly = await createHeadlessParser({ presets: [pureCommonmark], configureSerialization });
});
afterAll(async () => {
    await live.destroy();
    await headless.destroy();
    await commonmarkOnly.destroy();
});

describe("the headless parser against the live editor's", () => {
    it("the corpus should be large enough for the parity below to mean something", () => {
        expect(fixtures.length).toBeGreaterThan(20);
    });

    it("both should build the same schema: every node and mark, by name", () => {
        const liveSchema = live.action((ctx) => ctx.get(schemaCtx)) as Schema;
        expect(Object.keys(headless.schema.nodes).sort()).toEqual(Object.keys(liveSchema.nodes).sort());
        expect(Object.keys(headless.schema.marks).sort()).toEqual(Object.keys(liveSchema.marks).sort());
    });

    // Compared as JSON, not with `Node.eq`: two schemas built separately hold
    // distinct NodeType objects, and `eq` compares types by identity, so it
    // would report every fixture different however alike the trees were.
    // The JSON carries type names, attrs, marks and text, which is what "the
    // same document" means across two schemas.
    const sameTree = (a: ProseNode, b: ProseNode | null): boolean =>
        b !== null && JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());

    it("every corpus fixture should parse to the same document through both", () => {
        const differing: string[] = [];
        let compared = 0;
        for (const f of fixtures) {
            compared++;
            if (!sameTree(liveParse(f.content), headless.parse(f.content))) differing.push(f.name);
        }
        expect(differing).toEqual([]);
        expect(compared).toBe(fixtures.length);
    }, 60_000);

    it("a parser built from commonmark alone should differ somewhere, so the comparison discriminates", () => {
        const differing = fixtures.filter((f) => !sameTree(liveParse(f.content), commonmarkOnly.parse(f.content)));
        expect(differing.length).toBeGreaterThan(0);
    }, 60_000);
});
