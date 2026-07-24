/**
 * webview/utils/calcUnitsEngine.ts
 *
 * The lazy half of calcUnits.ts — the only module that imports mathjs, and
 * only ever reached through `import("./calcUnitsEngine")`. The imports here
 * are STATIC on purpose: a dynamic `import("mathjs")` hands back the full
 * namespace object, which defeats tree-shaking and ships all of mathjs
 * (~730 KB min); static factory imports let esbuild shake the bundle down to
 * the unit system this module actually names. Keep every mathjs reference in
 * this file, and keep this file reachable only via dynamic import.
 */
import { create, createUnitDependencies, unitDependencies } from "mathjs";

/** The conversion surface calcUnits.ts consumes. */
export interface UnitMath {
    unit(value: number, name: string): { toNumber(target: string): number };
}

/** Build and configure the slim unit-only mathjs instance. */
export function createUnitMath(): UnitMath {
    const math = create({ unitDependencies, createUnitDependencies }) as unknown as UnitMath & {
        createUnit(
            name: string,
            definition: string | { definition: string },
            options?: { override: boolean },
        ): void;
    };
    // The one catalog gap for our historical spellings: nautical mile.
    math.createUnit("nmi", "1852 m");

    // ── The note-taker's conventions ─────────────────────────────────────
    // Where mathjs's convention and the everyday reading disagree, this
    // catalog sides with the note-taker — each override is a one-line POLICY
    // decision with a pinned test, not a factor table: entries exist only
    // where humanity itself disagrees about a word, and anyone meaning the
    // other convention can always write it explicitly (`365.25 days`).
    //
    // Kitchen: mathjs's teaspoon/tablespoon are METRIC (5 / 15 ml) while its
    // cup, pint, quart, and gallon are US customary — a mixed system a
    // recipe can't survive (a US cup would be 47.3 "teaspoons"). The spoons
    // — SINGULAR AND PLURAL, mathjs registers each spelling separately — go
    // US customary so the set agrees with itself: 1 cup = 16 tbsp = 48 tsp.
    for (const name of ["teaspoon", "teaspoons"]) {
        math.createUnit(name, { definition: "4.92892159375 mL" }, { override: true });
    }
    for (const name of ["tablespoon", "tablespoons"]) {
        math.createUnit(name, { definition: "14.78676478125 mL" }, { override: true });
    }
    // Calendar: mathjs's year is the JULIAN year (365.25 days — the
    // light-year convention), which reads as a quarter-day lie in a note.
    // Calendars aren't metric, so the triangle year=365d ∧ month=30d ∧
    // year=12mo cannot close; we keep the two strong intuitions — a year is
    // 365 days and 12 months — and let the month be the honest average
    // (365/12 ≈ 30.416667). The longer spans follow the overridden year so
    // `1 decade in years` stays exactly 10.
    for (const name of ["year", "years"]) {
        math.createUnit(name, { definition: "365 days" }, { override: true });
    }
    for (const name of ["month", "months"]) {
        // mathjs unit definitions take `<value> <unit>`, not expressions —
        // this is 365/12 days, spelled out.
        math.createUnit(name, { definition: `${365 / 12} days` }, { override: true });
    }
    for (const [name, definition] of [
        ["decade", "10 years"], ["decades", "10 years"],
        ["century", "100 years"], ["centuries", "100 years"],
        ["millennium", "1000 years"], ["millennia", "1000 years"],
    ] as const) {
        math.createUnit(name, { definition }, { override: true });
    }
    return math;
}
