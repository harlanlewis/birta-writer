/**
 * Unit tests for the launch-A/B gate's DECISION logic (e2e/perf/verdict.mjs) —
 * the math that blocks every PR. The runners themselves run Playwright and
 * process.exit on import and cannot be tested, which is why the decision lives
 * in verdict.mjs: the noise floor, the gated-fixture rule, and the
 * double-confirm intersection are all exercised here directly.
 */
import { describe, it, expect } from "vitest";
import {
    abVerdict, confirmRegressions, spans, aggregate, GATED_FIXTURES,
    SPANS, SUB_SPANS, POST_PAINT_SPANS,
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
        // xlarge: 22.3 → 44.6 ms = +100%, a doubling of per-keystroke cost.
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

    // `large` is measured locally but not gated (TYPING_GATED_FIXTURES). A
    // regression there must not leak into the gated verdict, and xlarge's
    // verdict must not be masked by it.
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

    // The A/B prints SUB_SPANS inline under a launch delta, as the breakdown of
    // where that delta went. A post-paint span listed there would read as a
    // contributor to a launch it cannot touch: `rtp` moving +60 ms next to
    // `create` and `paint` invites exactly the wrong conclusion. Adding a span
    // to SPANS without classifying it is the mistake this catches (MAR-311).
    it("every post-paint span is in SPANS and out of SUB_SPANS", () => {
        const labels = SPANS.map(([l]) => l);
        for (const label of POST_PAINT_SPANS) {
            expect(labels, `${label} must be reported`).toContain(label);
            expect(SUB_SPANS, `${label} does not compose launch`).not.toContain(label);
        }
        // …and nothing else is silently dropped: SUB_SPANS is exactly the rest.
        expect(SUB_SPANS).toEqual(labels.filter((l) => l !== "launch" && !POST_PAINT_SPANS.has(l)));
    });
});

// ── Caret (selection-only dispatch) gate ────────────────────────────────────
// This gate covers selection-only transactions — the one class of work no
// other metric in this repo can see, and therefore the one that can regress
// with nothing reporting it (MAR-137).

/**
 * One-fixture typing pass carrying caret MEDIANS (and typing medians held flat).
 *
 * The gate reads `caretMedian`, never a burst total — the sample count tracks
 * main-thread load, so any sum over the pool moves with the load; see the note
 * on TYPING_CARET_MIN_SAMPLES. `samples` defaults comfortably above the floor
 * so the floor tests below isolate the effect-size thresholds; the abstention
 * tests pass it explicitly.
 */
const caretPass = (name, baseCaret, headCaret, median = 10, samples = 40) => ({
    [name]: {
        base: { median, caretMedian: baseCaret, caretSamples: samples },
        head: { median, caretMedian: headCaret, caretSamples: samples },
    },
});

describe("typingAbVerdict — the caret gate", () => {
    it("a gated fixture whose caret cost rises ≥10% AND ≥0.5ms regresses", () => {
        // 3.5 → 5.7 ms = +63%, clear of both floors.
        expect([...typingAbVerdict(caretPass("xlarge", 3.5, 5.7)).regressed]).toEqual(["xlarge"]);
    });

    it("a caret move over 10% but under 0.5ms does NOT regress (the ms floor)", () => {
        // 1.0 → 1.2 = +20% but only +0.2 ms.
        expect(typingAbVerdict(caretPass("xlarge", 1.0, 1.2)).regressed.size).toBe(0);
    });

    it("a caret move over 0.5ms but under 10% does NOT regress (the % floor)", () => {
        // 20 → 20.8 = +0.8 ms but only +4%.
        expect(typingAbVerdict(caretPass("xlarge", 20, 20.8)).regressed.size).toBe(0);
    });

    it("an UNGATED fixture's caret regression never gates", () => {
        const v = typingAbVerdict(caretPass("medium", 1, 10));
        expect(v.regressed.size).toBe(0);
        expect(TYPING_GATED_FIXTURES.has("medium")).toBe(false);
    });

    it("a caret IMPROVEMENT never counts as a regression", () => {
        expect(typingAbVerdict(caretPass("xlarge", 5.7, 3.5)).regressed.size).toBe(0);
    });

    it("a missing caret median is skipped, not read as a zero baseline", () => {
        // Pre-metric JSONs have no caret fields; treating absent as 0 would make
        // every comparison against an old capture a 100% regression.
        const v = typingAbVerdict({ xlarge: { base: { median: 10 }, head: { median: 10 } } });
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].caret).toBeNull();
    });

    // ── The sampling floor ─────────────────────────────────────────────────
    // Arrow presses coalesce `selectionchange`, so a burst can yield a handful
    // of transactions — few enough that a median over them is an order
    // statistic on n=2. Below the floor the verdict abstains rather than
    // comparing statistics the pool cannot support.

    it("a caret move below the sample floor should ABSTAIN, not gate", () => {
        // The shape that fires falsely: a large apparent move on n=2.
        const v = typingAbVerdict(caretPass("xlarge", 3.5, 6.5, 10, 2));
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].caret.insufficient).toBe(true);
        expect(v.rows[0].caret.realCaret).toBe(false);
    });

    it("an abstaining verdict should still report its sample count, never hide", () => {
        // A gate that stops gating silently is worse than one that fails.
        const v = typingAbVerdict(caretPass("xlarge", 3.5, 6.5, 10, 2));
        expect(v.rows[0].caret.samples).toBe(2);
        expect(v.rows[0].caret.dCaret).toBeCloseTo(3.0, 5);
    });

    it("the floor should use the SMALLER side's count, not the larger", () => {
        // Coalescing is per-bundle: head can yield 47 while base yields 2.
        // Gating on the larger would reinstate exactly the n=2 comparison.
        const pass = {
            xlarge: {
                base: { median: 10, caretMedian: 3.5, caretSamples: 2 },
                head: { median: 10, caretMedian: 6.5, caretSamples: 40 },
            },
        };
        const v = typingAbVerdict(pass);
        expect(v.rows[0].caret.samples).toBe(2);
        expect(v.regressed.size).toBe(0);
    });

    it("an absent sample count should be treated as insufficient, not as plenty", () => {
        // An older merge-base predates the field; reading absent as OK would
        // gate on a bundle we cannot characterize.
        const pass = {
            xlarge: {
                base: { median: 10, caretMedian: 3.5 },
                head: { median: 10, caretMedian: 6.5 },
            },
        };
        const v = typingAbVerdict(pass);
        expect(v.rows[0].caret.insufficient).toBe(true);
        expect(v.regressed.size).toBe(0);
    });

    it("a build that yields MORE but cheaper selection transactions must not regress", () => {
        // PR #246's false fire, as data. The head build reduced main-thread
        // jank, so its presses coalesced less: 47 samples to base's 13. The
        // retired burst-total gate compared sums over those unequal pools
        // (7.63 → 22.52 ms) and REGRESSED, confirmed across two CI passes,
        // on a branch whose per-transaction cost had dropped 1.9 → 1.5 ms.
        // The retired `caretTotal` fields are deliberately present, with the
        // incident's real values: replayed against the pre-fix gate this pass
        // FIRES, so the test distinguishes the two implementations instead of
        // abstaining its way green on both.
        const pass = {
            xlarge: {
                base: { median: 10, caretMedian: 1.9, caretSamples: 13, caretTotal: 7.63 },
                head: { median: 10, caretMedian: 1.5, caretSamples: 47, caretTotal: 22.52 },
            },
        };
        const v = typingAbVerdict(pass);
        expect(v.regressed.size).toBe(0);
        expect(v.rows[0].caret.dCaret).toBeLessThan(0);
        // Both counts stay visible — their disagreement is the coalescing
        // signal a reader needs to see.
        expect(v.rows[0].caret.bSamples).toBe(13);
        expect(v.rows[0].caret.aSamples).toBe(47);
    });

    it("a caret regression gates even when the typing median is flat", () => {
        // The whole point: the typing median could not see this cost at all.
        const v = typingAbVerdict(caretPass("xlarge", 2.0, 4.0, 10));
        expect(v.rows[0].dMs).toBe(0);
        expect([...v.regressed]).toEqual(["xlarge"]);
    });
});
