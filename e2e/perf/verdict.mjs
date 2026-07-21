/**
 * Pure launch-A/B decision logic, extracted from e2e/perf.mjs so the gate that
 * blocks every PR is unit-testable (perf.mjs itself is a run-on-import script
 * that touches Playwright / process.exit). No I/O here — just the span math,
 * the per-fixture verdict, and the double-confirm intersection.
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
 * block on.
 */
export function confirmRegressions(firstRegressed, secondRegressed) {
    const confirmed = new Set();
    for (const f of firstRegressed) { if (secondRegressed.has(f)) { confirmed.add(f); } }
    return confirmed;
}
