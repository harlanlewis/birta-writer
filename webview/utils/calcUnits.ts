/**
 * webview/utils/calcUnits.ts
 *
 * The unit-conversion engine behind calc's `<expr> <from> (in|to) <to>` form —
 * a thin, lazily-loaded seam over mathjs's unit system, replacing the
 * hand-maintained factor tables that used to live in calc.ts. The win is the
 * CATALOG: every mathjs unit (length, mass, time, volume, area, data,
 * energy, …, with plural and abbreviated spellings) converts with zero table
 * maintenance here; this module owns only a small legacy-alias map and the
 * loader.
 *
 * SAFETY POSTURE, deliberately narrow: user EXPRESSIONS never reach mathjs —
 * calc.ts's hand-written parser owns all expression evaluation (its
 * "SAFETY IS THE WHOLE POINT" contract is untouched, and the two calc
 * surfaces can never disagree on arithmetic semantics). The only strings
 * handed to mathjs are unit NAMES already shape-validated to `[A-Za-z°]+` by
 * parseUnitForm, given to `math.unit()` — never to `math.evaluate()`, which
 * is not even included in the tree-shaken instance.
 *
 * LAZINESS, the launch-perf contract: mathjs rides a code-split chunk behind
 * a cached dynamic import (the katexLoader pattern). Nothing loads at editor
 * boot; callers on async paths (`=>` fetch, calc-block render) await
 * `ensureCalcUnits()` first, after which conversion is synchronous. The `=`
 * path and the refresh scanner are digits-only and never touch this module.
 */

/** The conversion surface of the slim mathjs instance we create. */
import type { UnitMath } from "./calcUnitsEngine";

let unitMath: UnitMath | null = null;
let loadPromise: Promise<void> | null = null;

/**
 * Legacy spellings from the original hand-rolled table that mathjs does not
 * accept verbatim, plus the temperature shorthands. Checked (lowercased)
 * BEFORE an exact-case mathjs lookup on purpose: to mathjs, `C` is the
 * coulomb and `F` the farad, but `100 C in F` has always meant temperature
 * here and must stay 212. Case-preserving passthrough happens only for names
 * outside this map, so case-sensitive catalog units (`GB` vs `Gb`) still
 * resolve as typed.
 */
const UNIT_ALIASES: Record<string, string> = {
    c: "degC",
    "°c": "degC",
    celsius: "degC",
    f: "degF",
    "°f": "degF",
    fahrenheit: "degF",
    k: "K",
    kelvin: "K",
    tsp: "teaspoon",
    tbsp: "tablespoon",
    pound: "lb",
    pounds: "lb",
};

/**
 * Loads and configures the slim mathjs unit instance (idempotent, cached —
 * concurrent callers share one in-flight import). The mathjs imports live in
 * calcUnitsEngine.ts — statically, so the lazy chunk tree-shakes down to the
 * unit system; only that module is dynamic-imported here.
 */
export function ensureCalcUnits(): Promise<void> {
    if (unitMath) { return Promise.resolve(); }
    loadPromise ??= (async () => {
        const { createUnitMath } = await import("./calcUnitsEngine");
        unitMath = createUnitMath();
    })().catch((err) => {
        // A failed chunk load must not poison every later attempt.
        loadPromise = null;
        throw err;
    });
    return loadPromise;
}

/** True once the engine is loaded and conversions can run synchronously. */
export function calcUnitsReady(): boolean {
    return unitMath !== null;
}

/**
 * Every spelling the original hand-rolled tables accepted. These keep their
 * HISTORICAL, CASE-INSENSITIVE meaning forever: `ML`, `Ml`, and `ml` are all
 * the millilitre (to mathjs alone, `Ml` is the megalitre — a silent 10^9 lie),
 * `T` is the tonne (not the tesla), `S` the second, `H` the hour. Only names
 * OUTSIDE this set fall through to the mathjs catalog with exact-case
 * semantics (`GB` ≠ `Gb`). A spellings list, not a factor table — the factors
 * live in mathjs.
 */
const LEGACY_UNITS = new Set([
    "mm", "cm", "dm", "m", "km", "in", "inch", "inches", "ft", "foot", "feet",
    "yd", "yard", "yards", "mi", "mile", "miles", "nmi",
    "mg", "g", "kg", "t", "tonne", "tonnes", "oz", "lb", "lbs", "stone",
    "ms", "s", "sec", "secs", "second", "seconds", "min", "mins", "minute",
    "minutes", "h", "hr", "hrs", "hour", "hours", "day", "days", "week", "weeks",
    "ml", "l", "liter", "litre", "liters", "litres", "cup", "cups",
    "pint", "pints", "quart", "quarts", "gal", "gallon", "gallons",
]);

/** Resolution candidates for a user-typed unit name, in priority order. */
function candidates(name: string): string[] {
    const lower = name.toLowerCase();
    const alias = UNIT_ALIASES[lower];
    // Aliases first (temperature shorthands must beat coulomb/farad), then the
    // historical spellings, matched case-insensitively as they always were —
    // both DEFINITIVE, no fallthrough: falling through to an exact-case
    // catalog parse is how `ML` becomes the megalitre. Anything else is
    // catalog passthrough, exact-case only (`MB` is the megabyte and `mb`
    // resolves as mathjs says, never as a guess at the user's casing).
    if (alias) { return [alias]; }
    if (LEGACY_UNITS.has(lower)) { return [lower]; }
    return [name];
}

/** `math.unit(value, name)` across the candidate spellings, or null. */
function makeUnit(value: number, name: string): { toNumber(target: string): number } | null {
    if (!unitMath) { return null; }
    for (const spelling of candidates(name)) {
        try {
            return unitMath.unit(value, spelling);
        } catch {
            // not this spelling — try the next
        }
    }
    return null;
}

/**
 * Converts `value` from one unit to another, or `null` when a unit is unknown,
 * the dimensions don't match (`3 km in kg`), the result is non-finite — or the
 * engine simply hasn't loaded yet (callers on evaluation paths must await
 * ensureCalcUnits() first; detection paths treat null as "offer nothing").
 */
export function convertUnit(value: number, from: string, to: string): number | null {
    const unit = makeUnit(value, from);
    if (!unit) { return null; }
    for (const spelling of candidates(to)) {
        try {
            const result = unit.toNumber(spelling);
            return Number.isFinite(result) ? result : null;
        } catch {
            // unknown target spelling or dimension mismatch — try the next
        }
    }
    return null;
}

/** Whether `name` resolves to any known unit (engine must be loaded). */
export function isKnownUnit(name: string): boolean {
    return makeUnit(1, name) !== null;
}

/**
 * Whether two names are known units of the SAME dimension — the error-cue /
 * structural-validity question (`3 km in kg` is a formula-shaped mistake;
 * `5 glasses in cupboard` is prose). False when the engine isn't loaded:
 * detection must under-claim, never guess.
 */
export function unitsCompatible(from: string, to: string): boolean {
    return convertUnit(1, from, to) !== null;
}
