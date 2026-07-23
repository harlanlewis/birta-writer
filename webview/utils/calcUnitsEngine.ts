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
    // mathjs's teaspoon/tablespoon are METRIC (5 / 15 ml) while its cup,
    // pint, quart, and gallon are US customary — a mixed system a recipe
    // can't survive (a US cup would be 47.3 "teaspoons"). Override the
    // spoons — SINGULAR AND PLURAL, mathjs registers each spelling as its
    // own unit — to US customary so the kitchen set agrees with itself (and
    // with the values this feature has always used): 1 cup = 16 tbsp = 48 tsp.
    for (const name of ["teaspoon", "teaspoons"]) {
        math.createUnit(name, { definition: "4.92892159375 mL" }, { override: true });
    }
    for (const name of ["tablespoon", "tablespoons"]) {
        math.createUnit(name, { definition: "14.78676478125 mL" }, { override: true });
    }
    return math;
}
