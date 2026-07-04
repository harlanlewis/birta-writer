/**
 * Unit tests for the math plugin's pure logic: the inline input-rule regex
 * (currency / escaped-dollar guards) and LaTeX language detection.
 */
import { describe, it, expect } from "vitest";
import { INLINE_MATH_RULE_REGEX } from "../plugins/math";
import { normalizeCodeLanguage } from "../codeLanguages";

// The rule fires on the just-typed text before the caret, so simulate that by
// matching the text that would sit before the closing `$`.
function firesOn(textBeforeCaret: string): string | null {
    const m = textBeforeCaret.match(INLINE_MATH_RULE_REGEX);
    return m ? m[1] : null;
}

describe("inline math input-rule regex", () => {
    it("a delimited formula with non-space edges should convert", () => {
        expect(firesOn("$E=mc^2$")).toBe("E=mc^2");
    });

    it("a formula containing inner spaces should still convert", () => {
        expect(firesOn("$a + b$")).toBe("a + b");
    });

    it("a single-character formula should convert", () => {
        expect(firesOn("$x$")).toBe("x");
    });

    it("currency like '$5 and $10' should NOT convert (trailing space edge)", () => {
        // Typing the closing `$` of the pair leaves "...5 and $" before caret.
        expect(firesOn("it costs $5 and $")).toBeNull();
    });

    it("an escaped dollar '\\$5$' should NOT convert (backslash lookbehind)", () => {
        expect(firesOn("price \\$5$")).toBeNull();
    });

    it("a leading-space inner like '$ x$' should NOT convert", () => {
        expect(firesOn("$ x$")).toBeNull();
    });

    it("a trailing-space inner like '$x $' should NOT convert", () => {
        expect(firesOn("$x $")).toBeNull();
    });

    it("a block-math opener '$$x$' should NOT convert as inline ($$ lookbehind)", () => {
        expect(firesOn("$$x$")).toBeNull();
    });
});

describe("LaTeX code language detection", () => {
    it("the 'LaTeX' label should normalize to 'latex'", () => {
        expect(normalizeCodeLanguage("LaTeX")).toBe("latex");
    });

    it("the 'tex' alias should normalize to 'latex'", () => {
        expect(normalizeCodeLanguage("tex")).toBe("latex");
    });

    it("an unrelated language should not normalize to 'latex'", () => {
        expect(normalizeCodeLanguage("python")).not.toBe("latex");
    });
});
