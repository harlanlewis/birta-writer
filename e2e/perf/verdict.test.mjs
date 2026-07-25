/**
 * Unit tests for the launch-A/B gate's DECISION logic (e2e/perf/verdict.mjs) —
 * the math that blocks every PR. perf.mjs runs Playwright/process.exit on import
 * so its verdict path was previously untestable; these cover the noise floor,
 * the gated-fixture rule, and the double-confirm intersection directly.
 */
import { describe, it, expect } from "vitest";
import {
    abVerdict, confirmRegressions, spans, aggregate, GATED_FIXTURES,
    typingAbVerdict, TYPING_GATED_FIXTURES,
} from "./verdict.mjs";

/** Build a one-fixture pass with base/head launch medians. */
const pass = (name, baseLaunch, headLaunch) => ({
    [name]: { base: { median: { launch: baseLaunch } }, head: { median: { launch: headLaunch } } },
});

describe("abVerdict — the gate's per-fixture launch decision", () => {
    it("a gated fixture slower by ≥3% AND ≥10ms regresses", () => {
        // large: 1000 → 1100 = +100ms / +10% → real regression on a gated fixture
        expect([...abVerdict(pass("large", 1000, 1100)).regressed]).toEqual(["large"]);
    });

    it("a move over 3% but under 10ms does NOT regress (the ms floor)", () => {
        // tiny-scale: 100 → 105 = +5% but only +5ms → below the 10ms floor
        expect(abVerdict(pass("medium", 100, 105)).regressed.size).toBe(0);
    });

    it("a move over 10ms but under 3% does NOT regress (the % floor)", () => {
        // large: 1000 → 1015 = +15ms but only +1.5% → below the 3% floor
        expect(abVerdict(pass("large", 1000, 1015)).regressed.size).toBe(0);
    });

    it("an UNGATED fixture regressing is reported but never gates", () => {
        // tiny: 100 → 200 = +100% / +100ms, unmistakably slower — but ungated
        const v = abVerdict(pass("tiny", 100, 200));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].mark).toContain("ungated");
        expect(GATED_FIXTURES.has("tiny")).toBe(false);
    });

    it("a real improvement is not a regression", () => {
        const v = abVerdict(pass("large", 1100, 1000));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].mark).toContain("faster");
    });

    it("missing data yields an empty row and never regresses", () => {
        const v = abVerdict({ large: { base: { median: {} }, head: { median: {} } } });
        expect(v.rows[0].empty).toBe(true);
        expect(v.regressed.size).toBe(0);
    });

    it("gates each gated fixture independently", () => {
        const two = { ...pass("medium", 300, 400), ...pass("large", 1000, 1005) };
        // medium regresses (+33%/+100ms); large does not (+0.5%).
        expect([...abVerdict(two).regressed]).toEqual(["medium"]);
    });
});

/** Build a one-fixture typing pass with base/head dispatch medians (+ optional block). */
const tPass = (name, baseMedian, headMedian, baseBlock, headBlock) => ({
    [name]: {
        base: { median: baseMedian, blockMs: baseBlock ?? null },
        head: { median: headMedian, blockMs: headBlock ?? null },
    },
});

describe("typingAbVerdict — the gate's per-fixture per-keystroke decision", () => {
    it("a gated fixture slower by ≥10% AND ≥0.5ms regresses", () => {
        // xlarge: the MAR-215 win handed back — 22.3 → 44.6 ms (+100%)
        expect([...typingAbVerdict(tPass("xlarge", 22.3, 44.6)).regressed]).toEqual(["xlarge"]);
    });

    it("a move over 10% but under 0.5ms does NOT regress (the ms floor)", () => {
        // tiny-scale dispatch: 2 → 2.4 = +20% but only +0.4ms
        expect(typingAbVerdict(tPass("large", 2, 2.4)).regressed.size).toBe(0);
    });

    it("a move over 0.5ms but under 10% does NOT regress (the % floor)", () => {
        // xlarge: 22 → 24 = +2ms but only +9.1%
        expect(typingAbVerdict(tPass("xlarge", 22, 24)).regressed.size).toBe(0);
    });

    it("an UNGATED typing fixture regressing is reported but never gates", () => {
        const v = typingAbVerdict(tPass("medium", 3, 9));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].mark).toContain("ungated");
        expect(TYPING_GATED_FIXTURES.has("medium")).toBe(false);
    });

    it("a real improvement is not a regression", () => {
        const v = typingAbVerdict(tPass("xlarge", 44.6, 22.3));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].mark).toContain("faster");
    });

    it("missing data yields an empty row and never regresses", () => {
        const v = typingAbVerdict({ xlarge: { base: {}, head: {} } });
        expect(v.rows[0].empty).toBe(true);
        expect(v.regressed.size).toBe(0);
    });

    // `large` is measured locally but no longer gated (it is ~1/5 as sensitive
    // as xlarge for most of the cost). A regression there must not leak into
    // the gated verdict, and xlarge's verdict must not be masked by it.
    it("an ungated fixture regressing beside a neutral gated one does not gate", () => {
        const two = { ...tPass("large", 8, 20), ...tPass("xlarge", 22, 22.5) };
        expect([...typingAbVerdict(two).regressed]).toEqual([]);
    });

    it("the gated fixture is judged on its own numbers, not a neighbour's", () => {
        const two = { ...tPass("large", 8, 8), ...tPass("xlarge", 22, 44) };
        expect([...typingAbVerdict(two).regressed]).toEqual(["xlarge"]);
    });

    // `block` is the contention-sensitive metric — a shared CI runner can move it
    // on its own, so it must inform and never fail. These pin that asymmetry.
    it("a block-only regression is reported but does NOT gate", () => {
        const v = typingAbVerdict(tPass("xlarge", 22, 22.1, 900, 8000));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].block.realBlock).toBe(true);
        expect(v.rows[0].blockNote).toContain("not gated");
    });

    it("median improved while block grew is flagged as work MOVED, not removed", () => {
        const v = typingAbVerdict(tPass("xlarge", 44, 22, 900, 8000));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].blockNote).toContain("moved, not removed");
    });

    it("a null block (no longtask support) is not read as a zero baseline", () => {
        const v = typingAbVerdict(tPass("xlarge", 22, 22.1, null, 8000));
        expect(v.rows[0].block).toBeNull();
        expect(v.rows[0].blockNote).toBe("");
    });
});

describe("confirmRegressions — the double-confirm intersection", () => {
    it("a regression in BOTH passes is confirmed", () => {
        expect([...confirmRegressions(new Set(["large"]), new Set(["large"]))]).toEqual(["large"]);
    });

    it("a regression in only the FIRST pass is transient — not confirmed", () => {
        expect(confirmRegressions(new Set(["large"]), new Set()).size).toBe(0);
    });

    it("a regression appearing only in the SECOND pass is not confirmed", () => {
        expect(confirmRegressions(new Set(), new Set(["large"])).size).toBe(0);
    });

    it("keeps only the fixtures common to both passes", () => {
        expect([...confirmRegressions(new Set(["medium", "large"]), new Set(["large"]))]).toEqual(["large"]);
    });
});

describe("spans / aggregate — the measurement math", () => {
    it("spans computes launch from navigation start (0) to editor-painted", () => {
        expect(spans({ "editor-painted": 120, "create-start": 10, "create-end": 90 }).launch).toBe(120);
        expect(spans({ "editor-painted": 120, "create-start": 10, "create-end": 90 }).create).toBe(80);
    });

    it("a span with a missing mark is null, not NaN", () => {
        expect(spans({ "editor-painted": 100 }).create).toBeNull();
    });

    it("aggregate takes the median launch across samples", () => {
        const agg = aggregate([{ launch: 100 }, { launch: 200 }, { launch: 150 }], false);
        expect(agg.median.launch).toBe(150);
        expect(agg.runs).toBe(3);
    });
});
