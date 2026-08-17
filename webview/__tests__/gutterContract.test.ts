/**
 * Gutter geometry contract guard (MAR-92). The gutter's per-block-type CSS
 * used to be a second hand-maintained taxonomy beside blockMarkerSpec: a
 * hover-reveal wrapper list and per-wrapper top/left calibrations in
 * style.css that mirrored padding declared in distant component files. A
 * new NodeView block type left every unit test green while its marker never
 * revealed and sat at the wrong line. The contract replaces those rules with
 * custom properties each wrapper declares beside its own padding and one
 * generic consumer rule (style.css `.heading-fold-gutter`), so a wrapper's
 * calibration cannot be missing from a list. What CAN still be missing is
 * the measurement: only headless Chromium can say whether a marker reveals
 * and lands on its block, so this test holds every MarkerSpec key to the
 * e2e suite that measures it (e2e/gutterKeys.json), and that suite fails
 * when its fixture lacks the block or the marker misses.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE = path.join(REPO_ROOT, "webview", "plugins", "headingFold", "foldGutter.ts");
const KEYS_JSON = path.join(REPO_ROOT, "e2e", "gutterKeys.json");

/** Every literal `key: "…"` inside a named function's body. The one computed
 * key family, a nested heading's badge (nestedChildSpec: "h1".."h6"), is
 * measured by paragraphGutter's nested sweep at both scales and is not a
 * literal, so it is outside this registry check by design. */
function literalKeysIn(source: string, fnName: string): string[] {
    const start = source.indexOf(`export function ${fnName}(`);
    if (start < 0) {
        throw new Error(`${fnName} not found in ${SOURCE}`);
    }
    // The next top-level `export function` closes the body: the file keeps
    // one function per export, and only these bodies carry literal keys.
    const next = source.indexOf("\nexport function ", start + 1);
    const body = source.slice(start, next < 0 ? undefined : next);
    return Array.from(body.matchAll(/\bkey:\s*"([\w-]+)"/g), (m) => m[1]!);
}

describe("gutter geometry contract", () => {
    const source = fs.readFileSync(SOURCE, "utf8");
    const specKeys = new Set([
        ...literalKeysIn(source, "blockMarkerSpec"),
        ...literalKeysIn(source, "itemMarkerSpec"),
    ]);
    const measured = JSON.parse(fs.readFileSync(KEYS_JSON, "utf8")) as Record<string, string>;
    const measuredKeys = Object.keys(measured).filter((k) => !k.startsWith("_"));

    it("the sweep reaches the spec registry (both key sources are read)", () => {
        // A sweep that found nothing would pass the subset checks below.
        expect(specKeys.size).toBeGreaterThanOrEqual(16);
        expect(specKeys.has("P")).toBe(true);
        expect(specKeys.has("hr")).toBe(true);
        expect(specKeys.has("task")).toBe(true);
    });

    it("every MarkerSpec key is measured by an e2e geometry suite", () => {
        const unmeasured = [...specKeys].filter((k) => !(k in measured));
        expect(
            unmeasured,
            "MarkerSpec keys with no geometry measurement. Add each to " +
                "e2e/gutterKeys.json AND to the named suite's fixture, so the marker " +
                "is hovered and measured against its block in the production bundle.",
        ).toEqual([]);
    });

    it("every measured key still exists (no stale entries)", () => {
        const stale = measuredKeys.filter((k) => !specKeys.has(k));
        expect(stale, "e2e/gutterKeys.json names keys blockMarkerSpec/itemMarkerSpec no longer emit").toEqual([]);
    });

    it("every measuring suite exists and reads the key list", () => {
        const suites = new Set(measuredKeys.map((k) => measured[k]!));
        expect(suites.size).toBeGreaterThanOrEqual(2);
        for (const suite of suites) {
            const checks = path.join(REPO_ROOT, "e2e", suite, "checks.mjs");
            expect(fs.existsSync(checks), `e2e/${suite}/checks.mjs`).toBe(true);
            // The suite must consume the list, or a listed key it never renders
            // passes silently.
            expect(fs.readFileSync(checks, "utf8").includes("gutterKeys.json"), `${suite} reads gutterKeys.json`).toBe(true);
        }
    });
});
