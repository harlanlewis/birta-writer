import { describe, it, expect } from "vitest";
import { compileStyleMatcher, findRepeatedWords, type StyleCategory } from "../utils/styleMatcher";
import { CLICHES, FILLERS, REDUNDANCIES } from "../proofread/wordlists";

const LISTS = { fillers: FILLERS, redundancies: REDUNDANCIES, cliches: CLICHES };
const ALL_ON = { fillers: true, redundancies: true, cliches: true };

function makeMatcher(enabled = ALL_ON, exceptions: string[] = []) {
    return compileStyleMatcher(LISTS, enabled, exceptions);
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

    it("an excepted phrase should not be matched", () => {
        const matcher = makeMatcher(ALL_ON, ["really", "End Result"]);

        expect(matcher("This is really the end result.")).toHaveLength(0);
    });

    it("comparative 'rather than' should not be flagged", () => {
        const matcher = makeMatcher();

        expect(matcher("They buy the tooling rather than build it.")).toHaveLength(0);
    });

    it("preferential 'would rather' should not be flagged", () => {
        const matcher = makeMatcher();

        expect(matcher("I would rather go home.")).toHaveLength(0);
    });

    it("hedging 'rather' should still be flagged", () => {
        const matcher = makeMatcher();
        const text = "The result was rather good.";

        const matches = matcher(text);

        expect(matches).toHaveLength(1);
        expect(text.slice(matches[0].start, matches[0].end)).toBe("rather");
    });

    it("a phrase with an apostrophe should match its typographic form in text", () => {
        const matcher = makeMatcher();

        // List entry: "all in a day's work" (ASCII '), text uses U+2019
        const text = "It was all in a day’s work.";
        const matches = matcher(text);

        expect(matches).toHaveLength(1);
        expect(text.slice(matches[0].start, matches[0].end)).toBe("all in a day’s work");
    });
});

describe("findRepeatedWords", () => {
    it("an accidentally repeated word should flag only the second occurrence", () => {
        const text = "We saw the the dog.";

        const matches = findRepeatedWords(text);

        expect(matches).toHaveLength(1);
        expect(matches[0].category).toBe("repeated");
        expect(text.slice(matches[0].start, matches[0].end)).toBe("the");
        expect(matches[0].start).toBe(11); // the second "the"
    });

    it("a repetition across a case difference should be matched", () => {
        const text = "The the dog barked.";

        const matches = findRepeatedWords(text);

        expect(matches).toHaveLength(1);
        expect(text.slice(matches[0].start, matches[0].end)).toBe("the");
    });

    it("legitimate doubles like 'had had' should not be flagged", () => {
        expect(findRepeatedWords("She had had enough.")).toHaveLength(0);
        expect(findRepeatedWords("He knew that that was wrong.")).toHaveLength(0);
    });

    it("repeated numbers should not be flagged", () => {
        expect(findRepeatedWords("rows 5 5 and 6")).toHaveLength(0);
    });

    it("a triple repetition should flag each extra occurrence", () => {
        const matches = findRepeatedWords("the the the end");

        expect(matches).toHaveLength(2);
    });

    it("different words should not be flagged", () => {
        expect(findRepeatedWords("the theory holds")).toHaveLength(0);
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
