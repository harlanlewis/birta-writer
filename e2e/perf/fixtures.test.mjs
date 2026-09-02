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
import { FIXTURES, TYPING_FIXTURES, HEAVY_FIXTURES } from "./fixtures.mjs";
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

/** Every fixture this module exports, under any of its three names. */
const ALL_FIXTURES = { ...FIXTURES, ...TYPING_FIXTURES, ...HEAVY_FIXTURES };

/**
 * The partition, DECLARED rather than derived, and checked against the exports
 * below. Deriving one side from the other would make the check a tautology:
 * every fixture leaves through exactly one branch of a filter the test itself
 * writes, so a fixture nobody classified still passes.
 *
 * Seeded fixtures must trip the style check; isolating ones must not, so each
 * keeps isolating the single path it exists for.
 */
const SEEDED = new Set(["tiny", "medium", "large", "xlarge", "realistic", "huge-outline"]);
const ISOLATING = new Set(["code-heavy", "math", "link-heavy", "html-heavy"]);

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
    /**
     * The bar above is only a bar for the fixtures something enumerates, and
     * every enumeration in this file used to read `FIXTURES` alone. A fixture
     * exported under any other name was therefore covered by nothing, silently:
     * `xlarge` sat in `TYPING_FIXTURES` and was reached only by one case that
     * names it, and `HEAVY_FIXTURES` would have added two more the day it
     * landed. That is the absent-guard shape, not a wrong one, so no green run
     * would ever have reported it.
     *
     * This is the check that cannot be escaped by adding a fixture: the union
     * of the three exports must equal the union of the two declared classes, so
     * a new fixture fails here until somebody decides which bar it takes.
     */
    it("every exported fixture should be declared seeded or isolating", () => {
        // The floor first. Equality between two empty lists is true, and the
        // two `it.each` blocks below over an empty set run no cases and pass,
        // so a module that stopped exporting fixtures would satisfy this whole
        // describe having compared nothing. That is the shape this file exists
        // to catch one construct over.
        expect(Object.keys(ALL_FIXTURES).length, "fixtures exported").toBeGreaterThanOrEqual(10);
        const declared = [...SEEDED, ...ISOLATING].sort();
        expect(Object.keys(ALL_FIXTURES).sort()).toEqual(declared);
    });

    it.each([...SEEDED])("%s should trip the style check", (name) => {
        expect(match(ALL_FIXTURES[name]).length).toBeGreaterThan(0);
    });

    it.each([...ISOLATING])("%s should stay unseeded, so it keeps isolating its own path", (name) => {
        expect(match(ALL_FIXTURES[name]).length).toBe(0);
    });

    /**
     * `huge-outline` is not gated, and takes the gated fixtures' phrase density
     * anyway. The density bar exists because proofreading ships on and its scan
     * is one of the post-paint spans, so a fixture built to expose chokepoints
     * has to trip at a rate a real document reaches or the scan it is measuring
     * is the traversal half only (MAR-310).
     */
    it("huge-outline should trip at the same density as the gated fixtures", () => {
        const doc = HEAVY_FIXTURES["huge-outline"];
        const hits = match(doc).length;
        expect(hits, `${hits} phrase hits in ${doc.length} chars`)
            .toBeGreaterThan(doc.length / MAX_CHARS_PER_HIT);
    });

    /**
     * A FIXTURE'S IDENTITY IS ITS SIZE, and `huge-outline`'s identity is also
     * its outline. It stands in for a real 765 KB working file, and the three
     * figures below are the ones that make it that document rather than a large
     * one: its size, its heading count (what the mount-time id work scales
     * with) and its list density. A section edited without re-deriving the
     * section count fails here rather than quietly producing a different
     * document that every later measurement is taken against.
     *
     * Counted off the SOURCE on purpose. This is a drift alarm on the
     * generator, and the constructs it must not contain are asserted through
     * the real parser instead, in webview/__tests__/perfFixtureConstructs.test.ts,
     * because that is a question source bytes cannot answer.
     */
    it("huge-outline should hold the size and outline it stands in for", () => {
        const doc = HEAVY_FIXTURES["huge-outline"];
        const lines = doc.split("\n");
        const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
        const items = lines.filter((l) => /^[-*+]\s/.test(l)).length;
        const kb = doc.length / 1024;

        expect(kb, `${Math.round(kb)} KB`).toBeGreaterThan(700);
        expect(kb, `${Math.round(kb)} KB`).toBeLessThan(830);
        expect(headings).toBeGreaterThan(400);
        expect(items / headings, "list items per heading").toBeGreaterThan(5);

        // Across three levels, so the outline has depth for the TOC to build
        // from and the id pass has more than one heading type to walk.
        const levels = new Set(lines.flatMap((l) => {
            const m = /^(#{1,6})\s/.exec(l);
            return m ? [m[1].length] : [];
        }));
        expect([...levels].sort()).toEqual([1, 2, 3, 4]);
    });

    /**
     * `headingIdAssigner`'s `-#N` dedup counter only runs when two headings
     * slug the same, and every other fixture numbers its headings uniquely, so
     * nothing here exercised it at scale. A working document repeats section
     * titles constantly, which is the property this asserts.
     */
    it("huge-outline should repeat heading text, so the id dedup counter runs", () => {
        const titles = HEAVY_FIXTURES["huge-outline"]
            .split("\n")
            .flatMap((l) => {
                const m = /^#{1,6}\s+(.*)$/.exec(l);
                return m ? [m[1]] : [];
            });
        const counts = new Map();
        for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
        const repeated = [...counts.values()].filter((n) => n > 1);
        expect(repeated.length, "distinct titles that repeat").toBeGreaterThan(5);
        expect(Math.max(...repeated), "deepest dedup suffix reached").toBeGreaterThan(20);
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

});
