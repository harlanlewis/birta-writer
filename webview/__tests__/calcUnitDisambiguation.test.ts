/**
 * A unit name the case-fold would decide is answered the way an ambiguous
 * FUNCTION name already is: the expression refuses to compute, the readings
 * are offered, and the pick is written into the equation itself.
 *
 * Same seam for both, deliberately, so no surface branches on which kind of
 * ambiguity it got. These cases are therefore written against the same four
 * functions the `=>` menu and its pick path call — `ambiguousNamesIn`,
 * `ambiguousReadings`, `disambiguate`, `isDisambiguation` — rather than
 * against the unit table, so a change that settled units through a second
 * mechanism would fail here even if the units themselves still worked.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
    ambiguousNamesIn,
    ambiguousReadings,
    disambiguate,
    ensureCalcUnits,
    evaluateCalc,
    isCalcStructurallyValid,
    isDisambiguation,
} from "../utils/calc";

beforeAll(async () => {
    await ensureCalcUnits();
});

describe("ambiguous unit names, through the shared ambiguity seam", () => {
    it("an ambiguous unit should be reported by the same call that reports an ambiguous function", () => {
        expect(ambiguousNamesIn("500 ML in l")).toEqual(["ML"]);
        expect(ambiguousNamesIn("log(100)")).toEqual(["log"]);
    });

    it("an unambiguous conversion should report nothing", () => {
        expect(ambiguousNamesIn("500 ml in l")).toEqual([]);
        expect(ambiguousNamesIn("3 KM in mi")).toEqual([]);
        expect(ambiguousNamesIn("just some prose")).toEqual([]);
    });

    it("an ambiguous name in the TARGET slot should be reported too", () => {
        // Both slots are units, and the target is the one a conversion is
        // usually about. Reporting only the source would leave `1 l in ML`
        // answering with a silent fold.
        expect(ambiguousNamesIn("1 l in ML")).toEqual(["ML"]);
    });

    it("both slots ambiguous should report both, in written order", () => {
        expect(ambiguousNamesIn("1 Mg in T")).toEqual(["Mg", "T"]);
    });

    it("a TAGGED conversion's target should be checked too", () => {
        // `t in ML` converts a variable carrying a unit tag. It is the other
        // conversion shape, parsed by a different function, and a check written
        // against only the numeric form would let it fold silently.
        expect(ambiguousNamesIn("t in ML")).toEqual(["ML"]);
        expect(disambiguate("t in ML", "milliliter")).toBe("t in milliliter");
    });

    it("a tagged conversion's VARIABLE should never be read as a unit", () => {
        // The first token there is a variable name. A variable called `T` is
        // not the tesla and must not be offered readings.
        expect(ambiguousNamesIn("T in kg")).toEqual([]);
        expect(disambiguate("T in kg", "tonne")).toBe("T in kg");
    });

    it("the readings offered should be the two meanings, through the shared lookup", () => {
        expect(ambiguousReadings("ML")).toEqual(["milliliter", "megaliter"]);
        expect(ambiguousReadings("T")).toEqual(["tonne", "tesla"]);
        // The function path is unchanged by sharing the lookup.
        expect(ambiguousReadings("log")).toEqual(["log10", "ln"]);
    });

    it("a picked reading should be recognised as one, whichever kind it settles", () => {
        expect(isDisambiguation("milliliter")).toBe(true);
        expect(isDisambiguation("tonne")).toBe(true);
        expect(isDisambiguation("log10")).toBe(true);
        expect(isDisambiguation("ML")).toBe(false);
        expect(isDisambiguation("kg")).toBe(false);
    });

    it("picking a reading should rewrite the equation, not just the answer", () => {
        expect(disambiguate("500 ML in l", "milliliter")).toBe("500 milliliter in l");
        expect(disambiguate("500 ML in l", "megaliter")).toBe("500 megaliter in l");
        expect(disambiguate("1 l in ML", "milliliter")).toBe("1 l in milliliter");
    });

    it("a rewrite should leave a same-spelled VARIABLE alone", () => {
        // Position, not text replace: the leading `T` here is a variable and
        // only the one in the unit slot is a unit. A text replace would
        // corrupt the expression while looking like it worked.
        expect(disambiguate("T * 2 T in kg", "tonne")).toBe("T * 2 tonne in kg");
    });

    it("a rewrite should survive the trailing `=>` the document region carries", () => {
        // `applyArrowResult` rewrites the document REGION, not the parsed
        // expression, and that region carries the trailing `=>` plus whatever
        // text precedes the equation on the line. Both unit parsers are
        // end-anchored, so a version that parsed the region verbatim matched
        // nothing and silently rewrote nothing — the offer appeared and the
        // pick did nothing. Found by the browser suite; the clean-expression
        // cases above all passed straight through it.
        expect(disambiguate("500 ML in l =>", "milliliter")).toBe("500 milliliter in l =>");
        expect(disambiguate("fourth 500 ML in l =>", "milliliter"))
            .toBe("fourth 500 milliliter in l =>");
        expect(disambiguate("500 ML in l =", "milliliter")).toBe("500 milliliter in l =");
    });

    it("a rewrite should survive an answer already written after the arrow", () => {
        // Re-picking on an equation calc has already answered. The old number
        // has to be trimmed before the parse, or it reads as part of the
        // target unit and the equation is left alone.
        expect(disambiguate("500 ML in l => 0.5", "megaliter")).toBe("500 megaliter in l => 0.5");
    });

    it("a reading that settles neither slot should leave the text alone", () => {
        expect(disambiguate("500 ML in l", "log10")).toBe("500 ML in l");
        expect(disambiguate("500 ML in l", "tonne")).toBe("500 ML in l");
    });

    it("an ambiguous conversion should evaluate to nothing until it is settled", () => {
        // The requirement the ticket states as "must not show a number while
        // the question is open".
        expect(evaluateCalc("500 ML in l")).toBeNull();
        expect(evaluateCalc("1 T in kg")).toBeNull();
    });

    it("the settled equation should evaluate, and to different numbers per reading", () => {
        // The two answers are what the menu puts side by side, so the choice
        // is made against numbers rather than in the abstract. If these were
        // equal the offer would be a menu with one answer.
        const small = evaluateCalc(disambiguate("500 ML in l", "milliliter"));
        const large = evaluateCalc(disambiguate("500 ML in l", "megaliter"));
        expect(small).toBeCloseTo(0.5, 6);
        expect(large).toBeCloseTo(500_000_000, 0);
        expect(small).not.toBe(large);
    });

    it("an ambiguous conversion should still READ as a formula, so it can be cued", () => {
        // Two consequences ride on this and both are user-facing.
        //
        // The `=>` caret detection fixes its span from structure alone, so a
        // line that stopped reading as a formula would never be offered the
        // readings this feature exists to offer: the offer would be refused
        // before the menu could be built.
        //
        // And a document written before this change can already contain
        // `500 ML in l => 0.5`. The refresh engine leaves an answer it cannot
        // recompute exactly where it is, rather than withdrawing it, so what
        // makes that honest rather than silent is the line still classifying
        // as a formula-that-has-no-value, which is what the stale cue reads.
        expect(isCalcStructurallyValid("500 ML in l")).toBe(true);
        expect(isCalcStructurallyValid("1 Mg in T")).toBe(true);
        // The contrast that says the predicate still discriminates: a genuine
        // dimension mismatch does NOT read as a formula.
        expect(isCalcStructurallyValid("3 km in kg")).toBe(false);
    });

    it("an unambiguous conversion should keep answering exactly as before", () => {
        // The 109 fold-only spellings are the large majority of the space and
        // the whole reason the fold is kept. None of them may become a
        // question.
        expect(evaluateCalc("500 ml in l")).toBeCloseTo(0.5, 6);
        expect(evaluateCalc("3 KM in m")).toBeCloseTo(3000, 6);
        expect(evaluateCalc("1 MIN in s")).toBeCloseTo(60, 6);
        expect(evaluateCalc("2 Cups in ml")).not.toBeNull();
        expect(evaluateCalc("1 L in ml")).toBeCloseTo(1000, 6);
    });
});
