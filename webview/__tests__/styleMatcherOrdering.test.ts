/**
 * The alternation-ordering contract (MAR-315).
 *
 * `compileList` sorts alternatives descending by normalized phrase — chosen for
 * speed (grouping shared prefixes cut the `large` fixture's scan ~31% in both
 * Chromium 151 and Node 22), not for correctness. What must survive that choice,
 * and any future one, is the OBSERVABLE contract: **the longest phrase matching
 * at a position wins**, whatever order the alternatives ended up in and whichever
 * chunk each landed in.
 *
 * These tests pin that contract rather than the comparator's spelling. The first
 * enumerates the whole population of pairs in the SHIPPED lists that can collide
 * at one start position — a shorter phrase whose normalized form is a proper
 * prefix of a longer one's — instead of hand-picking examples; the second is the
 * case that decides the sort KEY (normalized, not raw), and it fails if the
 * normalization is dropped; the third is the case chunking creates.
 *
 * The oracle throughout is the production matcher itself, compiled over a
 * one-phrase list. No test-side re-implementation of matching or of markers —
 * and the enumeration keys off the exported `normalizePhrase` rather than a
 * copy, so it models the sort key it is reasoning about instead of a lookalike.
 *
 * What these DON'T cover, because a unit test cannot keep it: the one-off
 * differential that decided the change, running both orderings over 10,990
 * inputs and comparing all 17,872 spans. Its result is recorded on `compileList`.
 */
import { describe, expect, it } from "vitest";
import {
    compileList,
    compileStyleMatcher,
    normalizePhrase,
    parseEntry,
    MAX_ALTERNATIVES_PER_REGEX,
    type StyleMatch,
} from "../utils/styleMatcher";
import {
    AI_ARTIFACTS,
    AI_VOCABULARY,
    CLICHES,
    FILLERS,
    REDUNDANCIES,
    WORDINESS,
} from "../proofread/wordlists";

const LISTS = {
    fillers: FILLERS,
    redundancies: REDUNDANCIES,
    cliches: CLICHES,
    wordiness: WORDINESS,
    aiVocabulary: AI_VOCABULARY,
    aiArtifacts: AI_ARTIFACTS,
} as const;

const CARRIER_PREFIX = "The ";

/**
 * Spans of the hits confined to the phrase's own place in the carrier sentence.
 * The category is dropped: the oracle compiles the phrase under whatever
 * category is convenient, and what is under test is which SPAN wins.
 */
function spansOverPhrase(matches: StyleMatch[], phrase: string): string[] {
    const end = CARRIER_PREFIX.length + phrase.length;
    return matches
        .filter((m) => m.start >= CARRIER_PREFIX.length && m.end <= end)
        .map((m) => `${m.start}-${m.end}`);
}

describe("alternation ordering — the longest phrase wins", () => {
    /**
     * Every (shorter, longer) pair in the shipped lists where the shorter
     * phrase's normalized form is a proper prefix of the longer's — the only way
     * two alternatives of one category can match at the same start position with
     * different lengths, because both matches come from the same subject string
     * and so the shorter's text is a prefix of the longer's.
     */
    const pairs: Array<{ category: string; shorter: string; longer: string; entry: string }> = [];
    for (const [category, list] of Object.entries(LISTS)) {
        const parsed = list.map((entry) => ({ entry, phrase: parseEntry(entry).phrase }));
        const byNormalized = new Map(parsed.map(({ phrase }) => [normalizePhrase(phrase), phrase]));
        for (const { entry, phrase: longer } of parsed) {
            const key = normalizePhrase(longer);
            for (let cut = 1; cut < key.length; cut++) {
                const shorter = byNormalized.get(key.slice(0, cut));
                if (shorter !== undefined) { pairs.push({ category, shorter, longer, entry }); }
            }
        }
    }

    it("the shipped lists should contain such pairs at all", () => {
        // Without this the enumeration below could pass by testing nothing —
        // and a wordlist edit that removes the last pair must say so loudly.
        expect(pairs.length).toBeGreaterThan(0);
        expect(pairs.map((p) => `${p.shorter} | ${p.longer}`)).toContain("delve | delve into");
    });

    it.each(pairs.map((p) => [`${p.category}: "${p.shorter}" vs "${p.longer}"`, p] as const))(
        "%s should flag the longer phrase",
        (_label, { longer, entry }) => {
            const full = compileStyleMatcher(LISTS, {
                fillers: true, redundancies: true, cliches: true,
                wordiness: true, aiVocabulary: true, aiArtifacts: true,
            });
            // Oracle: what the matcher does when the longer phrase is the only
            // candidate. Picking the shorter one instead cannot produce this.
            // The raw ENTRY, not the parsed phrase — several redundancies carry
            // `~~ ~~` markers, and the oracle has to strike the same sub-span.
            const longerOnly = compileStyleMatcher({ fillers: [entry] }, { fillers: true });
            const text = `${CARRIER_PREFIX}${longer} thing.`;

            expect(spansOverPhrase(full(text), longer))
                .toEqual(spansOverPhrase(longerOnly(text), longer));
        },
    );

    it("a capitalized longer phrase should still beat its lowercase prefix", () => {
        // Matching is case-insensitive, so the sort key must be too: ordering by
        // the RAW phrase descending puts "delve" ahead of "Delve Into" ("d" >
        // "D") and the shorter one wins. The shipped lists are all lowercase, so
        // nothing here would catch that regression except this case.
        const matcher = compileStyleMatcher(
            { fillers: ["Delve Into", "delve"] },
            { fillers: true },
        );
        const text = "We delve into it.";

        const matches = matcher(text);

        expect(matches).toHaveLength(1);
        expect(text.slice(matches[0].start, matches[0].end)).toBe("delve into");
    });

    it("a longer phrase should still win from another chunk", () => {
        // Chunks scan independently, so a straddling pair is resolved by
        // leftmostLongest rather than by alternation order. Padding sorts
        // between the two ("pretty" < "pretty a…" < "pretty much") so the pair
        // straddles a chunk boundary under the shipped ordering — asserted
        // below, because padding that stopped straddling would leave this test
        // passing while proving nothing.
        const padding = Array.from(
            { length: MAX_ALTERNATIVES_PER_REGEX },
            (_, i) => `pretty a${String(i).padStart(4, "0")}`,
        );
        const phrases = ["pretty much", ...padding, "pretty"];
        const sources = compileList(phrases).map((r) => r.source);
        const chunkOf = (alternative: string) => sources.findIndex((s) => s.includes(alternative));

        expect(sources.length).toBeGreaterThan(1);
        expect(chunkOf("\\bpretty\\s+much\\b")).toBeGreaterThanOrEqual(0);
        expect(chunkOf("\\bpretty\\b")).toBeGreaterThanOrEqual(0);
        expect(chunkOf("\\bpretty\\s+much\\b")).not.toBe(chunkOf("\\bpretty\\b"));

        const matcher = compileStyleMatcher({ fillers: phrases }, { fillers: true });
        const text = "This is pretty much done.";

        const matches = matcher(text);

        expect(matches).toHaveLength(1);
        expect(text.slice(matches[0].start, matches[0].end)).toBe("pretty much");
    });
});
