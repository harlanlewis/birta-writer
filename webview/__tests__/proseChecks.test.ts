import { describe, it, expect } from "vitest";
import {
    findPassiveVoice,
    findLongSentences,
    findNegativeParallelism,
    findRuleOfThree,
    findEmDash,
    findNonAsciiPunct,
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
