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
 * It asserts only over the PHRASE categories. The structural checks (long
 * sentence, passive, …) read raw markdown here, where the editor reads block
 * text with code excluded — `code-heavy` scores four `longSentences` hits on
 * source the editor never scans. A phrase match does not diverge that way, so it
 * is the part of this matcher that can answer a question about a fixture
 * honestly; the density that includes the structural checks is measured in the
 * browser, where the editor answers it.
 */
import { describe, it, expect } from "vitest";
import { FIXTURES, TYPING_FIXTURES } from "./fixtures.mjs";
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
        // The launch gate can only fail on medium and large (GATED_FIXTURES), so
        // those two are the ones whose decoration cost has to be real.
        for (const name of ["medium", "large"]) {
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
        // code-heavy is highlighter registration, math is the KaTeX path, and
        // link-heavy is the embed recognizer; prose seeded into them would blur
        // what they exist to isolate.
        for (const name of ["code-heavy", "math", "link-heavy"]) {
            expect(match(FIXTURES[name]).length, name).toBe(0);
        }
    });
});
