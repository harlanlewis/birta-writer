/**
 * Pure A/B decision logic for both perf gates — launch (e2e/perf.mjs) and
 * per-keystroke typing (e2e/perf-typing.mjs) — extracted from the runners so the
 * math that blocks every PR is unit-testable (both runners are run-on-import
 * scripts that touch Playwright / process.exit). No I/O here — just the span
 * math, the per-fixture verdicts, and the double-confirm intersection they share.
 *
 * Tested by e2e/perf/verdict.test.mjs.
 */

// Spans derived from the `mdw:` marks, in display order. Each is
// [label, startMark, endMark]; `launch` is the headline (nav start → paint).
export const SPANS = [
    ["launch", null, "editor-painted"],
    ["eager", "eval-start", "ready-posted"],
    ["roundtrip", "ready-posted", "init-received"],
    ["create", "create-start", "create-end"],
    // The INITIAL VIEW RENDER: everything between Milkdown handing back a
    // created editor and the browser painting the first frame that shows it —
    // ProseMirror's first DOM build, style/layout/paint, and any work a plugin
    // schedules from its `view()` onto the frames before that paint. It was
    // the harness's largest blind spot (on `large`, roughly half of `launch`
    // was unattributed), which let a change that added a whole extra
    // decoration pass on the mount path read as "every measured span is flat
    // or better" while launch regressed. It costs nothing to report: both
    // marks already existed.
    ["paint", "create-end", "editor-painted"],
    ["rtp", "rtp-start", "rtp-end"],
    ["toc", "toc-start", "toc-end"],
    ["toolbar", "toolbar-start", "toolbar-end"],
];

// The sub-spans that compose launch (everything but launch itself).
export const SUB_SPANS = SPANS.map(([l]) => l).filter((l) => l !== "launch");

// Only these fixtures can FAIL the gate — their launch medians dwarf the 10 ms
// floor so a real move is unambiguous. The small ones are reported, never gated.
export const GATED_FIXTURES = new Set(["medium", "large"]);

// A launch move counts as real only at ≥3% AND ≥10 ms (the laptop/runner noise
// floor shared with --compare). Both conditions guard against different noise:
// the % ignores tiny-fixture jitter, the ms ignores large-fixture drift.
export const MIN_PCT = 3;
export const MIN_MS = 10;

export const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const round = (x) => Math.round(x * 10) / 10;

/** Turn a `mdw:` marks map into the per-span durations (null when a mark is absent). */
export function spans(marks) {
    const out = {};
    for (const [label, start, end] of SPANS) {
        const a = start ? marks[start] : 0;
        const b = marks[end];
        out[label] = a != null && b != null ? b - a : null;
    }
    return out;
}

/** Median (and optional min) of each span across a fixture's samples. */
export function aggregate(samples, withMin = true) {
    const agg = { median: {}, runs: samples.length };
    if (withMin) agg.min = {};
    for (const [label] of SPANS) {
        const vals = samples.map((s) => s[label]).filter((v) => v != null);
        agg.median[label] = vals.length ? round(median(vals)) : null;
        if (withMin) agg.min[label] = vals.length ? round(Math.min(...vals)) : null;
    }
    return agg;
}

/**
 * Per-fixture launch verdict for one A/B pass. `pass` maps fixture →
 * { base:{median}, head:{median} }. Returns display rows plus the set of GATED
 * fixtures whose head launch regressed past the noise floor.
 */
export function abVerdict(pass) {
    const rows = [];
    const regressed = new Set();
    for (const [name, r] of Object.entries(pass)) {
        const bl = r.base?.median?.launch, al = r.head?.median?.launch;
        if (bl == null || al == null) { rows.push({ name, empty: true }); continue; }
        const dMs = al - bl, dPct = (dMs / bl) * 100;
        const real = Math.abs(dPct) >= MIN_PCT && Math.abs(dMs) >= MIN_MS;
        const gated = GATED_FIXTURES.has(name);
        let mark = "  neutral";
        if (real && dMs > 0) { mark = gated ? "✗ REGRESSED" : "✗ slower (ungated)"; if (gated) regressed.add(name); }
        else if (real && dMs < 0) mark = "✓ faster";
        rows.push({ name, bl, al, dMs, dPct, gated, mark });
    }
    return { rows, regressed };
}

/**
 * Double-confirm: a gated regression fails the gate only if it reproduces in
 * BOTH passes — the intersection. A pass-1-only regression is transient runner
 * noise and does not block. This is what makes a browser-timing gate safe to
 * block on. Shared by both gates.
 */
export function confirmRegressions(firstRegressed, secondRegressed) {
    const confirmed = new Set();
    for (const f of firstRegressed) { if (secondRegressed.has(f)) { confirmed.add(f); } }
    return confirmed;
}

// ── typing gate ─────────────────────────────────────────────
// Same shape as the launch gate above, different metric and floors.

// Only this fixture can FAIL the gate. At ~46 ms per keystroke on a CI runner
// its dispatch median dwarfs the 0.5 ms floor, so a real move is unambiguous;
// every smaller fixture sits near the fixed per-keystroke floor where 10% is a
// fraction of a millisecond and the gate can never fire.
//
// `large` was gated too until it was measured against its cost: it is the
// second most expensive fixture to run and, at ~9 ms, roughly a fifth as
// sensitive as `xlarge`. Any regression that scales with document size — the
// shape this gate exists for (MAR-215) — shows on `xlarge` first and larger.
// Run `pnpm perf:typing` locally for the full fixture spread.
export const TYPING_GATED_FIXTURES = new Set(["xlarge"]);

// A per-keystroke move counts as real only at ≥10% AND ≥0.5 ms. These are the
// thresholds `perf-typing.mjs --compare` has always used: medians are single-
// digit-to-tens of ms, so the launch gate's 10 ms floor would never fire here.
export const TYPING_MIN_PCT = 10;
export const TYPING_MIN_MS = 0.5;

// `block` (total longtask ms over the burst) is REPORTED, never gated. Its
// longtask threshold is a fixed 50 ms, so CPU contention pushes sub-threshold
// tasks over it and inflates the number super-linearly — the one metric here
// that a shared CI runner can move on its own. Coarse floors, used only to
// decide whether the printed note is worth making.
export const TYPING_BLOCK_MIN_PCT = 25;
export const TYPING_BLOCK_MIN_MS = 250;

// `caret` (selection-only dispatch) IS gated. It exists because selection
// transactions were the one class of work nothing in this repo measured, and
// an upstream plugin quietly billed 2.4 ms to every arrow key and click on a
// 300 KB document for as long as that was true (MAR-137).
//
// It gates on the burst TOTAL, not the median — corrected 2026-07-30 after the
// median produced two false REGRESSED verdicts (+72%, +82%) and one neutral
// against effectively the same change. The old code assumed a burst yielded
// CARET_MOVES independent samples; it does not. Back-to-back arrow presses
// coalesce `selectionchange`, so 30 presses collapse into 2–7 transactions and
// the "median" was an order statistic over n=2. A total is not an order
// statistic: coalescing changes how the burst's work is split across
// transactions, but not how much of it there is, so the sum is invariant to
// exactly the thing that made the median unstable.
//
// The sample floor is a second, independent guard: below it the caret verdict
// ABSTAINS rather than guessing. Abstention is always printed — a gate that
// quietly stops gating is worse than one that fails, because nothing tells you
// it stopped.
export const TYPING_CARET_MIN_PCT = 10;
export const TYPING_CARET_MIN_MS = 0.5;
export const TYPING_CARET_MIN_SAMPLES = 8;

/**
 * Per-fixture typing verdict for one A/B pass. `pass` maps fixture →
 * { base:{median,blockMs}, head:{median,blockMs} }. Returns display rows plus
 * the set of GATED fixtures whose head dispatch median regressed past the floor.
 *
 * `row.blockNote` carries the moral hazard the block metric exists to catch:
 * dispatch median "improved" while total main-thread block grew — work moved
 * out of the measured span, not removed. It is a warning, never a failure.
 */
export function typingAbVerdict(pass) {
    const rows = [];
    const regressed = new Set();
    for (const [name, r] of Object.entries(pass)) {
        const bm = r.base?.median, am = r.head?.median;
        if (bm == null || am == null) { rows.push({ name, empty: true }); continue; }
        const dMs = am - bm, dPct = bm > 0 ? (dMs / bm) * 100 : 0;
        const real = Math.abs(dPct) >= TYPING_MIN_PCT && Math.abs(dMs) >= TYPING_MIN_MS;
        const gated = TYPING_GATED_FIXTURES.has(name);
        let mark = "  neutral";
        if (real && dMs > 0) { mark = gated ? "✗ REGRESSED" : "✗ slower (ungated)"; if (gated) regressed.add(name); }
        else if (real && dMs < 0) mark = "✓ faster";

        // Block is optional: a runtime without longtask support records null,
        // and a null must not be read as a zero baseline.
        const bb = r.base?.blockMs, ab = r.head?.blockMs;
        let block = null, blockNote = "";
        if (typeof bb === "number" && typeof ab === "number") {
            const dBlock = ab - bb;
            const dBlockPct = bb > 0 ? (dBlock / bb) * 100 : (ab > 0 ? 100 : 0);
            const realBlock = Math.abs(dBlockPct) >= TYPING_BLOCK_MIN_PCT && Math.abs(dBlock) >= TYPING_BLOCK_MIN_MS;
            block = { bb, ab, dBlock, dBlockPct, realBlock };
            if (realBlock && dBlock > 0 && real && dMs < 0) {
                blockNote = "⚠ median improved but block regressed — work was moved, not removed";
            } else if (realBlock && dBlock > 0) {
                blockNote = "⚠ main-thread block grew (reported, not gated)";
            }
        }
        // Caret (selection-only dispatch). Gated on the per-burst TOTAL; the
        // median rides along as reported context only. See the note on
        // TYPING_CARET_MIN_SAMPLES for why the median cannot carry the gate.
        const bc = r.base?.caretTotal, ac = r.head?.caretTotal;
        const bn = r.base?.caretSamples, an = r.head?.caretSamples;
        let caret = null;
        if (typeof bc === "number" && typeof ac === "number") {
            const dCaret = ac - bc;
            const dCaretPct = bc > 0 ? (dCaret / bc) * 100 : (ac > 0 ? 100 : 0);
            // A missing count is treated as insufficient, not as "plenty": an
            // older merge-base predates the field, and reading absent as OK
            // would gate on a bundle we cannot characterize.
            const samples = Math.min(bn ?? 0, an ?? 0);
            const insufficient = samples < TYPING_CARET_MIN_SAMPLES;
            const realCaret = !insufficient
                && Math.abs(dCaretPct) >= TYPING_CARET_MIN_PCT
                && Math.abs(dCaret) >= TYPING_CARET_MIN_MS;
            caret = {
                bc, ac, dCaret, dCaretPct, realCaret, insufficient, samples,
                bMedian: r.base?.caretMedian ?? null,
                aMedian: r.head?.caretMedian ?? null,
            };
            if (realCaret && dCaret > 0 && gated) { regressed.add(name); }
        }
        rows.push({ name, bm, am, dMs, dPct, gated, mark, block, blockNote, caret });
    }
    return { rows, regressed };
}
