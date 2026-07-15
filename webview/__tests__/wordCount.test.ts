import { describe, it, expect } from "vitest";
import { countText, EMPTY_TEXT_COUNT } from "../utils/wordCount";

describe("countText", () => {
    describe("Latin text", () => {
        it("empty text should count as zero words, characters, and reading time", () => {
            expect(countText("")).toEqual({ words: 0, characters: 0, readingTimeMinutes: 0 });
        });

        it("whitespace-only text should count as zero", () => {
            expect(countText("   \n\t  ")).toEqual({ words: 0, characters: 0, readingTimeMinutes: 0 });
        });

        it("a simple sentence should count words and non-whitespace characters", () => {
            const result = countText("Hello world");
            expect(result.words).toBe(2);
            expect(result.characters).toBe(10); // "Helloworld" — spaces excluded
        });

        it("collapsed and irregular whitespace should not inflate the word count", () => {
            expect(countText("a\n\nb  c\t d").words).toBe(4);
        });

        it("numbers should count as words", () => {
            expect(countText("3 apples and 12 oranges").words).toBe(5);
        });

        it("an apostrophe should keep a contraction as a single word", () => {
            expect(countText("don't stop believing").words).toBe(3);
        });
    });

    describe("punctuation", () => {
        it("trailing punctuation should not add extra words", () => {
            const result = countText("Hello, world!");
            expect(result.words).toBe(2);
            expect(result.characters).toBe(12); // "Hello,world!"
        });

        it("punctuation-only tokens should count as zero words", () => {
            expect(countText("--- ... , ;").words).toBe(0);
        });

        it("a hyphenated word joined by a hyphen should count as one word", () => {
            expect(countText("well-known author").words).toBe(2);
        });
    });

    describe("CJK text", () => {
        it("Chinese characters should each count as one word", () => {
            const result = countText("你好世界");
            expect(result.words).toBe(4);
            expect(result.characters).toBe(4);
        });

        it("Japanese kana should each count as one word", () => {
            expect(countText("こんにちは").words).toBe(5);
        });

        it("Hangul syllables should each count as one word", () => {
            expect(countText("안녕하세요").words).toBe(5);
        });

        it("an astral CJK Extension B ideograph should count as one word", () => {
            // U+20000 is a surrogate pair; code-point iteration must treat it as one CJK char.
            const result = countText("\u{20000}");
            expect(result.words).toBe(1);
            expect(result.characters).toBe(1);
        });
    });

    describe("mixed CJK and Latin", () => {
        it("a space-separated mix should sum Latin words and CJK characters", () => {
            const result = countText("Hello 世界");
            expect(result.words).toBe(3); // 1 Latin word + 2 CJK chars
            expect(result.characters).toBe(7); // "Hello" (5) + 世界 (2)
        });

        it("a CJK character should terminate an adjacent Latin word with no space", () => {
            expect(countText("abc你好").words).toBe(3); // "abc" + 你 + 好
        });
    });

    describe("reading time", () => {
        it("any non-empty content should round up to at least one minute", () => {
            expect(countText("Hello world").readingTimeMinutes).toBe(1);
        });

        it("exactly one minute of Latin words should stay at one minute", () => {
            const text = Array.from({ length: 238 }, () => "word").join(" ");
            expect(countText(text).readingTimeMinutes).toBe(1);
        });

        it("just over one minute of Latin words should round up to two minutes", () => {
            const text = Array.from({ length: 239 }, () => "word").join(" ");
            expect(countText(text).readingTimeMinutes).toBe(2);
        });

        it("exactly one minute of CJK characters should stay at one minute", () => {
            expect(countText("字".repeat(260)).readingTimeMinutes).toBe(1);
        });

        it("just over one minute of CJK characters should round up to two minutes", () => {
            expect(countText("字".repeat(261)).readingTimeMinutes).toBe(2);
        });
    });

    describe("selection subsets", () => {
        it("counting a substring should reflect only that range", () => {
            const full = "The quick brown fox jumps";
            expect(countText(full).words).toBe(5);
            expect(countText(full.slice(0, "The quick".length)).words).toBe(2);
        });
    });

    it("EMPTY_TEXT_COUNT should match counting an empty string", () => {
        expect(EMPTY_TEXT_COUNT).toEqual(countText(""));
    });

    /**
     * `countText` classifies whitespace from a hand-rolled numeric table rather
     * than a per-character `/\s/` test, because the regex dominated the cost of
     * counting a large document. A hand-rolled Unicode table silently drifts
     * from the spec, so these sweep every code point and hold it to the regex —
     * `characters` counts a code point exactly when `/\s/` does not match it.
     */
    describe("whitespace classification matches /\\s/", () => {
        it("every BMP code point should be counted as a character exactly when it is not whitespace", () => {
            const mismatches: string[] = [];
            for (let cp = 0; cp <= 0xffff; cp++) {
                if (cp >= 0xd800 && cp <= 0xdfff) { continue; } // lone surrogates: covered below
                const ch = String.fromCodePoint(cp);
                const expected = /\s/.test(ch) ? 0 : 1;
                if (countText(ch).characters !== expected) {
                    mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
                }
            }
            expect(mismatches).toEqual([]);
        });

        it("astral code points should all count as one non-whitespace character", () => {
            // No astral code point is `\s`, and each surrogate pair must decode
            // to exactly one character rather than counting its two code units.
            const mismatches: string[] = [];
            for (let cp = 0x10000; cp <= 0x10ffff; cp += 37) {
                if (countText(String.fromCodePoint(cp)).characters !== 1) {
                    mismatches.push(`U+${cp.toString(16).toUpperCase()}`);
                }
            }
            expect(mismatches).toEqual([]);
        });

        it("an unpaired surrogate should count as a single character", () => {
            expect(countText("\ud800").characters).toBe(1);
            expect(countText("\udc00").characters).toBe(1);
            expect(countText("a\ud800b").characters).toBe(3);
        });
    });
});
