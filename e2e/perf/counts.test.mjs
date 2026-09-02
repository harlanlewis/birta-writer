/**
 * The count gate's decision logic, and the shape of the file it reads.
 *
 * The budget file is held to the same rule as `bundle-baseline.json`: it holds
 * ceilings and reasons and nothing else, because a measured figure stored
 * beside a ceiling goes stale the moment anything lands while still reading
 * like a current one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    BUDGET_NOTE,
    COUNT_HEADROOM_PCT,
    ceilingFor,
    collectWork,
    countVerdict,
    formatVerdict,
    proposeBudget,
} from "./counts.mjs";

const BUDGET = join(__dirname, "heavy-budget.json");

const report = {
    fixtures: {
        "huge-outline": {
            median: 3, kb: 742,
            work: {
                "mdw:lint-request.blocks": 4204,
                "mdw:lint-request.chars": 643300,
                "mdw:merge.passes": 4,
            },
        },
        // A fixture whose runner predates counters carries no `work` at all.
        xlarge: { median: 2, kb: 300 },
    },
};
const REPORTED = { "mdw:merge.passes": "timer-driven" };

describe("collectWork", () => {
    it("a typing report should yield one work map per fixture that carries one", () => {
        expect(collectWork(report)).toEqual({
            "huge-outline": { "mdw:lint-request.blocks": 4204, "mdw:lint-request.chars": 643300, "mdw:merge.passes": 4 },
        });
    });

    it("a report with no fixtures should yield nothing rather than throw", () => {
        expect(collectWork({})).toEqual({});
        expect(collectWork(null)).toEqual({});
    });
});

describe("proposeBudget", () => {
    it("every measured counter should get an integer ceiling above the count, except the reported ones", () => {
        const budget = proposeBudget(collectWork(report), REPORTED);
        const c = budget.fixtures["huge-outline"];
        expect(c["mdw:lint-request.blocks"]).toBe(ceilingFor(4204));
        expect(c["mdw:lint-request.blocks"]).toBeGreaterThan(4204);
        expect(Number.isInteger(c["mdw:lint-request.chars"])).toBe(true);
        expect("mdw:merge.passes" in c).toBe(false);
        expect(budget.reported).toEqual(REPORTED);
        expect(budget.note).toBe(BUDGET_NOTE);
        expect(budget.headroomPct).toBe(COUNT_HEADROOM_PCT);
    });

    it("the headroom should be wide enough for one extra rescan and far narrower than a whole-document regression", () => {
        // One extra rescan on the heavy fixture asks about one more block out
        // of thousands; a pass that walks the document again doubles the count.
        expect(ceilingFor(4204)).toBeGreaterThanOrEqual(4205);
        expect(ceilingFor(4204)).toBeLessThan(4204 * 2);
    });
});

describe("countVerdict", () => {
    const work = collectWork(report);
    const budget = proposeBudget(work, REPORTED);
    const failed = (v) => v.failures.map((f) => [f.counter, f.status]);

    it("a run under every ceiling should pass with every counter reached", () => {
        const v = countVerdict(work, budget);
        expect(v.failures).toEqual([]);
        expect(v.reached).toBe(3);
        expect(v.rows.map((r) => r.status).sort()).toEqual(["ok", "ok", "reported"]);
    });

    it("a count exactly at its ceiling should pass and one above it should fail as OVER", () => {
        const ceiling = budget.fixtures["huge-outline"]["mdw:lint-request.blocks"];
        const at = { "huge-outline": { ...work["huge-outline"], "mdw:lint-request.blocks": ceiling } };
        expect(countVerdict(at, budget).failures).toEqual([]);
        const over = { "huge-outline": { ...work["huge-outline"], "mdw:lint-request.blocks": ceiling + 1 } };
        expect(failed(countVerdict(over, budget))).toEqual([["mdw:lint-request.blocks", "OVER"]]);
    });

    it("a reported counter should never fail on its value, however large", () => {
        const big = { "huge-outline": { ...work["huge-outline"], "mdw:merge.passes": 4000 } };
        const v = countVerdict(big, budget);
        expect(v.failures).toEqual([]);
        expect(v.rows.find((r) => r.counter === "mdw:merge.passes")).toMatchObject({ status: "reported", reason: "timer-driven" });
    });

    it("a counter on neither list should fail as unbudgeted", () => {
        const extra = { "huge-outline": { ...work["huge-outline"], "mdw:style-scan.blocks": 12 } };
        expect(failed(countVerdict(extra, budget))).toEqual([["mdw:style-scan.blocks", "unbudgeted"]]);
    });

    it("a listed counter the run did not stamp should fail as missing, never abstain, on either list", () => {
        const gone = { "huge-outline": { "mdw:lint-request.blocks": 4204 } };
        expect(failed(countVerdict(gone, budget))).toEqual([
            ["mdw:lint-request.chars", "missing"],
            ["mdw:merge.passes", "missing"],
        ]);
    });

    it("a run that reached no counter at all should fail rather than pass vacuously", () => {
        const v = countVerdict({}, budget);
        expect(v.reached).toBe(0);
        expect(v.failures.some((f) => f.status === "no counters")).toBe(true);
        // And an empty budget over an empty run is the same nothing.
        expect(countVerdict({}, { fixtures: {} }).failures.map((f) => f.status)).toEqual(["no counters"]);
    });

    it("the markdown table should carry one row per counter and the reported reason", () => {
        const text = formatVerdict(countVerdict(work, budget));
        expect(text.split("\n")).toHaveLength(2 + 3);
        expect(text).toContain("| huge-outline | mdw:lint-request.blocks | 4204 |");
        expect(text).toContain("reported (timer-driven)");
    });
});

describe("heavy-budget.json", () => {
    const budget = JSON.parse(readFileSync(BUDGET, "utf8"));

    it("should carry the note, the headroom, the reported list and per-fixture ceilings, and nothing else", () => {
        expect(Object.keys(budget).sort()).toEqual(["fixtures", "headroomPct", "note", "reported"]);
        expect(budget.note).toBe(BUDGET_NOTE);
    });

    it("should hold at least one integer ceiling on the heavy fixture, so the gate has a subject", () => {
        const ceilings = budget.fixtures["huge-outline"];
        expect(ceilings).toBeDefined();
        const entries = Object.entries(ceilings);
        expect(entries.length).toBeGreaterThan(0);
        for (const [counter, ceiling] of entries) {
            expect(counter.startsWith("mdw:")).toBe(true);
            expect(Number.isInteger(ceiling)).toBe(true);
            expect(counter in budget.reported).toBe(false);
        }
    });

    it("every reported counter should carry a reason, because the list is a judgement and not a reading", () => {
        for (const [counter, reason] of Object.entries(budget.reported)) {
            expect(counter.startsWith("mdw:")).toBe(true);
            expect(typeof reason).toBe("string");
            expect(reason.length).toBeGreaterThan(20);
        }
    });
});
