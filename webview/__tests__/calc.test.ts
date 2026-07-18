/**
 * Unit tests for the inline-calc engine (webview/utils/calc.ts): the safe
 * arithmetic evaluator, the result formatter, and the deliberately-narrow
 * caret detection that keeps ordinary prose containing `=` from being
 * hijacked. Pure functions — no editor, no DOM.
 */
import { describe, it, expect } from "vitest";
import {
    evaluateExpression,
    formatCalcResult,
    detectCalcExpression,
} from "../utils/calc";

describe("evaluateExpression", () => {
    it("simple addition should compute the sum", () => {
        expect(evaluateExpression("12 + 4")).toBe(16);
    });

    it("multiplication should compute the product", () => {
        expect(evaluateExpression("12 * 4")).toBe(48);
    });

    it("mixed operators should honor precedence (* before +)", () => {
        expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    });

    it("parentheses should override precedence", () => {
        expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
    });

    it("nested parentheses should evaluate inside-out", () => {
        expect(evaluateExpression("((1 + 2) * (3 + 4))")).toBe(21);
    });

    it("division should compute a fractional result", () => {
        expect(evaluateExpression("(3 + 4) / 2")).toBe(3.5);
    });

    it("unary minus should negate", () => {
        expect(evaluateExpression("-5 + 2")).toBe(-3);
    });

    it("stacked unary operators should chain", () => {
        expect(evaluateExpression("--5")).toBe(5);
        expect(evaluateExpression("-+-5")).toBe(5);
    });

    it("unary minus on a parenthesized group should negate the group", () => {
        expect(evaluateExpression("-(3 + 4)")).toBe(-7);
    });

    it("decimals should be parsed and computed", () => {
        expect(evaluateExpression("0.5 * 2")).toBe(1);
        expect(evaluateExpression(".5 + .25")).toBe(0.75);
    });

    it("modulo (%) should compute the remainder", () => {
        expect(evaluateExpression("10 % 3")).toBe(1);
        expect(evaluateExpression("10 % 3")).not.toBe(10); // not percent
    });

    it("exponent ^ should be right-associative", () => {
        expect(evaluateExpression("2 ^ 3")).toBe(8);
        expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512); // 2^(3^2), not (2^3)^2=64
    });

    it("** should be an alias for ^", () => {
        expect(evaluateExpression("2 ** 10")).toBe(1024);
    });

    it("unary minus should bind looser than exponent", () => {
        expect(evaluateExpression("-2 ^ 2")).toBe(-4); // -(2^2)
    });

    it("whitespace should be tolerated anywhere", () => {
        expect(evaluateExpression("  12   *4 ")).toBe(48);
        expect(evaluateExpression("\t2+\t2")).toBe(4);
    });

    it("division by zero should return null", () => {
        expect(evaluateExpression("1 / 0")).toBeNull();
        expect(evaluateExpression("5 / (2 - 2)")).toBeNull();
    });

    it("modulo by zero should return null", () => {
        expect(evaluateExpression("5 % 0")).toBeNull();
    });

    it("letters / identifiers should be rejected (no code execution)", () => {
        expect(evaluateExpression("alert(1)")).toBeNull();
        expect(evaluateExpression("x + 1")).toBeNull();
        expect(evaluateExpression("2 + a")).toBeNull();
        expect(evaluateExpression("Math.max(1,2)")).toBeNull();
    });

    it("scientific notation should be rejected (letter e)", () => {
        expect(evaluateExpression("1e3")).toBeNull();
    });

    it("malformed syntax should return null", () => {
        expect(evaluateExpression("2 +")).toBeNull();
        expect(evaluateExpression("* 2")).toBeNull();
        expect(evaluateExpression("2 3")).toBeNull();
        expect(evaluateExpression("2 (3)")).toBeNull();
        expect(evaluateExpression("1.2.3")).toBeNull();
        expect(evaluateExpression("")).toBeNull();
        expect(evaluateExpression("   ")).toBeNull();
    });

    it("unbalanced parentheses should return null", () => {
        expect(evaluateExpression("(2 + 3")).toBeNull();
        expect(evaluateExpression("2 + 3)")).toBeNull();
        expect(evaluateExpression("()")).toBeNull();
    });

    it("overflow to Infinity should return null", () => {
        // A pure-arithmetic expression that overflows the double range: the
        // engine must reject the Infinity result rather than emit "Infinity".
        // (Scientific notation like 9e999 is rejected earlier as a letter — see
        // the dedicated case above — so it is not an honest overflow test.)
        expect(evaluateExpression("10 ^ 999")).toBeNull(); // Infinity → null
    });

    it("a bare number should still evaluate (detection layer filters these)", () => {
        expect(evaluateExpression("42")).toBe(42);
    });
});

describe("formatCalcResult", () => {
    it("integers should format without a decimal point", () => {
        expect(formatCalcResult(48)).toBe("48");
    });

    it("floating-point artifacts should be rounded away", () => {
        expect(formatCalcResult(0.1 + 0.2)).toBe("0.3");
    });

    it("clean fractionals should keep their digits", () => {
        expect(formatCalcResult(3.5)).toBe("3.5");
    });

    it("negative zero should normalize to 0", () => {
        expect(formatCalcResult(-0)).toBe("0");
    });
});

describe("detectCalcExpression", () => {
    it("an expression ending in = should be detected", () => {
        const m = detectCalcExpression("12 * 4 =");
        expect(m).not.toBeNull();
        expect(m!.expr).toBe("12 * 4");
        expect(m!.result).toBe("48");
    });

    it("the match span should cover the expression through the = and caret", () => {
        const m = detectCalcExpression("note: 12 * 4 =");
        expect(m).not.toBeNull();
        // "12 * 4 =" is 8 chars; "note: " (6) precedes it.
        expect(m!.length).toBe(8);
        expect(m!.expr).toBe("12 * 4");
    });

    it("a leading prose prefix should be excluded from the expression", () => {
        const m = detectCalcExpression("The answer to (3+4)/2 =");
        expect(m).not.toBeNull();
        expect(m!.expr).toBe("(3+4)/2");
        expect(m!.result).toBe("3.5");
    });

    it("a trailing space the user already typed after = should be tolerated", () => {
        const m = detectCalcExpression("2+2= ");
        expect(m).not.toBeNull();
        expect(m!.result).toBe("4");
    });

    it("text not ending in = should not be detected", () => {
        expect(detectCalcExpression("12 * 4")).toBeNull();
        expect(detectCalcExpression("12 * 4 = 48")).toBeNull();
    });

    it("prose assignment 'x = y' should not be hijacked", () => {
        // Caret after "y": does not end in '='.
        expect(detectCalcExpression("x = y")).toBeNull();
    });

    it("a double equals (a==b typed as a==) should not be detected", () => {
        // The char before the second '=' is '=', not an expression char.
        expect(detectCalcExpression("a==")).toBeNull();
        expect(detectCalcExpression("2==")).toBeNull();
    });

    it("a bare number before = should not be detected (no operator)", () => {
        expect(detectCalcExpression("42 =")).toBeNull();
        expect(detectCalcExpression("The value 42 =")).toBeNull();
    });

    it("a non-computable expression before = should not be detected", () => {
        expect(detectCalcExpression("1 / 0 =")).toBeNull();
        expect(detectCalcExpression("2 + =")).toBeNull();
    });

    it("letters mixed into the trailing run should not be detected", () => {
        expect(detectCalcExpression("total = 2 + x =")).toBeNull();
    });

    it("a lone = should not be detected", () => {
        expect(detectCalcExpression("=")).toBeNull();
        expect(detectCalcExpression("  =")).toBeNull();
    });

    it("a date-like shape SHOULD compute as chained arithmetic (maintainer ruling)", () => {
        // `2026-07-17 =` is valid math: the `=` is the ask, and the default
        // advisory mode means the answer is only ever a suggestion. The user
        // path to "not math" is to not type `=` or not accept.
        expect(detectCalcExpression("2026-07-17 =")?.result).toBe("2002");
        expect(detectCalcExpression("555-867-5309 =")?.result).toBe("-5621");
    });

    it("two-operand no-space arithmetic should still be detected", () => {
        expect(detectCalcExpression("5-3 =")?.result).toBe("2");
        expect(detectCalcExpression("7/8 =")?.result).toBe("0.875");
    });

    it("an operator whose left operand is prose should not be detected", () => {
        // `x - 4` is algebra with an out-of-grammar operand, not `-4`.
        expect(detectCalcExpression("x - 4 =")).toBeNull();
        expect(detectCalcExpression("x -4 =")).toBeNull();
    });

    it("a line-start unary minus should still be detected", () => {
        expect(detectCalcExpression("- 4 =")?.result).toBe("-4");
    });

    it("a comma-grouped number should not have its fragment evaluated", () => {
        // The run after the comma is `000 + 2`; offering `2` would be wrong.
        expect(detectCalcExpression("1,000 + 2 =")).toBeNull();
    });

    it("a number fragment glued to an identifier should not be detected", () => {
        expect(detectCalcExpression("a1+2=")).toBeNull();
    });

    it("prose separated by a space should still be detected", () => {
        expect(detectCalcExpression("meeting at 3 + 4 =")?.result).toBe("7");
        expect(detectCalcExpression("The answer is 12 * 4 =")?.result).toBe("48");
    });

    it("a currency glyph glued to the expression should still be detected", () => {
        expect(detectCalcExpression("€5+5 =")?.result).toBe("10");
    });

    it("a result too large for plain digits should not be offered", () => {
        // 9^25 stringifies as 7.17…e+23 — a letter, so nothing is offered.
        expect(detectCalcExpression("9 ^ 25 =")).toBeNull();
    });
});

describe("detectCalcExpression — leading form (=expr)", () => {
    it("=5+7 at line start should offer 12 spanning from the =", () => {
        const det = detectCalcExpression("=5+7");
        expect(det?.result).toBe("12");
        expect(det?.expr).toBe("5+7");
        expect(det?.length).toBe(4); // "=5+7"
    });

    it("a leading = after whitespace should be detected", () => {
        const det = detectCalcExpression("note =5+7");
        expect(det?.result).toBe("12");
        expect(det?.length).toBe(4);
    });

    it("a prose assignment (a=5+7) should not be detected", () => {
        expect(detectCalcExpression("a=5+7")).toBeNull();
        expect(detectCalcExpression("total=2+2")).toBeNull();
    });

    it("a highlight-style double equals should not be detected", () => {
        expect(detectCalcExpression("==5+7")).toBeNull();
    });

    it("an incomplete or operator-free leading expression should not be detected", () => {
        expect(detectCalcExpression("=5+")).toBeNull();
        expect(detectCalcExpression("=42")).toBeNull();
        expect(detectCalcExpression("=")).toBeNull();
    });

    it("spaces after the = should be tolerated", () => {
        expect(detectCalcExpression("= 5 + 7")?.result).toBe("12");
    });
});

describe("detectCalcExpression — truncated-window boundaries (boundaryUnknown)", () => {
    it("a trailing run starting at position 0 should be refused when the window may be cut", () => {
        // The char before the run is invisible — it could be the comma of
        // `1,000…`, making this a fragment and the answer wrong.
        expect(detectCalcExpression("000 + 2 =", { boundaryUnknown: true })).toBeNull();
        // At a TRUE line start (no truncation) the same text computes.
        expect(detectCalcExpression("000 + 2 =")?.result).toBe("2");
    });

    it("a leading = anchored at position 0 should be refused when the window may be cut", () => {
        // The invisible preceding char could be a letter (`a=5+7` — prose).
        expect(detectCalcExpression("=5+7", { boundaryUnknown: true })).toBeNull();
        expect(detectCalcExpression("=5+7")?.result).toBe("12");
    });

    it("a whitespace boundary INSIDE the window stays trusted even when cut", () => {
        expect(detectCalcExpression("x =5+7", { boundaryUnknown: true })?.result).toBe("12");
        expect(detectCalcExpression("is 3 + 4 =", { boundaryUnknown: true })?.result).toBe("7");
    });
});

describe("formatCalcResult precision", () => {
    it("integers beyond 12 significant digits should print exactly", () => {
        expect(formatCalcResult(9999999999999)).toBe("9999999999999");
        expect(formatCalcResult(1234567890123)).toBe("1234567890123");
    });
});
