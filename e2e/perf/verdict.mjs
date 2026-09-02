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
    // On a document that opens progressively (webview/progressiveOpen.ts)
    // this is the first chunk's model alone, and `stream` below is the rest.
    ["create", "create-start", "create-end"],
    // The INITIAL VIEW RENDER: everything between Milkdown handing back a
    // created editor and the browser painting the first frame that shows it —
    // ProseMirror's first DOM build, style/layout/paint, and any work a plugin
    // schedules from its `view()` onto the frames before that paint. Work
    // moved in front of first paint is invisible to every other span, so a
    // change can read as "every measured span flat or better" while `launch`
    // regresses. If a plugin schedules its own rAF at mount, suspect this one.
    ["paint", "create-end", "editor-painted"],
    ["toc", "toc-start", "toc-end"],
    ["toolbar", "toolbar-start", "toolbar-end"],
    // ── after `editor-painted` (see POST_PAINT_SPANS) ──
    ["rtp", "rtp-start", "rtp-end"],
    ["proofread", "proofread-start", "proofread-end"],
    // A progressive open (webview/progressiveOpen.ts): from the editor being
    // created on the first chunk to the last chunk appended. `create` and
    // `launch` then cover the first screen only, and this is the rest of the
    // document arriving behind them, idle slice by idle slice. Stamped on
    // every open, so a document opened whole reads it as about zero rather
    // than as a dash.
    ["stream", "stream-start", "stream-end"],
];

/**
 * Spans that fall AFTER `editor-painted`, so they are not part of `launch` and
 * a move in one can never explain a launch delta.
 *
 * They are measured anyway because deferring work past the last mark does not
 * make it free: `rtp` (the zero-edit re-serialization behind round-trip
 * protection) and `proofread` (the first whole-document style pass) both block
 * the main thread right after first paint on the big fixtures — the window a
 * user's first keystroke or scroll lands in.
 *
 * A span listed here whose marks are gone reads `null` on every run, and a
 * dash reads exactly like "cheap" — which is worse than never measuring it at
 * all. `checks.mjs` fails if either stops being stamped (MAR-311).
 */
export const POST_PAINT_SPANS = new Set(["rtp", "proofread"]);

// Post-paint floors, both coarser than launch's 3% / 10 ms.
//
// CALIBRATE THESE FROM CI, NEVER FROM A DEVELOPER MACHINE. That is the whole
// reason they are what they are. A null A/B on an idle laptop (same bundle both
// sides) reports these spans as extremely steady, and floors set from it were
// tight enough that a null CI run — byte-identical bundles, nothing to find —
// cleared both of them on a gated fixture and printed a verdict. It read as
// "faster" only because the noise happened to land negative; the same
// excursion positive is a REGRESSED on a required check, from nothing.
//
// The repo already knew this shape and it was applied to the wrong gate:
// AGENTS.md says to size `typing-perf` from a completed CI job because the
// runner is roughly twice as slow. The same holds here, and more so, because
// these spans are `requestIdleCallback` bodies whose scheduling competes with
// whatever else the runner is doing.
//
// To re-derive: open the `launch-perf` job of any PR that changes no bundled
// code (a docs-only or `e2e/`-only PR is a true null), read its post-paint
// block, and re-run the job a few times on the same commit. The spread across
// those runs is what these floors have to clear. The laptop command below is
// still useful for checking that a change did not move a span, but it is not
// the instrument that sets a CI floor:
//
//   node esbuild.mjs --production && cp -R dist /tmp/dist-null
//   node e2e/perf.mjs --ab /tmp/dist-null dist --runs 9
//
// What the width costs, stated plainly: a subtle regression under a quarter of
// a span now passes. What it keeps is the failure this gate exists for — work
// added to a post-paint span, which is how MAR-311's unattributed block arose —
// because any span that DOUBLES moves +100%, far clear of the percent floor,
// and every gated span is larger than the ms floor. `verdict.test.mjs` pins
// that property so a future widening cannot quietly cross it.
export const POST_PAINT_MIN_PCT = 25;
export const POST_PAINT_MIN_MS = 15;

// The sample floor: below it a span ABSTAINS rather than comparing order
// statistics over a handful of survivors.
//
// Scope, stated honestly, because the neighbouring caret floor guards a much
// likelier failure and the two should not be read as equals. A post-paint
// sample drops out of its median only when the mark misses SETTLE_TIMEOUT_MS,
// which is far longer than these spans take, so in practice every sample
// carries them and this floor does not engage. It covers the narrow middle
// case the mark probe cannot: a side whose warmup DID stamp the mark, so the
// wait stays armed, but which then times out on most later samples. The caret
// pool, by contrast, varies on every ordinary run because arrow presses
// coalesce, which is why its floor is load-critical and this one is a backstop.
//
// Keep it well under the measured-sample count (`--runs` minus the warmup
// pair), or it converts a rare degradation into a routine abstention.
export const POST_PAINT_MIN_SAMPLES = 4;

/**
 * Narrow the settle-mark list a side keeps waiting for, given one sample.
 *
 * The A/B waits for the post-paint end marks so those spans can be gated, but a
 * bundle that never stamps one (a merge-base predating it) would pay the settle
 * timeout on every sample. The runner probes each side with the warmup pair it
 * already discards and calls this to drop whatever that side did not stamp, so
 * an unmarked bundle costs one timeout per fixture rather than one per sample.
 * That is the whole reason this gate could be built without waiting for the
 * marks to reach every plausible merge-base, so it is worth a test: the runner
 * that calls it drives Playwright and cannot have one.
 *
 * Dropping a mark is not a loss of coverage. The span then aggregates to null
 * and ABSTAINS, which is the honest reading of a bundle that cannot report it.
 */
export function narrowSettleMarks(settle, sample) {
    const missing = sample?.__missingSettle ?? [];
    if (!missing.length) return settle;
    return settle.filter((m) => !missing.includes(m));
}

// The sub-spans that compose launch (everything but launch itself, and not the
// post-paint ones, which are reported separately).
export const SUB_SPANS = SPANS
    .map(([l]) => l)
    .filter((l) => l !== "launch" && !POST_PAINT_SPANS.has(l));

// Only these fixtures can FAIL the gate — their launch medians dwarf the 10 ms
// floor so a real move is unambiguous. The small ones are reported, never gated.
// `realistic` gates the mixed-construct shape (wide tables, mermaid, unwrapped
// paragraphs) that the homogeneous size fixtures cannot: a regression that
// only real documents pay was previously invisible to this gate.
export const GATED_FIXTURES = new Set(["medium", "large", "realistic"]);

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

/**
 * Median (and optional min) of each span across a fixture's samples, plus the
 * number of samples each median was actually built from.
 *
 * `runs` counts samples taken; `counts[label]` counts samples that carried that
 * span. They diverge for the post-paint spans, whose marks can miss a sample
 * whose idle callback had not fired by the time the page was read — and a
 * median over the survivors is an order statistic on however many that was.
 * The post-paint gate reads `counts` for exactly the reason the caret gate
 * reads `caretSamples`.
 */
export function aggregate(samples, withMin = true) {
    const agg = { median: {}, counts: {}, runs: samples.length };
    if (withMin) agg.min = {};
    for (const [label] of SPANS) {
        const vals = samples.map((s) => s[label]).filter((v) => v != null);
        agg.median[label] = vals.length ? round(median(vals)) : null;
        agg.counts[label] = vals.length;
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
 * Per-fixture, per-span verdict for the POST-PAINT spans (`rtp`, `proofread`).
 *
 * These sit after `editor-painted`, so they can never move `launch` and the
 * launch verdict is blind to them by construction: work deferred past the last
 * mark still blocks the main thread in the window a user's first keystroke or
 * scroll lands in. Before this, a change that doubled either span passed every
 * check in the repo (MAR-314).
 *
 * ABSTAIN rather than gate when either side lacks the span. A merge-base can
 * predate a mark entirely, and reading absent as zero would make every such
 * comparison an infinite regression — the same trap the caret gate's absent
 * sample count documents below, and the reason this was thought to need a
 * calendar wait until every plausible merge-base carried the marks. It does
 * not: an abstention says "this bundle cannot be characterized" and costs the
 * gate nothing. An abstention is always printed, because a gate that quietly
 * stops gating is worse than one that fails.
 *
 * Regression keys are `fixture:span`, so a `large:rtp` move confirms against
 * `large:rtp` in the second pass and never against `large:proofread`.
 */
export function postPaintVerdict(pass) {
    const rows = [];
    const regressed = new Set();
    for (const [name, r] of Object.entries(pass)) {
        const gated = GATED_FIXTURES.has(name);
        for (const span of POST_PAINT_SPANS) {
            const b = r.base?.median?.[span], a = r.head?.median?.[span];
            if (b == null || a == null) {
                // Which side is missing is the whole diagnosis: an absent BASE
                // is an old merge-base and expected; an absent HEAD means this
                // branch stopped stamping the mark, which `checks.mjs` fails on
                // in measure mode but which must not read as "cheap" here.
                const reason = b == null && a == null ? "neither bundle stamps it"
                    : b == null ? "base predates the mark"
                        : "head no longer stamps it";
                rows.push({ name, span, gated, abstained: true, reason });
                continue;
            }
            // An absent count reads as insufficient, never as plenty: a report
            // shaped before `counts` existed cannot be characterized, and
            // gating on a pool we cannot size is the failure this floor exists
            // to prevent. Both sides stay visible — their disagreement is the
            // load signal a reader needs.
            const bn = r.base?.counts?.[span] ?? 0, an = r.head?.counts?.[span] ?? 0;
            const samples = Math.min(bn, an);
            if (samples < POST_PAINT_MIN_SAMPLES) {
                rows.push({
                    name, span, gated, abstained: true, samples, bSamples: bn, aSamples: an,
                    reason: `only ${samples} sample(s) carried the span (floor ${POST_PAINT_MIN_SAMPLES})`,
                });
                continue;
            }
            const dMs = a - b;
            const dPct = b > 0 ? (dMs / b) * 100 : (a > 0 ? 100 : 0);
            const real = Math.abs(dPct) >= POST_PAINT_MIN_PCT && Math.abs(dMs) >= POST_PAINT_MIN_MS;
            let mark = "  neutral";
            if (real && dMs > 0) {
                mark = gated ? "✗ REGRESSED" : "✗ slower (ungated)";
                if (gated) regressed.add(`${name}:${span}`);
            } else if (real && dMs < 0) { mark = "✓ faster"; }
            rows.push({ name, span, gated, b, a, dMs, dPct, real, mark, abstained: false, samples, bSamples: bn, aSamples: an });
        }
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

// Only this fixture can FAIL the gate. Its dispatch median is far enough above
// the 0.5 ms floor that a real move is unambiguous; every smaller fixture sits
// near that floor, where 10% is a fraction of a millisecond and the gate can
// never fire.
//
// Gating a second fixture is a cost decision, not a coverage one: each costs a
// mount plus a burst on the most expensive job in the repo, and any regression
// that scales with document size — the shape this gate exists for (MAR-215) —
// shows on `xlarge` first and largest. Run `pnpm perf:typing` locally for the
// full fixture spread.
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

// `caret` (selection-only dispatch) IS gated. It exists because nothing else
// in this repo can see selection transactions — no harness, no other gate, not
// `block` — and a cost no instrument reports is a cost that regresses freely
// (MAR-137).
//
// It gates on the per-transaction MEDIAN, never the burst total. How many
// transactions a burst of arrow presses coalesces into is a property of how
// busy the main thread is, not of caret cost: identical bundles measured
// back-to-back produced 13–47 samples per arm, and a total is
// n × per-transaction cost, so it moves with n — it fired REGRESSED, confirmed
// across two CI passes, on a branch whose caret path got cheaper (PR #246).
// The per-transaction median held to two decimals across those same runs.
// Worse, n rises when a change reduces main-thread jank (less coalescing), so
// a total penalises exactly the changes it should reward — and the
// double-confirm cannot catch it, because both passes draw on the same
// load-dependent quantity (MAR-259).
//
// The sample floor is the median's guard: below it the caret verdict ABSTAINS
// rather than comparing order statistics over a handful of coalesced
// transactions. Abstention is always printed — a gate that quietly stops
// gating is worse than one that fails, because nothing tells you it stopped.
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
        // Caret (selection-only dispatch). Gated on the per-transaction MEDIAN
        // with an abstention floor — see the note on TYPING_CARET_MIN_SAMPLES
        // for why the burst total cannot carry the gate.
        const bc = r.base?.caretMedian, ac = r.head?.caretMedian;
        const bn = r.base?.caretSamples, an = r.head?.caretSamples;
        let caret = null;
        if (typeof bc === "number" && typeof ac === "number") {
            const dCaret = ac - bc;
            const dCaretPct = bc > 0 ? (dCaret / bc) * 100 : (ac > 0 ? 100 : 0);
            // A missing count is treated as insufficient, not as "plenty": an
            // older merge-base predates the field, and reading absent as OK
            // would gate on a bundle we cannot characterize. Both sides are
            // kept visible because their disagreement is the coalescing signal
            // that retired the total.
            const bSamples = bn ?? 0, aSamples = an ?? 0;
            const samples = Math.min(bSamples, aSamples);
            const insufficient = samples < TYPING_CARET_MIN_SAMPLES;
            const realCaret = !insufficient
                && Math.abs(dCaretPct) >= TYPING_CARET_MIN_PCT
                && Math.abs(dCaret) >= TYPING_CARET_MIN_MS;
            caret = { bc, ac, dCaret, dCaretPct, realCaret, insufficient, samples, bSamples, aSamples };
            if (realCaret && dCaret > 0 && gated) { regressed.add(name); }
        }
        rows.push({ name, bm, am, dMs, dPct, gated, mark, block, blockNote, caret });
    }
    return { rows, regressed };
}
