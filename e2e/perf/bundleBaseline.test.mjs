/**
 * The eager-bytes baseline must hold the CEILING and nothing else.
 *
 * It used to also persist the last measured snapshot — `eagerTotal`, `eagerJs`,
 * `eagerCss`, `eagerChunkCount`, `totalJs`, `totalCss`. No code ever read them:
 * `--check` reads `eagerBudget`, `--set-budget` reads `prev.eagerBudget`, and
 * `--compare` reads its two argument files. They existed only to be read by
 * humans, and they went stale the moment anything landed while still looking
 * like a current reading.
 *
 * That is not hypothetical. It produced the same misquote twice: 62,824 B of
 * drift on 2026-07-25 (turning "95.9 KB of headroom" into an actual 34.5 KB — a
 * 3× error on a gate's margin, quoted into a ticket in good faith), and 41,526 B
 * again on 2026-07-30, four days after AGENTS.md documented the first one. A
 * warning in prose did not stop the second recurrence, so the field is gone
 * instead: a number that cannot be stored cannot go stale.
 *
 * This guard exists because `--set-budget` regenerates the file, so a future
 * change to the writer could silently reintroduce the snapshot and nothing else
 * would notice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASELINE = join(__dirname, "bundle-baseline.json");

/** Fields whose values are a measurement, and therefore drift. */
const MEASUREMENT_FIELDS = [
    "eagerTotal",
    "eagerJs",
    "eagerCss",
    "eagerChunkCount",
    "totalJs",
    "totalCss",
];

describe("bundle-baseline.json", () => {
    it("should carry the budget and the note, and nothing else", () => {
        const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
        expect(Object.keys(baseline).sort()).toEqual(["eagerBudget", "note"]);
    });

    it("should carry no measured byte counts, which would go stale on the next merge", () => {
        const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
        const present = MEASUREMENT_FIELDS.filter((f) => f in baseline);
        expect(
            present,
            `${present.join(", ")} is a measurement, not a budget. Committing it means a later reader ` +
                "quotes a number that stopped being true when the next PR merged — which has already " +
                "happened twice. Run `node e2e/perf-bundle.mjs` for current bytes instead.",
        ).toEqual([]);
    });

    it("should carry the note the writer would rewrite it with", () => {
        // `--set-budget` regenerates the whole file from `BUDGET_NOTE` in
        // perf-bundle.mjs, so a note corrected by hand here survives only until
        // the next budget change silently overwrites it. That already happened:
        // the constant kept promising "the remaining fields are the last
        // measured snapshot" for a snapshot this very suite had deleted. Nothing
        // caught it, because the two other cases only look at the KEYS.
        const { note } = JSON.parse(readFileSync(BASELINE, "utf8"));
        const writer = readFileSync(join(__dirname, "..", "perf-bundle.mjs"), "utf8");
        expect(
            writer.includes(JSON.stringify(note).slice(1, -1)),
            "bundle-baseline.json's note does not match BUDGET_NOTE in e2e/perf-bundle.mjs — the " +
                "next `--set-budget` would overwrite it. Change the constant, not the file.",
        ).toBe(true);
    });

    it("the budget should be a plausible byte ceiling, not KB and not a float", () => {
        // A budget written in KB (e.g. 1216) would pass every --check forever.
        const { eagerBudget } = JSON.parse(readFileSync(BASELINE, "utf8"));
        expect(Number.isInteger(eagerBudget)).toBe(true);
        expect(eagerBudget).toBeGreaterThan(500_000);
    });
});

/**
 * `baseline.json` is the same trap one file over, and worse: nothing reads it at
 * all, so its numbers could only ever be quoted by a human, and they described
 * fixtures that MAR-310 had since reseeded out of existence. Annotating them did
 * not help — the note said "nothing reads this file, re-measure" directly above
 * the stale figures. Same resolution as above: the figures are gone, and this is
 * what keeps them gone.
 */
const LAUNCH_BASELINE = join(__dirname, "baseline.json");

describe("baseline.json", () => {
    it("should carry provenance only, with no measured figures", () => {
        const baseline = JSON.parse(readFileSync(LAUNCH_BASELINE, "utf8"));
        expect(Object.keys(baseline).sort()).toEqual([
            "aggregation", "build", "lastLanded", "note", "runsPerFixture",
        ]);
    });

    it("should carry no per-fixture timings or byte counts", () => {
        const baseline = JSON.parse(readFileSync(LAUNCH_BASELINE, "utf8"));
        const present = ["fixtures", "bundle"].filter((f) => f in baseline);
        expect(
            present,
            `${present.join(", ")} is a measurement, not a record. Nothing reads this file, so a ` +
                "number here can only ever be quoted by a human — and it stops being true at the next " +
                "merge. Run `pnpm perf` for current figures instead.",
        ).toEqual([]);
    });
});
