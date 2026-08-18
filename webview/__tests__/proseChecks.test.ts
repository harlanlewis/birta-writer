import { describe, it, expect } from "vitest";
import {
    findPassiveVoice,
    findLongSentences,
    findNegativeParallelism,
    findRuleOfThree,
    findEmDash,
    findNonAsciiPunct,
    findAbsolutePerfClaims,
    findUniformRhythm,
} from "../utils/proseChecks";

function flagged(text: string, fn: (t: string) => { start: number; end: number }[]): string[] {
    return fn(text).map((m) => text.slice(m.start, m.end));
}

describe("findPassiveVoice", () => {
    it("flags be-verb + regular past participle", () => {
        expect(flagged("The doc was written last night.", findPassiveVoice)).toEqual(["was written"]);
    });

    it("flags be-verb + irregular participle", () => {
        expect(flagged("The work is done.", findPassiveVoice)).toEqual(["is done"]);
    });

    it("skips an intervening adverb", () => {
        expect(flagged("It was quickly reviewed.", findPassiveVoice)).toEqual(["was quickly reviewed"]);
    });

    it("does not flag be-verb + adjective", () => {
        expect(findPassiveVoice("The sky is blue.")).toHaveLength(0);
    });

    it("does not flag a short -ed word like 'red'", () => {
        expect(findPassiveVoice("The light is red.")).toHaveLength(0);
    });

    it("does not flag emotion/predicate adjectives", () => {
        expect(findPassiveVoice("I was tired.")).toHaveLength(0);
        expect(findPassiveVoice("She is interested.")).toHaveLength(0);
        expect(findPassiveVoice("We are pleased.")).toHaveLength(0);
    });

    // The raw regex still over-flags correct copular/locative English — a flat
    // pattern can't tell these from real passives. This documented over-flag is
    // why the passive check ships OFF by default (see styleMatcher.test.ts for
    // the on-by-default guarantee).
    it("over-flags copular/locative English at the raw-function level", () => {
        expect(flagged("She was born in 1990.", findPassiveVoice)).toEqual(["was born"]);
        expect(flagged("The file is located in /tmp.", findPassiveVoice)).toEqual(["is located"]);
    });
});

describe("findLongSentences", () => {
    it("flags a sentence over the threshold", () => {
        const text = Array.from({ length: 32 }, (_, i) => `word${i}`).join(" ") + ".";
        const hits = findLongSentences(text);
        expect(hits).toHaveLength(1);
        expect(hits[0].category).toBe("longSentences");
    });

    it("does not flag a short sentence", () => {
        expect(findLongSentences("Short and sweet.")).toHaveLength(0);
    });

    it("respects a custom threshold", () => {
        expect(findLongSentences("one two three four five.", 3)).toHaveLength(1);
        expect(findLongSentences("one two three four five.", 10)).toHaveLength(0);
    });
});

describe("findNegativeParallelism", () => {
    it("flags 'not just X but Y'", () => {
        expect(flagged("It is not just fast but cheap.", findNegativeParallelism))
            .toEqual(["not just fast but"]);
    });

    it("flags \"it's not X, it's Y\"", () => {
        const hits = flagged("It's not a bug, it's a feature.", findNegativeParallelism);
        expect(hits[0]).toContain("not a bug, it's");
    });

    it("does not flag a plain 'not' sentence", () => {
        expect(findNegativeParallelism("This is not correct.")).toHaveLength(0);
    });

    it("does not flag ordinary 'it's not X, but Y' contrast", () => {
        expect(findNegativeParallelism("It's not ready, but we'll ship it.")).toHaveLength(0);
    });

    it("de-duplicates overlapping matches", () => {
        // Only one construction; must not double-count.
        expect(findNegativeParallelism("It is not just X but Y.")).toHaveLength(1);
    });

    // Pattern 1 has no echo guard, so the raw regex over-flags the ordinary
    // correlative conjunction "not only X but also Y". This documented over-flag
    // is why the check ships OFF by default (see styleMatcher.test.ts for the
    // on-by-default guarantee).
    it("over-flags the correct correlative 'not only ... but also' at the raw-function level", () => {
        expect(flagged("The API is not only fast but also safe.", findNegativeParallelism))
            .toEqual(["not only fast but also"]);
    });
});

describe("findRuleOfThree", () => {
    it("flags three stacked adjectives", () => {
        expect(flagged("It was fast, cheap, and reliable.", findRuleOfThree))
            .toEqual(["fast, cheap, and reliable"]);
    });

    it("does not flag a plain noun list", () => {
        expect(findRuleOfThree("apples, oranges, and bananas")).toHaveLength(0);
    });
});

describe("findEmDash", () => {
    it("flags an em dash and an en dash", () => {
        const hits = findEmDash("a—b and c–d");
        expect(hits).toHaveLength(2);
        expect(hits[0].category).toBe("emDash");
    });

    it("ignores an ASCII hyphen", () => {
        expect(findEmDash("a - b")).toHaveLength(0);
    });
});

describe("findNonAsciiPunct", () => {
    it("flags curly quotes and the ellipsis glyph", () => {
        const hits = findNonAsciiPunct("“hi”…");
        expect(hits).toHaveLength(3);
        expect(hits[0].category).toBe("nonAsciiPunct");
    });

    it("flags a non-breaking space", () => {
        expect(findNonAsciiPunct("a b")).toHaveLength(1);
    });

    it("ignores straight quotes and the inline placeholder", () => {
        expect(findNonAsciiPunct("\"hi\" and ￼")).toHaveLength(0);
    });

    it("leaves dashes to findEmDash", () => {
        expect(findNonAsciiPunct("a—b")).toHaveLength(0);
    });
});

describe("findAbsolutePerfClaims", () => {
    it("an absolute word followed by a performance word should flag the claim span", () => {
        expect(flagged("Typing in a long document no longer stutters on save.", findAbsolutePerfClaims))
            .toEqual(["no longer stutters"]);
        expect(flagged("The outline opens with zero latency now.", findAbsolutePerfClaims))
            .toEqual(["zero latency"]);
    });

    it("an absolute claim about correctness should not be flagged", () => {
        // Same grammar, opposite verifiability: this one reproduces or it does not.
        expect(findAbsolutePerfClaims("Saving no longer corrupts the file.")).toEqual([]);
        expect(findAbsolutePerfClaims("The tab never loses your edits.")).toEqual([]);
    });

    it("the two halves should not span a sentence boundary", () => {
        expect(findAbsolutePerfClaims("It never fails. The old build was slow.")).toEqual([]);
    });

    it("a block carrying two figures (a before and an after) should not be flagged", () => {
        const carried = "Selecting a block no longer stalls: about 170 ms on a 300 KB file, now under 5 ms.";
        expect(findAbsolutePerfClaims(carried)).toEqual([]);
    });

    it("one figure is not a before and after, so the claim should still be flagged", () => {
        expect(flagged("Selecting a block no longer stalls on a 300 KB file.", findAbsolutePerfClaims))
            .toEqual(["no longer stalls"]);
    });

    it("a digit run inside a word or a version segment should not count as a figure", () => {
        // "v1.2.3" is one figure to the reader; "utf8" is none.
        expect(flagged("Since v1.2.3 utf8 files no longer freeze the editor.", findAbsolutePerfClaims))
            .toEqual(["no longer freeze"]);
    });

    it("the category should be absolutePerf and matching case-insensitive", () => {
        const hits = findAbsolutePerfClaims("Zero jank when scrolling.");
        expect(hits).toHaveLength(1);
        expect(hits[0].category).toBe("absolutePerf");
    });
});

describe("findUniformRhythm", () => {
    // Four sentences of 9, 9, 9 and 10 words: the default machine cadence.
    const even =
        "Testing plays a critical role in maintaining software quality. " +
        "Unit tests verify that individual components behave as expected. " +
        "Integration tests confirm that those components work together correctly. " +
        "End-to-end tests validate the entire system from the perspective of users.";
    // The same content with one long sentence and one short one.
    const varied =
        "Testing plays a critical role in maintaining software quality, and the role changes shape as a project grows from a script into something other people depend on. " +
        "Unit tests verify components. " +
        "Integration tests confirm that those components work together correctly. " +
        "End-to-end tests validate the entire system from the perspective of users.";

    it("a paragraph of evenly long sentences should be flagged whole", () => {
        expect(flagged(even, findUniformRhythm)).toEqual([even]);
        expect(findUniformRhythm(even)[0].category).toBe("rhythm");
    });

    it("a paragraph with one long and one short sentence should not be flagged", () => {
        expect(findUniformRhythm(varied)).toEqual([]);
    });

    it("fewer than four sentences should never qualify, however even", () => {
        const three = "One two three four five six seven eight nine. " +
            "One two three four five six seven eight nine. " +
            "One two three four five six seven eight nine.";
        expect(findUniformRhythm(three)).toEqual([]);
    });

    it("short fragments should never qualify, however even", () => {
        // Four fragments of three words: a list read as prose, not a cadence.
        expect(findUniformRhythm("Save the file. Close the tab. Open it again. Read it back.")).toEqual([]);
    });

    it("the flagged span should trim surrounding whitespace, not the sentences' own", () => {
        const padded = `  ${even}  `;
        const [hit] = findUniformRhythm(padded);
        expect(padded.slice(hit.start, hit.end)).toBe(even);
    });

    it("the variation threshold should be the discriminating line", () => {
        // 10, 10, 10, 10 words: no variation at all.
        const flat = Array(4).fill("one two three four five six seven eight nine ten.").join(" ");
        expect(findUniformRhythm(flat)).toHaveLength(1);
        // Tightening the threshold to zero admits only that exact case;
        // widening it past the varied paragraph's spread flags it too.
        expect(findUniformRhythm(even, { maxVariation: 0 })).toEqual([]);
        expect(findUniformRhythm(varied, { maxVariation: 2 })).toHaveLength(1);
    });
});
