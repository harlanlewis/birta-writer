/**
 * The legacy case-fold decides what some unit names mean, and this is the
 * guard on which names those are.
 *
 * The fold exists so `500 ml in l` typed in a hurry as `500 ML in L` still
 * means millilitres rather than megalitres, a 10^9 error that looks like an
 * answer. For most names it is a pure convenience: `KM`, `Gallons` and
 * `Minute` resolve to nothing at all without it, so folding them settles a
 * question with one answer. For a handful the exact-case spelling means
 * something else entirely, and there the fold is quietly deciding for the
 * writer.
 *
 * The ambiguous set is therefore DERIVED from the catalog rather than listed,
 * and the spellings offered for each are a table. This file is what holds the
 * two together: a mathjs bump that makes a tenth name ambiguous fails here
 * instead of falling silently through the fold, which is the failure the
 * derivation exists to prevent and which no other run could report.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
    AMBIGUOUS_UNIT_SPELLING_KEYS,
    ambiguousUnitReadings,
    convertUnit,
    ensureCalcUnits,
    isKnownUnit,
    unitFoldIsAmbiguous,
    unitsCompatible,
} from "../utils/calcUnits";

/** Every legacy spelling, the set the fold applies to. Kept in step with
 *  `LEGACY_UNITS` by the coverage assertion below, which fails if this list
 *  stops reaching the ones that matter. */
const LEGACY_SPELLINGS = [
    "mm", "cm", "dm", "m", "km", "in", "inch", "inches", "ft", "foot", "feet",
    "yd", "yard", "yards", "mi", "mile", "miles", "nmi",
    "mg", "g", "kg", "t", "tonne", "tonnes", "oz", "lb", "lbs", "stone",
    "ms", "s", "sec", "secs", "second", "seconds", "min", "mins", "minute",
    "minutes", "h", "hr", "hrs", "hour", "hours", "day", "days", "week", "weeks",
    "ml", "l", "liter", "litre", "liters", "litres", "cup", "cups",
    "pint", "pints", "quart", "quarts", "gal", "gallon", "gallons",
];

/** The capitalisations a person actually types: all caps, and initial cap. */
function casings(lower: string): string[] {
    const out = new Set<string>([lower.toUpperCase(), lower[0]!.toUpperCase() + lower.slice(1)]);
    out.delete(lower);
    return [...out];
}

/** Every capitalised spelling of the legacy list — the space the fold covers. */
const ALL_CASINGS = LEGACY_SPELLINGS.flatMap(casings);

beforeAll(async () => {
    await ensureCalcUnits();
});

describe("unit fold ambiguity", () => {
    it("the derived ambiguous set should be exactly the set the spelling table answers for", () => {
        const derived = ALL_CASINGS.filter((n) => unitFoldIsAmbiguous(n)).sort();
        const tabled = [...AMBIGUOUS_UNIT_SPELLING_KEYS].sort();
        // The instrument must have reached something: a sweep that examined an
        // empty space would agree with an empty table and report success.
        expect(ALL_CASINGS.length).toBeGreaterThan(100);
        expect(derived.length).toBeGreaterThan(0);
        expect(derived).toEqual(tabled);
    });

    it("every ambiguous name should offer two readings that really mean the two things", () => {
        for (const name of AMBIGUOUS_UNIT_SPELLING_KEYS) {
            const readings = ambiguousUnitReadings(name);
            expect(readings, `${name} offers no readings`).toHaveLength(2);
            const [folded, exact] = readings as [string, string];
            // The first reading must mean what the fold would have picked, and
            // the second what exact case would have. A pair that both meant the
            // same thing would be a menu with one answer.
            expect(convertUnit(1, folded, name.toLowerCase()),
                `${name}: ${folded} is not what the fold picks`).toBe(1);
            expect(convertUnit(1, folded, exact),
                `${name}: ${folded} and ${exact} are the same unit`).not.toBe(1);
        }
    });

    it("a reading should not itself be folded away, or the pick would settle nothing", () => {
        // Writing the reading into the document is what makes the answer
        // permanent. A spelling the fold owns would be re-decided on the next
        // read, so the equation would still be ambiguous after the pick.
        for (const name of AMBIGUOUS_UNIT_SPELLING_KEYS) {
            for (const reading of ambiguousUnitReadings(name)) {
                expect(unitFoldIsAmbiguous(reading), `${reading} is itself ambiguous`).toBe(false);
                expect(isKnownUnit(reading), `${reading} does not resolve`).toBe(true);
            }
        }
    });

    it("a fold-only spelling should keep resolving silently, with no question asked", () => {
        // The large majority of the space, and the reason the set is derived:
        // these have no competing exact-case reading, so asking about them
        // would be a question with one answer.
        const foldOnly = ALL_CASINGS.filter((n) => !unitFoldIsAmbiguous(n));
        expect(foldOnly.length).toBeGreaterThan(100);
        for (const name of foldOnly) {
            expect(ambiguousUnitReadings(name), `${name} is offered readings`).toEqual([]);
        }
        // Spot the ones the ticket named, driven rather than asserted abstractly.
        expect(convertUnit(3, "KM", "m")).toBe(3000);
        expect(convertUnit(1, "MIN", "s")).toBe(60);
        expect(convertUnit(1, "Cm", "mm")).toBe(10);
        // `L` is the litre in mathjs, identical to `l`, so the fold changes
        // nothing and it must not become a question.
        expect(unitFoldIsAmbiguous("L")).toBe(false);
        // Closeness, not equality: the litre reaches the millilitre through a
        // float ratio, so an exact compare here would be asserting IEEE754.
        expect(convertUnit(1, "L", "ml")).toBeCloseTo(1000, 6);
    });

    it("an ambiguous conversion should refuse to produce a number", () => {
        // The point of the whole feature: no answer while the question is open.
        expect(convertUnit(500, "ML", "l")).toBeNull();
        expect(convertUnit(1, "l", "ML")).toBeNull();
        expect(convertUnit(1, "T", "kg")).toBeNull();
        expect(convertUnit(1, "H", "min")).toBeNull();
    });

    it("an ambiguous pair should still read as the same KIND of thing", () => {
        // Compatibility is the dimension question, and an unsettled reading
        // does not change it. If this went false the line would be classed as
        // a conversion that can never compute, refused outright, and the
        // readings would never be offered at all.
        expect(unitsCompatible("ML", "l")).toBe(true);
        expect(unitsCompatible("Mm", "km")).toBe(true);
        // Still false for a genuine dimension mismatch.
        expect(unitsCompatible("km", "kg")).toBe(false);
    });

    it("the readings should compute once written in", () => {
        // Both halves of the offer, with the numbers a user would see.
        expect(convertUnit(500, "milliliter", "l")).toBe(0.5);
        expect(convertUnit(500, "megaliter", "l")).toBe(500_000_000);
        expect(convertUnit(1, "tonne", "kg")).toBe(1000);
        expect(convertUnit(1, "hour", "min")).toBe(60);
    });

    it("nothing should be ambiguous while the engine is cold", () => {
        // Not reachable from here (the suite loads the engine once in
        // beforeAll), and stated as the contract the cold path relies on:
        // detection must under-claim rather than guess. The engine-cold
        // behaviour is pinned by the `null` returns in calcUnits' own tests.
        expect(ambiguousUnitReadings("definitely-not-a-unit")).toEqual([]);
    });
});
