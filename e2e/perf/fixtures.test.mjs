/**
 * The prose fixtures must actually trip the style check.
 *
 * They did not. `birta.proofreading.enabled` defaults to `true`, so every
 * measured launch paid a proofread scan — but no fixture contained a phrase the
 * shipped word lists match, and `medium` produced **0** `.pf-style-hit`
 * elements. The harness therefore measured the matcher's traversal of prose that
 * matches nothing, and never the decoration build, which is the half that scales
 * with how much a real document trips (MAR-310).
 *
 * This is the browser-free half of the guard: it runs the fixtures through the
 * SAME matcher the editor compiles, so a word list edited out from under a
 * seeded phrase fails here rather than quietly returning the fixtures to zero.
 * `checks.mjs` drives the real bundle and counts the decorations that result.
 *
 * It enables only the PHRASE categories. The structural checks (long sentence,
 * passive, …) read raw markdown here, where the editor reads block text with
 * code excluded — `code-heavy` scores four `longSentences` hits on source the
 * editor never scans. A phrase match does not diverge that way, so it is the
 * part of this matcher that can answer a question about a fixture honestly; the
 * density that includes the structural checks is measured in the browser, where
 * the editor answers it.
 *
 * ONE structural check arrives anyway: `repeated` rides the style-check master
 * switch and `compileStyleMatcher` appends it unconditionally, so the enabled
 * map cannot turn it off. It reads raw markdown here like the others, which
 * means an HTML attribute can trip it (`class="callout callout-1"` is a doubled
 * word to the regex and nothing at all to a reader). Expect it in a zero
 * assertion below, and fix the fixture rather than the assertion.
 */
import { describe, it, expect } from "vitest";
import { FIXTURES, TYPING_FIXTURES } from "./fixtures.mjs";
import { GATED_FIXTURES } from "./verdict.mjs";
import { compileStyleMatcher } from "../../webview/utils/styleMatcher.ts";
import {
    AI_ARTIFACTS,
    AI_VOCABULARY,
    CLICHES,
    FILLERS,
    REDUNDANCIES,
    WORDINESS,
} from "../../webview/proofread/wordlists.ts";

const PHRASE_LISTS = {
    fillers: FILLERS,
    redundancies: REDUNDANCIES,
    cliches: CLICHES,
    wordiness: WORDINESS,
    aiVocabulary: AI_VOCABULARY,
    aiArtifacts: AI_ARTIFACTS,
};

const match = compileStyleMatcher(
    PHRASE_LISTS,
    Object.fromEntries(Object.keys(PHRASE_LISTS).map((c) => [c, true])),
);

/** The fixtures whose job is realistic prose. The rest isolate other paths. */
const PROSE_FIXTURES = ["tiny", "medium", "large"];

// The seeded fixtures land one phrase hit per ~181 source characters (2026-08-04:
// medium 69/12526, large 540/97452, xlarge 1713/311884). The floor sits at less
// than half that, so a word-list edit that drops one seeded phrase does not turn
// this red, while halving the seeding does.
//
// The counts above are a record, not a reading — re-measure before quoting them.
// The ratio is what this gate rests on, and it survives a fixture resize, so
// stale absolute figures here go unnoticed by every assertion in the file.
const MAX_CHARS_PER_HIT = 400;

describe("launch-perf prose fixtures", () => {
    it.each(PROSE_FIXTURES)("%s should trip the style check", (name) => {
        expect(match(FIXTURES[name]).length).toBeGreaterThan(0);
    });

    it("the gated fixtures should trip at a density a real document reaches", () => {
        // The launch gate can only fail on GATED_FIXTURES, so those are the
        // ones whose decoration cost has to be real. Iterated from the gate's
        // own set so a fixture added to the gate cannot skip this bar.
        for (const name of GATED_FIXTURES) {
            const hits = match(FIXTURES[name]).length;
            expect(hits, `${name}: ${hits} phrase hits in ${FIXTURES[name].length} chars`)
                .toBeGreaterThan(FIXTURES[name].length / MAX_CHARS_PER_HIT);
        }
    });

    it("the seeded prose should exercise several categories, not one regex repeatedly", () => {
        // A single filler repeated 140 times would satisfy a hit count while
        // exercising one alternation regex and one decoration shape. The cost
        // being measured is the mix.
        const categories = new Set(match(FIXTURES.large).map((m) => m.category));
        expect([...categories].sort()).toEqual([
            "aiArtifacts", "aiVocabulary", "cliches", "fillers", "redundancies", "wordiness",
        ]);
    });

    it("xlarge should inherit the seeding, so the typing gate rescans real findings", () => {
        // The typing gate's only gated fixture is xlarge, and the proofread
        // rescan runs on every doc change. It is built from the same sections,
        // so this holds by construction — asserted because the construction is
        // what a future refactor would break.
        expect(match(TYPING_FIXTURES.xlarge).length).toBeGreaterThan(0);
    });

    it("the non-prose fixtures should stay unseeded, so they keep isolating their own path", () => {
        // code-heavy is highlighter registration, math is the KaTeX path,
        // link-heavy is the embed recognizer and html-heavy is the html
        // NodeView; prose seeded into any of them would blur what it exists to
        // isolate.
        //
        // DERIVED from the fixture set rather than listed, so a fixture added
        // later cannot skip this bar. `realistic` is seeded on purpose and is
        // the one non-prose fixture that must be excluded by name.
        const isolating = Object.keys(FIXTURES).filter(
            (n) => !PROSE_FIXTURES.includes(n) && n !== "realistic",
        );
        expect(isolating.length, "isolating fixtures enumerated").toBeGreaterThan(0);
        for (const name of isolating) {
            expect(match(FIXTURES[name]).length, name).toBe(0);
        }
    });
});
