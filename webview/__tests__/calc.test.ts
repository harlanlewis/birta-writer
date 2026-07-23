/**
 * Unit tests for the inline-calc engine (webview/utils/calc.ts): the safe
 * arithmetic evaluator, the result formatter, and the deliberately-narrow
 * caret detection that keeps ordinary prose containing `=` from being
 * hijacked. Pure functions — no editor, no DOM.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
    ensureCalcUnits,
    evaluateExpression,
    formatCalcResult,
    detectCalcExpression,
    convertUnit,
    evaluateCalc,
    isCalcStructurallyValid,
    detectArrowExpression,
    parseDefinition,
    buildScopeFromLines,
    evaluateCalcBlock,
    findRefreshEquations,
} from "../utils/calc";

// The unit engine is a lazy chunk in production (callers await it); tests
// preload once so every conversion below is synchronous and deterministic.
beforeAll(() => ensureCalcUnits());

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

// ── Living calculations: `=>`, variables, offline units (MAR-196) ─────────────

describe("evaluateExpression with a variable resolver", () => {
    const scope = new Map([["x", 5], ["budget", 5000], ["rent", 1800]]);
    const resolve = (n: string): number | undefined => scope.get(n);

    it("a known variable should resolve to its value", () => {
        expect(evaluateExpression("x", resolve)).toBe(5);
        expect(evaluateExpression("x * 2", resolve)).toBe(10);
    });

    it("variables should combine with arithmetic and precedence", () => {
        expect(evaluateExpression("rent / budget * 100", resolve)).toBe(36);
        expect(evaluateExpression("(budget - rent) / 2", resolve)).toBe(1600);
    });

    it("an unknown variable should yield null", () => {
        expect(evaluateExpression("y + 1", resolve)).toBeNull();
        expect(evaluateExpression("x + missing", resolve)).toBeNull();
    });

    it("without a resolver, identifiers should still be rejected (the = path)", () => {
        expect(evaluateExpression("x * 2")).toBeNull();
    });
});

describe("convertUnit", () => {
    it("length conversions should be exact-ish", () => {
        expect(convertUnit(3, "km", "mi")).toBeCloseTo(1.8641, 3);
        expect(convertUnit(100, "cm", "m")).toBeCloseTo(1, 9);
        expect(convertUnit(1, "mi", "km")).toBeCloseTo(1.609344, 6);
    });

    it("mass conversions should convert across the dimension", () => {
        expect(convertUnit(1, "kg", "lb")).toBeCloseTo(2.2046, 3);
        expect(convertUnit(180, "lb", "kg")).toBeCloseTo(81.6466, 3);
    });

    it("temperature should convert affinely (offsets, not just factors)", () => {
        expect(convertUnit(100, "C", "F")).toBeCloseTo(212, 9);
        expect(convertUnit(32, "F", "C")).toBeCloseTo(0, 9);
        expect(convertUnit(0, "C", "K")).toBeCloseTo(273.15, 9);
    });

    it("unit names should be case-insensitive", () => {
        expect(convertUnit(1, "KM", "M")).toBeCloseTo(1000, 9);
    });

    it("cross-dimension or unknown units should return null", () => {
        expect(convertUnit(5, "km", "kg")).toBeNull();
        expect(convertUnit(5, "km", "flurbs")).toBeNull();
        expect(convertUnit(5, "widgets", "m")).toBeNull();
    });
});

describe("evaluateCalc (unit form + variables)", () => {
    it("a bare unit conversion should compute", () => {
        expect(evaluateCalc("3 km in mi")).toBeCloseTo(1.8641, 3);
        expect(evaluateCalc("180 lb to kg")).toBeCloseTo(81.6466, 3);
        expect(evaluateCalc("100 C in F")).toBeCloseTo(212, 9);
    });

    it("the numeric side of a conversion may be an expression with variables", () => {
        const scope = new Map([["n", 2]]);
        expect(evaluateCalc("n * 3 cups in ml", scope)).toBeCloseTo(1419.53, 1);
    });

    it("the `in` keyword must be word-bounded (min/into never trip it)", () => {
        // "5 min" is a time quantity, not "5 m in ..." — with no target it is
        // not a conversion and (as arithmetic) `5 min` is two tokens → null.
        expect(evaluateCalc("5 min")).toBeNull();
    });

    it("variable arithmetic should compute through the scope", () => {
        const scope = new Map([["budget", 5000], ["rent", 1800]]);
        expect(evaluateCalc("rent / budget * 100", scope)).toBe(36);
    });

    it("an unresolved variable should yield null", () => {
        expect(evaluateCalc("mystery + 1", new Map())).toBeNull();
    });
});

describe("isCalcStructurallyValid", () => {
    it("well-formed expressions (vars assumed resolvable) should be valid", () => {
        expect(isCalcStructurallyValid("x * 2")).toBe(true);
        expect(isCalcStructurallyValid("3 km in mi")).toBe(true);
        expect(isCalcStructurallyValid("undefinedvar + 1")).toBe(true);
    });

    it("prose / malformed shapes should be invalid", () => {
        expect(isCalcStructurallyValid("the total is")).toBe(false);
        expect(isCalcStructurallyValid("2 +")).toBe(false);
    });
});

describe("detectArrowExpression", () => {
    it("an arithmetic expression before => should be detected", () => {
        const m = detectArrowExpression("2 + 3 =>");
        expect(m).not.toBeNull();
        expect(m!.expr).toBe("2 + 3");
        expect(m!.length).toBe(8); // "2 + 3 =>"
    });

    it("a variable expression before => should be detected", () => {
        expect(detectArrowExpression("x * 2 =>")?.expr).toBe("x * 2");
    });

    it("leading prose should be trimmed to the longest valid suffix", () => {
        const m = detectArrowExpression("Total is x*2 =>");
        expect(m!.expr).toBe("x*2");
        expect(m!.length).toBe(6); // "x*2 =>"
    });

    it("a unit conversion before => should be detected whole", () => {
        expect(detectArrowExpression("3 km in mi =>")?.expr).toBe("3 km in mi");
    });

    it("a lone variable before => should be offered (show its value)", () => {
        expect(detectArrowExpression("total =>")?.expr).toBe("total");
    });

    it("a bare number before => should not be detected", () => {
        expect(detectArrowExpression("42 =>")).toBeNull();
    });

    it("text without => should not be detected", () => {
        expect(detectArrowExpression("x * 2")).toBeNull();
        expect(detectArrowExpression("x * 2 = >")).toBeNull(); // a space breaks =>
    });

    it("a suffix flush against a truncated window start should be refused", () => {
        // The first token could be a fragment of a name/number cut off before
        // the window — resolving it would be wrong.
        expect(detectArrowExpression("budget * 2 =>", { boundaryUnknown: true })).toBeNull();
        // A whitespace boundary inside the window stays trusted.
        expect(detectArrowExpression("x budget * 2 =>", { boundaryUnknown: true })?.expr)
            .toBe("budget * 2");
    });
});

describe("parseDefinition", () => {
    it("a name = value line should parse", () => {
        expect(parseDefinition("x = 42")).toEqual({ name: "x", rhs: "42" });
        expect(parseDefinition("  budget = 5000 ")).toEqual({ name: "budget", rhs: "5000" });
        expect(parseDefinition("total = a + b")).toEqual({ name: "total", rhs: "a + b" });
    });

    it("== (highlight) and => (arrow) should not be definitions", () => {
        expect(parseDefinition("x == y")).toBeNull();
        expect(parseDefinition("x => 5")).toBeNull();
    });

    it("prose or a non-identifier left side should not be a definition", () => {
        expect(parseDefinition("just some prose")).toBeNull();
        expect(parseDefinition("2 + 2 = 4")).toBeNull();
    });
});

describe("buildScopeFromLines", () => {
    it("sequential definitions should accumulate, later referencing earlier", () => {
        const scope = buildScopeFromLines(["budget = 5000", "rent = 1800", "left = budget - rent"]);
        expect(scope.get("budget")).toBe(5000);
        expect(scope.get("rent")).toBe(1800);
        expect(scope.get("left")).toBe(3200);
    });

    it("a forward reference should not resolve (top-to-bottom only)", () => {
        const scope = buildScopeFromLines(["a = b + 1", "b = 5"]);
        expect(scope.get("b")).toBe(5);
        expect(scope.has("a")).toBe(false);
    });

    it("a later redefinition should win", () => {
        const scope = buildScopeFromLines(["x = 1", "x = 9"]);
        expect(scope.get("x")).toBe(9);
    });

    it("non-definition lines should be ignored", () => {
        const scope = buildScopeFromLines(["# Heading", "some prose", "y = 7"]);
        expect(scope.get("y")).toBe(7);
        expect(scope.size).toBe(1);
    });
});

describe("evaluateCalcBlock", () => {
    /** Compact "raw|result" view of a block, for readable assertions. */
    const render = (src: string): string[] =>
        evaluateCalcBlock(src).map((l) => `${l.raw}|${l.result ?? ""}`);

    it("definitions and expressions should compute under one shared scope", () => {
        expect(render("budget = 5000\nrent = 1800\nbudget - rent\nrent / budget * 100")).toEqual([
            "budget = 5000|",       // bare literal — no echo
            "rent = 1800|",
            "budget - rent|3200",
            "rent / budget * 100|36",
        ]);
    });

    it("a definition with an expression RHS should echo its value", () => {
        expect(render("total = 12 * 100")).toEqual(["total = 12 * 100|1200"]);
    });

    it("blank lines and comments should pass through untouched", () => {
        expect(render("# a note\n\n2 + 3\n// trailing")).toEqual([
            "# a note|",
            "|",
            "2 + 3|5",
            "// trailing|",
        ]);
    });

    it("an explicit trailing = or => on an expression should be tolerated", () => {
        expect(render("2 + 3 =\n2 + 3 =>")).toEqual(["2 + 3 =|5", "2 + 3 =>|5"]);
    });

    it("unit conversions should work inside a block", () => {
        const rows = evaluateCalcBlock("3 km in mi");
        expect(rows[0].result!.startsWith("1.864")).toBe(true);
    });

    it("a later definition should be visible to lines below it", () => {
        expect(render("x = 2\nx * 10\nx = 3\nx * 10")).toEqual([
            "x = 2|",
            "x * 10|20",
            "x = 3|",
            "x * 10|30", // uses the redefinition above this line
        ]);
    });

    it("bare numbers, prose, and unresolved variables should show no result", () => {
        expect(render("42\njust prose\nmystery + 1")).toEqual([
            "42|",
            "just prose|",
            "mystery + 1|",
        ]);
    });

    it("a definition with a trailing = should still define (consistent with expression lines)", () => {
        expect(render("x = 2 + 3 =\nx * 2")).toEqual([
            "x = 2 + 3 =|5",
            "x * 2|10",
        ]);
    });

    it("a formula-shaped line that cannot compute should be kind 'error'", () => {
        const kinds = evaluateCalcBlock(
            "mystery + 1\n1 / 0\noops = nope * 2\n3 km in kg",
        ).map((l) => l.kind);
        // Unknown variable, division by zero, a broken definition RHS, and a
        // known-units dimension mismatch are all formulas without a value.
        expect(kinds).toEqual(["error", "error", "error", "error"]);
    });

    it("prose, comments, and bare numbers should be kind 'silent', never 'error'", () => {
        const kinds = evaluateCalcBlock(
            "just prose\nwell-known plan\n# note\n42\n5 glasses in cupboard",
        ).map((l) => l.kind);
        // Hyphenated prose parses as no valid structure; unknown units read as
        // prose too — only confident formulas earn the error cue.
        expect(kinds).toEqual(["silent", "silent", "silent", "silent", "silent"]);
    });

    it("hyphen/slash chains of solely unknown words stay silent (prose, not formulas)", () => {
        const kinds = evaluateCalcBlock(
            "one-off\nwin/win\nstate-of-the-art\neither/or\na/b",
        ).map((l) => l.kind);
        // Structurally these ARE ident chains with operators, but with no
        // number and no known variable there is no evidence of a formula.
        expect(kinds).toEqual(["silent", "silent", "silent", "silent", "silent"]);
    });

    it("word-shaped ident-number compounds stay silent (T-1000, COVID-19)", () => {
        const kinds = evaluateCalcBlock("T-1000\nCOVID-19\nB-52\ns3/2").map((l) => l.kind);
        // A space-free hyphen/slash compound headed by an UNKNOWN identifier
        // reads as prose even though the number is structural evidence.
        expect(kinds).toEqual(["silent", "silent", "silent", "silent"]);
    });

    it("the same compound shape with a KNOWN head is judged as a formula", () => {
        // `T` defined but the tail fails → the cue is earned, not prose.
        const rows = evaluateCalcBlock("T = 5\nT-x2");
        expect(rows[1].kind).toBe("error");
    });

    it("value rows should carry the full-precision value beside the rounded display", () => {
        const rows = evaluateCalcBlock("x = 0.9999999\nx * 1");
        expect(rows[1]).toMatchObject({ kind: "value", result: "1", value: 0.9999999 });
        const exact = evaluateCalcBlock("2 + 3");
        expect(exact[0]).toMatchObject({ result: "5", value: 5 });
    });

    it("an unknown-word chain that references a KNOWN variable earns the cue", () => {
        const rows = evaluateCalcBlock("rent = 1500\nrent + fod");
        expect(rows[1].kind).toBe("error"); // rent is real, `fod` is a typo
    });

    it("a literal definition with an unprintable value defines silently, no error cue", () => {
        const rows = evaluateCalcBlock(
            "x = 0.0000001\nbig = 10000000000000000\ncheck = big / 2",
        );
        // The source already spells each value — nothing to display, nothing
        // wrong; and the definitions really do enter scope for lines below.
        expect(rows[0].kind).toBe("silent");
        expect(rows[1].kind).toBe("silent");
        expect(rows[2]).toMatchObject({ kind: "value", result: "5000000000000000" });
    });

    it("computed lines should be kind 'value'", () => {
        const rows = evaluateCalcBlock("x = 2\nx * 10");
        expect(rows.map((l) => l.kind)).toEqual(["silent", "value"]);
    });
});

describe("formatCalcResult honesty", () => {
    it("safe integers should print exactly", () => {
        expect(formatCalcResult(9007199254740991)).toBe("9007199254740991");
    });

    it("whole numbers beyond the safe-integer range should be refused, not approximated", () => {
        // 2^53 + anything is unrepresentable territory: printing digits would
        // manufacture precision (2^60 formats ~5M away from the true value).
        expect(formatCalcResult(2 ** 60)).toBeNull();
        expect(formatCalcResult(9007199254740992 + 4)).toBeNull();
        expect(evaluateExpression("9007199254740992 + 3")).not.toBeNull(); // computes…
        expect(detectCalcExpression("9007199254740992 + 3 =")).toBeNull(); // …but is never offered
    });

    it("fractional tails should cap at 6 decimals (an answer, not noise)", () => {
        expect(formatCalcResult(10 / 3)).toBe("3.333333");
        expect(formatCalcResult(1.86411357671)).toBe("1.864114");
        expect(formatCalcResult(1234567.89)).toBe("1234567.89"); // integer part never rounded away
    });

    it("a tiny nonzero value that would display as 0 should be refused", () => {
        expect(formatCalcResult(0.0000001)).toBeNull();
        expect(formatCalcResult(-0.00000004)).toBeNull();
    });

    it("non-finite values should be refused", () => {
        expect(formatCalcResult(Infinity)).toBeNull();
        expect(formatCalcResult(NaN)).toBeNull();
    });
});

describe("remainder semantics (%)", () => {
    it("negative operands should follow JS remainder (truncate toward zero), as documented", () => {
        expect(evaluateExpression("-10 % 3")).toBe(-1);
        expect(evaluateExpression("10 % -3")).toBe(1);
    });
});

describe("unit conversion round-trips", () => {
    it("converting there and back should return the original within float noise", () => {
        const pairs: Array<[string, string]> = [
            ["km", "mi"], ["kg", "lb"], ["cup", "tbsp"], ["c", "f"], ["l", "gal"], ["h", "min"],
        ];
        for (const [a, b] of pairs) {
            const out = convertUnit(convertUnit(123.456, a, b)!, b, a)!;
            expect(out).toBeCloseTo(123.456, 9);
        }
    });

    it("prototype-chain keys should never resolve as units", () => {
        expect(convertUnit(5, "constructor", "c")).toBeNull();
        expect(convertUnit(5, "constructor", "constructor")).toBeNull();
        expect(convertUnit(5, "hasOwnProperty", "toString")).toBeNull();
    });

    it("the mathjs catalog reaches units the old hand table never had", () => {
        // Area, data, energy… come free from the delegated catalog — the
        // point of the swap: no local factor table to grow.
        expect(convertUnit(1, "hectare", "acre")).toBeCloseTo(2.4710538, 3);
        expect(convertUnit(1, "GB", "MB")).toBe(1000);
        expect(convertUnit(2, "weeks", "days")).toBe(14);
        expect(evaluateCalc("100 hectare in acre")).toBeCloseTo(247.105, 2);
    });

    it("historical spellings stay case-insensitive — never reinterpreted as SI prefixes", () => {
        // To mathjs alone, `Ml`/`ML` is the MEGAlitre and `T` the tesla; the
        // hand-rolled tables matched case-insensitively, and any casing of a
        // historical spelling must keep its historical meaning (a silent
        // 10^9 reinterpretation is the worst possible answer).
        expect(convertUnit(500, "ML", "l")).toBeCloseTo(0.5, 9);
        expect(convertUnit(1, "Ml", "l")).toBeCloseTo(0.001, 9);
        expect(convertUnit(1, "Mm", "m")).toBeCloseTo(0.001, 9);
        expect(convertUnit(5, "Mg", "g")).toBeCloseTo(0.005, 9);
        expect(convertUnit(5, "T", "kg")).toBeCloseTo(5000, 9);
        expect(convertUnit(3, "S", "ms")).toBeCloseTo(3000, 9);
        expect(convertUnit(2, "H", "s")).toBeCloseTo(7200, 9);
        // Catalog names stay exact-case: MB really is the megabyte.
        expect(convertUnit(1000, "MB", "GB")).toBe(1);
    });

    it("spoon plurals are US customary too (one kitchen system, not two)", () => {
        expect(convertUnit(1, "cup", "teaspoons")).toBeCloseTo(48, 6);
        expect(convertUnit(1, "cup", "tablespoons")).toBeCloseTo(16, 6);
        expect(convertUnit(3, "teaspoons", "ml")).toBeCloseTo(14.78676478125, 6);
    });

    it("legacy spellings and temperature shorthands keep their historical meaning", () => {
        // `C`/`F` must stay temperature (to mathjs alone they'd be
        // coulomb/farad), and tsp/tbsp/nmi/pound resolve via aliases.
        expect(convertUnit(100, "c", "f")).toBeCloseTo(212, 9);
        expect(convertUnit(1, "tsp", "ml")).toBeCloseTo(4.92892159375, 6);
        expect(convertUnit(1, "tbsp", "ml")).toBeCloseTo(14.78676478125, 6);
        expect(convertUnit(1, "nmi", "m")).toBe(1852);
        expect(convertUnit(1, "pound", "kg")).toBeCloseTo(0.45359237, 9);
        expect(convertUnit(100, "°c", "°f")).toBeCloseTo(212, 9);
    });
});

describe("isCalcStructurallyValid — structure, not values", () => {
    it("an expression whose placeholder evaluation would divide by zero is still VALID", () => {
        // Structure and value are different questions; judging shape by
        // evaluating with dummy values mis-rejected these (and mis-trimmed
        // the => span as a consequence).
        expect(isCalcStructurallyValid("x / (y - 1)")).toBe(true);
        expect(isCalcStructurallyValid("10 / (a - b)")).toBe(true);
        expect(isCalcStructurallyValid("1 / 0")).toBe(true);
    });

    it("malformed shapes stay invalid", () => {
        expect(isCalcStructurallyValid("x *")).toBe(false);
        expect(isCalcStructurallyValid("total x")).toBe(false);
        expect(isCalcStructurallyValid("")).toBe(false);
    });

    it("a unit form needs known, same-dimension units", () => {
        expect(isCalcStructurallyValid("3 km in mi")).toBe(true);
        expect(isCalcStructurallyValid("3 km in kg")).toBe(false);
        expect(isCalcStructurallyValid("5 glasses in cupboard")).toBe(false);
    });
});

describe("detectArrowExpression — boundary discipline (never compute a fragment)", () => {
    it("a comma-grouped number should not have its fragment evaluated", () => {
        // `1,000 + 2 =>`: the run after the comma is `000 + 2` — offering 2
        // would answer a different question than the visible one.
        expect(detectArrowExpression("1,000 + 2 =>")).toBeNull();
        expect(detectArrowExpression("price 1,500 * 2 =>")).toBeNull();
    });

    it("a bound sub-expression should never be answered for the whole", () => {
        // `10 / (a - b)` is structurally valid as a WHOLE now, so the span is
        // the full expression — never a trimmed `(a - b)` that drops the `10 /`.
        const det = detectArrowExpression("10 / (a - b) =>");
        expect(det?.expr).toBe("10 / (a - b)");
    });

    it("a leading number is not droppable prose", () => {
        // `2 (3 + 4)` is invalid (no implicit multiplication) — but answering
        // 7 for the parenthesized part would compute a different question.
        expect(detectArrowExpression("2 (3 + 4) =>")).toBeNull();
    });

    it("prose words (including punctuation-carrying ones) still trim away", () => {
        expect(detectArrowExpression("the total x*2 =>")?.expr).toBe("x*2");
        expect(detectArrowExpression("costs. x*2 =>")?.expr).toBe("x*2");
        expect(detectArrowExpression("see items 2 + 3 =>")?.expr).toBe("2 + 3");
    });

    it("an operator head after dropped or glued context should refuse", () => {
        // `foo,bar + 2 =>`: the glued `bar` drops, but `+ 2` had a left
        // operand we can't see — unary only stands at a true line start.
        expect(detectArrowExpression("foo,bar + 2 =>")).toBeNull();
    });

    it("a true line-start unary minus is still offered", () => {
        expect(detectArrowExpression("- 4 =>")?.expr).toBe("- 4");
    });

    it("an expression longer than the run cap refuses instead of answering its tail", () => {
        // 121 ones sum to 121; the capped 160-char tail sums to 80. The cut
        // point is never a trusted boundary — refuse, never answer a fragment.
        const long = `${"1+".repeat(120)}1 =>`;
        expect(detectArrowExpression(long)).toBeNull();
        expect(detectArrowExpression(`${"1 + ".repeat(80)}1 =>`)).toBeNull();
    });

    it("capped PROSE before a short expression still trims and offers", () => {
        // Longer than the 160-char run cap, but within the 24-token drop cap.
        const prose = `${"longishword ".repeat(18)}x*2 =>`;
        expect(detectArrowExpression(prose)?.expr).toBe("x*2");
    });

    it("an expression just under the run cap still computes whole", () => {
        const expr = `${"1+".repeat(75)}1`; // 151 chars < 160
        expect(detectArrowExpression(`${expr} =>`)?.expr).toBe(expr);
    });
});

describe("findRefreshEquations", () => {
    it("a trailing equation should be found with expression and result spans", () => {
        const text = "note 4+5= 9 done";
        const [cand] = findRefreshEquations(text, 5, 8, 500);
        expect(cand.form).toBe("trailing");
        expect(text.slice(cand.res[0], cand.res[1])).toBe("9");
        expect(text.slice(cand.expr[0], cand.expr[1]).trim()).toBe("4+5");
    });

    it("a leading equation (result=expr) should be found", () => {
        const text = "12=5+7";
        const cands = findRefreshEquations(text, 3, 6, 500);
        const lead = cands.find((c) => c.form === "leading");
        expect(lead).toBeDefined();
        expect(text.slice(lead!.res[0], lead!.res[1])).toBe("12");
        expect(text.slice(lead!.expr[0], lead!.expr[1])).toBe("5+7");
    });

    it("an answered => IS an equation (the living form); == never is", () => {
        const text = "budget / 12 => 416";
        const [cand] = findRefreshEquations(text, 0, text.length, 500);
        expect(cand?.form).toBe("arrow");
        expect(text.slice(cand.res[0], cand.res[1])).toBe("416");
        expect(text.slice(cand.expr[0], cand.expr[1]).trim()).toBe("budget / 12");
        // A bare `=>` with no accepted answer belongs to the advisory
        // suggestion, not refresh — and highlight syntax is never math.
        expect(findRefreshEquations("budget / 12 =>", 0, 14, 500)).toEqual([]);
        expect(findRefreshEquations("==highlight== 5", 0, 15, 500)).toEqual([]);
    });

    it("candidates outside the changed range are not reported", () => {
        // Shapes are deliberately broad (validation rejects false hits later);
        // the guarantee here is only that the FAR equation is not examined.
        const text = "4+5= 9 and much later 6+7= 13";
        const cands = findRefreshEquations(text, 0, 2, 500);
        expect(cands.length).toBeGreaterThan(0);
        expect(cands.some((c) => c.resultText === "13")).toBe(false);
        expect(cands.some((c) => c.form === "trailing" && c.resultText === "9")).toBe(true);
    });

    it("a pathological digit-heavy line should scan in linear time", () => {
        // The regex this scanner replaced backtracked quadratically here
        // (~10s at this size); the scan must stay effectively instant.
        const text = `${"1 ".repeat(20000)}=x`;
        const started = performance.now();
        findRefreshEquations(text, text.length - 5, text.length, 500);
        expect(performance.now() - started).toBeLessThan(200);
    });
});
