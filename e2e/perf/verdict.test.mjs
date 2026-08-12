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
    SPANS, SUB_SPANS, POST_PAINT_SPANS, MIN_PCT, MIN_MS,
    postPaintVerdict, POST_PAINT_MIN_PCT, POST_PAINT_MIN_MS, POST_PAINT_MIN_SAMPLES,
    narrowSettleMarks,
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

// ── Post-paint spans (rtp, proofread) ───────────────────────────────────────
// These land AFTER `editor-painted`, so the launch verdict is blind to them by
// construction: a change that doubled either passed every check in the repo
// until this gate existed (MAR-314).

/**
 * One-fixture pass carrying post-paint medians. `undefined` omits the span.
 *
 * `samples` defaults comfortably above POST_PAINT_MIN_SAMPLES so the floor
 * tests below isolate the effect-size thresholds; the sampling tests pass it
 * explicitly. Same construction as `caretPass` further down, for the same
 * reason.
 */
const ppPass = (name, span, baseMs, headMs, samples = 8) => ({
    [name]: {
        base: baseMs === undefined ? { median: {}, counts: {} } : { median: { [span]: baseMs }, counts: { [span]: samples } },
        head: headMs === undefined ? { median: {}, counts: {} } : { median: { [span]: headMs }, counts: { [span]: samples } },
    },
});

const rowFor = (v, name, span) => v.rows.find((r) => r.name === name && r.span === span);

describe("postPaintVerdict — gating the spans launch cannot see", () => {
    it("a gated fixture past BOTH floors should regress, keyed fixture:span", () => {
        // large rtp: 60 → 120 ms = +100% / +60 ms, clear of 20% and 15 ms.
        expect([...postPaintVerdict(ppPass("large", "rtp", 60, 120)).regressed]).toEqual(["large:rtp"]);
    });

    it("a move over the % floor but under the ms floor should NOT regress", () => {
        // 20 → 24 ms = +20%, clear of the percent floor, but only +4 ms.
        expect(postPaintVerdict(ppPass("large", "rtp", 20, 24)).regressed.size).toBe(0);
    });

    it("a move over the ms floor but under the % floor should NOT regress", () => {
        // 200 → 208 ms = +8 ms, clear of the ms floor, but only +4%.
        expect(postPaintVerdict(ppPass("large", "rtp", 200, 208)).regressed.size).toBe(0);
    });

    it("an UNGATED fixture regressing should be reported and never gate", () => {
        const v = postPaintVerdict(ppPass("tiny", "proofread", 40, 200));
        expect(v.regressed.size).toBe(0);
        expect(rowFor(v, "tiny", "proofread").mark).toContain("ungated");
        expect(GATED_FIXTURES.has("tiny")).toBe(false);
    });

    it("a real improvement should never count as a regression", () => {
        const v = postPaintVerdict(ppPass("large", "proofread", 120, 60));
        expect(v.regressed.size).toBe(0);
        expect(rowFor(v, "large", "proofread").mark).toContain("faster");
    });

    // ── Abstention ─────────────────────────────────────────────────────────
    // The reason this gate was thought to need a calendar wait: a merge-base
    // can predate a mark entirely. Abstaining costs the gate nothing, and it is
    // what the caret gate already does with an absent sample count.

    it("a base that predates the mark should ABSTAIN, not gate", () => {
        const v = postPaintVerdict(ppPass("large", "rtp", undefined, 120));
        expect(v.regressed.size).toBe(0);
        expect(rowFor(v, "large", "rtp").abstained).toBe(true);
        expect(rowFor(v, "large", "rtp").reason).toContain("base");
    });

    it("absent on the base should not be read as a zero baseline", () => {
        // Reading absent as 0 makes any head value an infinite regression —
        // the trap that would fire on every PR whose merge-base predates a mark.
        const v = postPaintVerdict(ppPass("large", "rtp", undefined, 120));
        expect(rowFor(v, "large", "rtp").dPct).toBeUndefined();
        expect(rowFor(v, "large", "rtp").mark).toBeUndefined();
    });

    it("a head that stopped stamping the mark should abstain and say so", () => {
        // `checks.mjs` fails on this in measure mode; here it must not read as
        // "cheap", which is what a silent null would look like.
        const v = postPaintVerdict(ppPass("large", "rtp", 60, undefined));
        expect(v.regressed.size).toBe(0);
        expect(rowFor(v, "large", "rtp").reason).toContain("head");
    });

    it("neither side stamping it should abstain with its own reason", () => {
        const v = postPaintVerdict(ppPass("large", "rtp", undefined, undefined));
        expect(rowFor(v, "large", "rtp").abstained).toBe(true);
        expect(rowFor(v, "large", "rtp").reason).toContain("neither");
    });

    // ── The sampling floor ─────────────────────────────────────────────────
    // These marks come from idle callbacks, so a sample read before one fired
    // drops out of that span's median — which makes the pool size a function of
    // machine load. That is the property that let the retired caret burst-total
    // gate fire REGRESSED on a branch that had got faster (MAR-259), and the
    // double-confirm cannot catch it because both passes draw on the same pool.

    it("a move below the sample floor should ABSTAIN, not gate", () => {
        // The shape that fires falsely: a large apparent move on a tiny pool.
        const v = postPaintVerdict(ppPass("large", "rtp", 60, 120, 2));
        expect(v.regressed.size).toBe(0);
        expect(rowFor(v, "large", "rtp").abstained).toBe(true);
    });

    it("an abstaining verdict should still report its sample count, never hide", () => {
        const v = postPaintVerdict(ppPass("large", "rtp", 60, 120, 2));
        expect(rowFor(v, "large", "rtp").samples).toBe(2);
        expect(rowFor(v, "large", "rtp").reason).toContain("2 sample");
    });

    it("the floor should use the SMALLER side's count, not the larger", () => {
        // Marks are dropped per side, so head can carry 8 while base carries 2.
        // Gating on the larger would reinstate exactly the tiny-pool comparison.
        const pass = {
            large: {
                base: { median: { rtp: 60 }, counts: { rtp: 2 } },
                head: { median: { rtp: 120 }, counts: { rtp: 40 } },
            },
        };
        const v = postPaintVerdict(pass);
        expect(rowFor(v, "large", "rtp").samples).toBe(2);
        expect(v.regressed.size).toBe(0);
    });

    it("an absent sample count should be treated as insufficient, not as plenty", () => {
        // A report shaped before `counts` existed cannot be characterized;
        // gating on a pool we cannot size is what the floor exists to prevent.
        const pass = {
            large: { base: { median: { rtp: 60 } }, head: { median: { rtp: 120 } } },
        };
        const v = postPaintVerdict(pass);
        expect(rowFor(v, "large", "rtp").abstained).toBe(true);
        expect(v.regressed.size).toBe(0);
    });

    it("a pool exactly AT the floor should still be judged", () => {
        // The floor is a minimum, not an exclusive bound — an off-by-one here
        // silently costs a sample's worth of coverage on every run.
        const v = postPaintVerdict(ppPass("large", "rtp", 60, 120, POST_PAINT_MIN_SAMPLES));
        expect([...v.regressed]).toEqual(["large:rtp"]);
    });

    it("both sides' counts should stay visible on a judged row", () => {
        // Their disagreement is the load signal; a single number hides it.
        const pass = {
            large: {
                base: { median: { rtp: 60 }, counts: { rtp: 6 } },
                head: { median: { rtp: 61 }, counts: { rtp: 9 } },
            },
        };
        const r = rowFor(postPaintVerdict(pass), "large", "rtp");
        expect(r.bSamples).toBe(6);
        expect(r.aSamples).toBe(9);
    });

    // ── Independence ───────────────────────────────────────────────────────

    it("each span should be judged on its own numbers, not its neighbour's", () => {
        const both = {
            large: {
                base: { median: { rtp: 60, proofread: 60 }, counts: { rtp: 8, proofread: 8 } },
                head: { median: { rtp: 120, proofread: 62 }, counts: { rtp: 8, proofread: 8 } },
            },
        };
        // rtp doubles; proofread is flat. Only rtp may appear.
        expect([...postPaintVerdict(both).regressed]).toEqual(["large:rtp"]);
    });

    it("a fixture:span key should not confirm against a different span", () => {
        // The double-confirm intersects these sets, so the key space is what
        // stops an rtp regression in pass 1 being confirmed by a proofread one
        // in pass 2. Same fixture, different span, must not intersect.
        const p1 = postPaintVerdict(ppPass("large", "rtp", 60, 120)).regressed;
        const p2 = postPaintVerdict(ppPass("large", "proofread", 60, 120)).regressed;
        expect(confirmRegressions(p1, p2).size).toBe(0);
        expect(confirmRegressions(p1, p1)).toEqual(new Set(["large:rtp"]));
    });

    // ── The enumeration asserts its own size ───────────────────────────────
    // A sweep that reached nothing passes (AGENTS.md, "Choosing what to
    // assert"). This gate's whole value is that it covers every post-paint
    // span, so the coverage is the assertion.

    it("should judge every POST_PAINT_SPAN for every fixture it is given", () => {
        const c = { rtp: 8, proofread: 8 };
        const full = {
            large: { base: { median: { rtp: 60, proofread: 40 }, counts: c }, head: { median: { rtp: 61, proofread: 41 }, counts: c } },
            tiny: { base: { median: { rtp: 5, proofread: 3 }, counts: c }, head: { median: { rtp: 5, proofread: 3 }, counts: c } },
        };
        const v = postPaintVerdict(full);
        expect(POST_PAINT_SPANS.size).toBeGreaterThanOrEqual(2);
        expect(v.rows.length).toBe(2 * POST_PAINT_SPANS.size);
        for (const name of ["large", "tiny"]) {
            for (const span of POST_PAINT_SPANS) {
                expect(rowFor(v, name, span), `${name}:${span} must be judged`).toBeDefined();
            }
        }
    });

    it("should hold a percent floor above launch's and an ms floor below it", () => {
        // Both directions are the point. These spans jitter more in RELATIVE
        // terms than the mount path, so the percent floor has to sit above
        // launch's; they are an order of magnitude smaller in ABSOLUTE terms, so
        // launch's 10 ms would be a large fraction of one rather than a floor
        // under it. Getting either backwards produces a gate that cannot fire.
        expect(POST_PAINT_MIN_PCT).toBeGreaterThan(MIN_PCT);
        expect(POST_PAINT_MIN_MS).toBeLessThan(MIN_MS);
    });

    it("should let a doubling clear the percent floor, leaving ms as the knob", () => {
        // A span that doubles moves +100%, so the percent floor can never be
        // what hides a doubling — the ms floor is the whole sensitivity story,
        // and it is why the ms floor is the one calibrated against a null A/B.
        expect(POST_PAINT_MIN_PCT).toBeLessThan(100);
        // Stated as behaviour, not just arithmetic: any span at least as large
        // as the ms floor is caught when it doubles.
        const atFloor = POST_PAINT_MIN_MS;
        expect([...postPaintVerdict(ppPass("large", "rtp", atFloor, atFloor * 2)).regressed])
            .toEqual(["large:rtp"]);
    });
});

// ── The settle-mark probe ───────────────────────────────────────────────────
// This is the mechanism that let the post-paint gate be built at all: without
// it, a merge-base predating a mark pays the settle timeout on every sample
// rather than once per fixture. Its caller drives Playwright and cannot be
// tested, which is exactly why the logic was moved here.

const SETTLE = ["rtp-end", "proofread-end"];

describe("narrowSettleMarks — the warmup probe of what a bundle stamps", () => {
    it("a sample that stamped everything should keep the whole wait list", () => {
        expect(narrowSettleMarks(SETTLE, { launch: 100 })).toEqual(SETTLE);
    });

    it("a mark the sample never stamped should be dropped from the wait", () => {
        // The merge-base case: waiting again would cost the full timeout on
        // every remaining sample for a span that will abstain regardless.
        const out = narrowSettleMarks(SETTLE, { __missingSettle: ["rtp-end"] });
        expect(out).toEqual(["proofread-end"]);
    });

    it("a bundle stamping neither mark should end up waiting for nothing", () => {
        expect(narrowSettleMarks(SETTLE, { __missingSettle: [...SETTLE] })).toEqual([]);
    });

    it("narrowing should keep the marks the sample DID stamp, not invert them", () => {
        // An inverted filter reads as working — it still returns a shorter list
        // — while dropping exactly the marks the bundle can report.
        const out = narrowSettleMarks(SETTLE, { __missingSettle: ["proofread-end"] });
        expect(out).toContain("rtp-end");
        expect(out).not.toContain("proofread-end");
    });

    it("narrowing should be monotonic: a later sample cannot re-arm a dropped mark", () => {
        // The runner narrows once at warmup, but the property is what makes the
        // one-timeout-per-fixture cost claim true rather than hopeful.
        const once = narrowSettleMarks(SETTLE, { __missingSettle: ["rtp-end"] });
        const twice = narrowSettleMarks(once, { launch: 100 });
        expect(twice).toEqual(["proofread-end"]);
        expect(narrowSettleMarks(twice, { __missingSettle: ["proofread-end"] })).toEqual([]);
    });

    it("an already-empty wait list should stay empty", () => {
        expect(narrowSettleMarks([], { __missingSettle: ["rtp-end"] })).toEqual([]);
    });

    it("a missing mark the side never waited for should change nothing", () => {
        expect(narrowSettleMarks(["rtp-end"], { __missingSettle: ["something-else"] }))
            .toEqual(["rtp-end"]);
    });

    it("should not mutate the caller's list, which is shared by both sides", () => {
        // Both sides start from the same SETTLE_MARKS constant in the runner.
        // Mutating it would narrow base and head together, so one bundle's
        // missing mark would silently stop the OTHER from being measured.
        const original = [...SETTLE];
        narrowSettleMarks(SETTLE, { __missingSettle: ["rtp-end"] });
        expect(SETTLE).toEqual(original);
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

    // `counts` is what the post-paint sample floor gates on, so a count that
    // does not track the pool it describes would let the floor pass a median
    // built from one sample. `runs` counts samples TAKEN; `counts[span]` counts
    // samples that CARRIED the span, and for a post-paint mark those differ.
    it("aggregate counts the samples that actually carried each span", () => {
        const agg = aggregate(
            [{ launch: 100, rtp: 10 }, { launch: 100, rtp: null }, { launch: 100 }],
            false,
        );
        expect(agg.runs).toBe(3);
        expect(agg.counts.launch).toBe(3);
        // Only the first sample carried rtp: one was explicitly null, one absent.
        expect(agg.counts.rtp).toBe(1);
    });

    it("aggregate reports a zero count for a span no sample carried", () => {
        const agg = aggregate([{ launch: 100 }, { launch: 120 }], false);
        expect(agg.counts.rtp).toBe(0);
        expect(agg.median.rtp).toBeNull();
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
