import { describe, it, expect } from "vitest";
import { compileStyleMatcher, type StyleCategory } from "../utils/styleMatcher";
import { CLICHES, FILLERS, REDUNDANCIES } from "../proofread/wordlists";

const LISTS = { fillers: FILLERS, redundancies: REDUNDANCIES, cliches: CLICHES };
const ALL_ON = { fillers: true, redundancies: true, cliches: true };

function makeMatcher(enabled = ALL_ON) {
    return compileStyleMatcher(LISTS, enabled);
}

describe("compileStyleMatcher", () => {
    it("a filler word should be matched with correct offsets", () => {
        const matcher = makeMatcher();
        const text = "This is really important.";

        const matches = matcher(text);

        expect(matches).toHaveLength(1);
        expect(matches[0].category).toBe("fillers");
        expect(text.slice(matches[0].start, matches[0].end)).toBe("really");
    });

    it("matching should be case-insensitive", () => {
        const matcher = makeMatcher();

        const matches = matcher("Basically, we agree. REALLY.");

        expect(matches.map((m) => m.category)).toEqual(["fillers", "fillers"]);
    });

    it("a filler inside a longer word should not be matched", () => {
        const matcher = makeMatcher();

        // "very" inside "every", "just" inside "justice"
        const matches = matcher("every justice");

        expect(matches).toHaveLength(0);
    });

    it("a multi-word phrase should be matched across whitespace runs", () => {
        const matcher = makeMatcher();
        const text = "We think outside   the box here.";

        const matches = matcher(text);

        const cliche = matches.find((m) => m.category === "cliches");
        expect(cliche).toBeDefined();
        expect(text.slice(cliche!.start, cliche!.end)).toBe("think outside   the box");
    });

    it("a redundancy phrase should be matched and categorized", () => {
        const matcher = makeMatcher();
        const text = "The end result was fine.";

        const matches = matcher(text);

        expect(matches).toHaveLength(1);
        expect(matches[0].category).toBe("redundancies");
        expect(text.slice(matches[0].start, matches[0].end)).toBe("end result");
    });

    it("a disabled category should produce no matches", () => {
        const matcher = makeMatcher({ fillers: false, redundancies: true, cliches: true });

        const matches = matcher("This is really important.");

        expect(matches).toHaveLength(0);
    });

    it("multiple matches should be sorted by start offset", () => {
        const matcher = makeMatcher();
        const text = "The end result was really a paradigm shift.";

        const matches = matcher(text);

        expect(matches.length).toBeGreaterThanOrEqual(3);
        const starts = matches.map((m) => m.start);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it("empty text should produce no matches", () => {
        const matcher = makeMatcher();

        expect(matcher("")).toHaveLength(0);
    });
});

describe("wordlists", () => {
    it("no phrase should appear in more than one category", () => {
        const seen = new Map<string, StyleCategory>();
        const duplicates: string[] = [];
        for (const [category, list] of Object.entries(LISTS) as Array<[StyleCategory, readonly string[]]>) {
            for (const phrase of list) {
                if (seen.has(phrase)) { duplicates.push(phrase); }
                seen.set(phrase, category);
            }
        }

        expect(duplicates).toEqual([]);
    });

    it("every phrase should be lowercase and trimmed", () => {
        for (const list of Object.values(LISTS)) {
            for (const phrase of list) {
                expect(phrase).toBe(phrase.toLowerCase().trim());
            }
        }
    });
});
