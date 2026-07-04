import { describe, it, expect } from "vitest";
import { INLINE_PLACEHOLDER, isTechSpan } from "../proofreadFilter";

function spanOf(text: string, target: string): [number, number] {
    const start = text.indexOf(target);
    return [start, start + target.length];
}

describe("isTechSpan", () => {
    it("a plain prose word should not be tech", () => {
        const text = "This is a sentance with a typo.";

        expect(isTechSpan(text, ...spanOf(text, "sentance"))).toBe(false);
    });

    it("a word inside a file path should be tech", () => {
        const text = "Open src/utils/lineMap.ts and check.";

        expect(isTechSpan(text, ...spanOf(text, "src"))).toBe(true);
        expect(isTechSpan(text, ...spanOf(text, "ts"))).toBe(true);
    });

    it("a camelCase identifier should be tech", () => {
        const text = "The getEditorView helper returns the view.";

        expect(isTechSpan(text, ...spanOf(text, "getEditorView"))).toBe(true);
    });

    it("an ALL-CAPS token should be tech", () => {
        const text = "The VSCode API uses this.";

        expect(isTechSpan(text, ...spanOf(text, "VSCode"))).toBe(true);
    });

    it("a token with digits should be tech", () => {
        const text = "Use es2020 syntax here.";

        expect(isTechSpan(text, ...spanOf(text, "es2020"))).toBe(true);
    });

    it("a domain should be tech even with trailing sentence punctuation", () => {
        const text = "Visit exmaple.com. This ends.";

        expect(isTechSpan(text, ...spanOf(text, "exmaple"))).toBe(true);
        expect(isTechSpan(text, ...spanOf(text, "ends"))).toBe(false);
    });

    it("a chunk containing an inline-node placeholder should be tech", () => {
        const text = `before ${INLINE_PLACEHOLDER}word end`;

        expect(isTechSpan(text, ...spanOf(text, "word"))).toBe(true);
    });

    it("a capitalized sentence-start word should not be tech", () => {
        const text = "Recieve the goods.";

        expect(isTechSpan(text, ...spanOf(text, "Recieve"))).toBe(false);
    });

    it("a multi-word span should not be vetoed by the identifier test", () => {
        const text = "this are a grammar error here.";

        expect(isTechSpan(text, ...spanOf(text, "this are"))).toBe(false);
    });
});
