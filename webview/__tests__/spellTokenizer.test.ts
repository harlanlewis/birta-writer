import { describe, it, expect } from "vitest";
import { extractWordTokens, INLINE_PLACEHOLDER } from "../utils/spellTokenizer";

describe("extractWordTokens", () => {
    it("plain prose should yield each word with correct offsets", () => {
        const text = "The quick brown fox";

        const tokens = extractWordTokens(text);

        expect(tokens.map((t) => t.word)).toEqual(["The", "quick", "brown", "fox"]);
        for (const token of tokens) {
            expect(text.slice(token.start, token.end)).toBe(token.word);
        }
    });

    it("a URL should be skipped entirely", () => {
        const tokens = extractWordTokens("see https://exmaple.com/path for details");

        expect(tokens.map((t) => t.word)).toEqual(["see", "for", "details"]);
    });

    it("an e-mail address should be skipped entirely", () => {
        const tokens = extractWordTokens("mail me at someoen@example.com today");

        expect(tokens.map((t) => t.word)).toEqual(["mail", "me", "at", "today"]);
    });

    it("a file path should be skipped entirely", () => {
        const tokens = extractWordTokens("open src/utils/lineMap.ts and check");

        expect(tokens.map((t) => t.word)).toEqual(["open", "and", "check"]);
    });

    it("a domain-like word should be skipped, but sentence-ending punctuation should not veto a word", () => {
        const tokens = extractWordTokens("Visit exmaple.com. This ends here.");

        expect(tokens.map((t) => t.word)).toEqual(["Visit", "This", "ends", "here"]);
    });

    it("camelCase and PascalCase identifiers should be skipped", () => {
        const tokens = extractWordTokens("ProseMirror uses camelCase names");

        expect(tokens.map((t) => t.word)).toEqual(["uses", "names"]);
    });

    it("ALL-CAPS acronyms should be skipped", () => {
        const tokens = extractWordTokens("NASA and API are acronyms");

        expect(tokens.map((t) => t.word)).toEqual(["and", "are", "acronyms"]);
    });

    it("words containing digits should be skipped", () => {
        const tokens = extractWordTokens("es2020 syntax and 3rd party");

        expect(tokens.map((t) => t.word)).toEqual(["syntax", "and", "party"]);
    });

    it("typographic apostrophes should be normalized to ASCII", () => {
        const tokens = extractWordTokens("don’t worry");

        expect(tokens.map((t) => t.word)).toEqual(["don't", "worry"]);
    });

    it("non-Latin words should be skipped, never flagged", () => {
        const tokens = extractWordTokens("汉字 mixed with café and prose");

        expect(tokens.map((t) => t.word)).toEqual(["mixed", "with", "and", "prose"]);
    });

    it("chunks containing inline-node placeholders should be skipped", () => {
        const tokens = extractWordTokens(`before ${INLINE_PLACEHOLDER}after end`);

        expect(tokens.map((t) => t.word)).toEqual(["before", "end"]);
    });

    it("single letters should be skipped", () => {
        const tokens = extractWordTokens("a I x word");

        expect(tokens.map((t) => t.word)).toEqual(["word"]);
    });

    it("a trailing possessive apostrophe should be trimmed from the token", () => {
        const text = "the dogs' bones";

        const tokens = extractWordTokens(text);

        expect(tokens.map((t) => t.word)).toEqual(["the", "dogs", "bones"]);
        const dogs = tokens[1];
        expect(text.slice(dogs.start, dogs.end)).toBe("dogs");
    });

    it("inline-code masked with spaces should yield no tokens", () => {
        const tokens = extractWordTokens("run   " + "     " + "   now");

        expect(tokens.map((t) => t.word)).toEqual(["run", "now"]);
    });
});
