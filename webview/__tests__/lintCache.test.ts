import { describe, it, expect, beforeEach } from "vitest";
import { clearLintCache, LINT_CACHE_MAX, lintCacheGeneration, lintCacheSize, lookupLints, rememberLints } from "../proofread/lintCache";
import { lintBlocksToAsk, resolveLintResults } from "../plugins/proofread";
import { setUserWords } from "../proofread/engine";
import type { HarperLint, LintBlock } from "../../shared/messages";
import { HEAVY_FIXTURES } from "../../e2e/perf/fixtures.mjs";

/**
 * The rescan asks the host about the whole document after every edit, and the
 * host's checker is not free: on the Mac app it is `NSSpellChecker`, which runs
 * on the thread key events arrive on. These pin the claim the cache makes, which
 * is that a one-block edit costs a one-block question.
 *
 * The two exported helpers are tested rather than the plugin, deliberately: the
 * question "how many blocks did this ask about" is answerable here without a
 * view, a host or a round trip, and it is the whole of what the fix changed.
 */

const lint = (start: number, end: number, kind = "Spelling"): HarperLint => ({
    start, end, kind, message: "Possible misspelling", suggestions: [],
});

/** A document as the plugin collects it: a position key and the block's text. */
const blocks = (...texts: string[]): LintBlock[] =>
    texts.map((text, i) => ({ key: i * 100, text }));

describe("lintBlocksToAsk", () => {
    beforeEach(() => { clearLintCache(); });

    it("an unseen document should be asked about in full", () => {
        const doc = blocks("alpha one", "beta two", "gamma three");
        expect(lintBlocksToAsk(doc)).toHaveLength(3);
    });

    it("a document whose blocks are all answered should be asked about not at all", () => {
        const doc = blocks("alpha one", "beta two", "gamma three");
        for (const b of doc) { rememberLints(b.text, []); }
        expect(lintBlocksToAsk(doc)).toEqual([]);
    });

    it("an edit to one block should be asked about as one block", () => {
        const doc = blocks("alpha one", "beta two", "gamma three");
        for (const b of doc) { rememberLints(b.text, []); }
        // What a keystroke does: one block's text changes, every other block's
        // text and the whole document's block count stay as they were.
        const edited = blocks("alpha one", "beta twoX", "gamma three");
        const asking = lintBlocksToAsk(edited);
        expect(asking).toEqual([{ key: 100, text: "beta twoX" }]);
    });

    it("a block that only moved should not be asked about again", () => {
        // The cache key is text and not position, so re-flowing the document
        // around a block leaves its answer standing. This is the case that
        // makes typing in the FIRST paragraph of a long note cheap: every
        // block after it shifts position and none of them changed.
        rememberLints("gamma three", []);
        expect(lintBlocksToAsk([{ key: 9999, text: "gamma three" }])).toEqual([]);
    });

    it("a repeated line should be asked about once", () => {
        const doc = blocks("same line", "other", "same line");
        const asking = lintBlocksToAsk(doc);
        expect(asking.map((b) => b.text)).toEqual(["same line", "other"]);
    });
});

describe("resolveLintResults", () => {
    beforeEach(() => { clearLintCache(); });

    it("every block should carry its findings, including ones left out of the request", () => {
        const doc = blocks("alpha one", "beta two", "gamma three");
        rememberLints("alpha one", [lint(0, 5)]);
        rememberLints("beta two", []);
        rememberLints("gamma three", [lint(6, 11)]);
        expect(resolveLintResults(doc)).toEqual([
            { key: 0, lints: [lint(0, 5)] },
            { key: 100, lints: [] },
            { key: 200, lints: [lint(6, 11)] },
        ]);
    });

    it("results should carry the document's own keys, not the asked-about subset's", () => {
        // `buildLintDecorations` resolves a node by `key`, so a result keyed to
        // anything but the block's position in the request's document draws in
        // the wrong place or nowhere.
        const doc = blocks("alpha one", "beta two");
        rememberLints("alpha one", []);
        rememberLints("beta two", [lint(0, 4)]);
        expect(resolveLintResults(doc).map((r) => r.key)).toEqual([0, 100]);
    });

    it("a block the host never answered for should resolve to no findings, not be dropped", () => {
        // A short answer must not leave a block's previous decorations standing:
        // the set is rebuilt from this, so a missing entry has to mean "clear",
        // never "keep whatever was there".
        const doc = blocks("answered", "never answered");
        rememberLints("answered", [lint(0, 3)]);
        expect(resolveLintResults(doc)).toEqual([
            { key: 0, lints: [lint(0, 3)] },
            { key: 100, lints: [] },
        ]);
    });

    it("a repeated line should resolve to the same findings at both of its positions", () => {
        const doc = blocks("same line", "other", "same line");
        rememberLints("same line", [lint(0, 4)]);
        rememberLints("other", []);
        expect(resolveLintResults(doc)).toEqual([
            { key: 0, lints: [lint(0, 4)] },
            { key: 100, lints: [] },
            { key: 200, lints: [lint(0, 4)] },
        ]);
    });
});

describe("the user dictionary changing", () => {
    beforeEach(() => { clearLintCache(); setUserWords([]); });

    it("removing a word should forget the answers that were computed without it", () => {
        // The direction nothing downstream can repair. Both hosts filter their
        // own findings by this dictionary, fresh per request, so while a word
        // is in it a block containing that word comes back with no finding. If
        // that answer outlived the removal, the word would stay unflagged until
        // its block's text changed.
        setUserWords(["birta"]);
        rememberLints("a paragraph mentioning birta", []);
        expect(lookupLints("a paragraph mentioning birta")).toEqual([]);

        setUserWords([]);
        expect(lookupLints("a paragraph mentioning birta")).toBeUndefined();
    });

    it("adding a word should forget too, rather than relying on the direction being safe", () => {
        // Adding IS repairable downstream (`isLintSuppressed` hides the cached
        // finding), so this is the cheaper rule rather than the necessary one.
        // It is asserted so that narrowing the clear to removals alone is a
        // deliberate change with a test to update, not a silent one.
        rememberLints("some text", []);
        setUserWords(["birta"]);
        expect(lookupLints("some text")).toBeUndefined();
    });

    it("setting the same words again should keep the answers", () => {
        // The discriminating case: a config round trip that changes nothing
        // must not throw the document's findings away, or every settings write
        // costs a whole-document recheck.
        setUserWords(["birta", "milkdown"]);
        rememberLints("some text", []);
        setUserWords(["MILKDOWN", "Birta"]);
        expect(lookupLints("some text")).toEqual([]);
    });
});

describe("the cache itself", () => {
    beforeEach(() => { clearLintCache(); });

    it("a remembered text should be found and an unseen one should be undefined", () => {
        rememberLints("seen", [lint(0, 4)]);
        expect(lookupLints("seen")).toEqual([lint(0, 4)]);
        // Undefined and not [], because "no findings" is an answer the cache
        // has to be able to hold: a clean paragraph must not be re-asked
        // about forever.
        expect(lookupLints("unseen")).toBeUndefined();
    });

    it("an answer of no findings should still count as answered", () => {
        rememberLints("clean", []);
        expect(lookupLints("clean")).toEqual([]);
        expect(lintBlocksToAsk([{ key: 0, text: "clean" }])).toEqual([]);
    });

    it("remembering the same text twice should not grow the cache", () => {
        rememberLints("once", []);
        rememberLints("once", [lint(0, 4)]);
        expect(lintCacheSize()).toBe(1);
        expect(lookupLints("once")).toEqual([lint(0, 4)]);
    });

    it("a session longer than the bound should evict oldest-first and stay bounded", () => {
        // The bound has to hold, or a long editing session grows without limit;
        // and it has to evict the OLDEST, or the document being edited is the
        // thing that falls out.
        const beyond = LINT_CACHE_MAX + 1000;
        for (let i = 0; i < beyond; i++) { rememberLints(`block ${i}`, []); }
        expect(lintCacheSize()).toBeLessThanOrEqual(LINT_CACHE_MAX);
        expect(lookupLints("block 0")).toBeUndefined();
        expect(lookupLints(`block ${beyond - 1}`)).toEqual([]);
    });

    it("the bound should hold the largest document the heavy perf fixtures stand in for", () => {
        // A FIFO smaller than the document evicts every entry before the next
        // pass reads it, which is no cache at all on exactly the document it is
        // for. `huge-outline` is the fixture that found this for the style
        // cache (MAR-425); its textblock count is the floor here, read off the
        // fixture rather than restated.
        // An outline over unwrapped prose with no tables, code or images, so a
        // non-blank line is a textblock and the count is a floor on the real one.
        const textblocks = HEAVY_FIXTURES["huge-outline"].split(/\n/).filter((line) => /\S/.test(line)).length;
        expect(textblocks).toBeGreaterThan(4000);
        expect(LINT_CACHE_MAX).toBeGreaterThan(textblocks);
    });

    it("every write should move the generation, and a lookup should not", () => {
        const before = lintCacheGeneration();
        lookupLints("nothing");
        expect(lintCacheGeneration()).toBe(before);
        rememberLints("something", []);
        expect(lintCacheGeneration()).toBe(before + 1);
        clearLintCache();
        expect(lintCacheGeneration()).toBe(before + 2);
    });
});
