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
});
