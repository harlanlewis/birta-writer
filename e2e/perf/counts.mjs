/**
 * Pure decision logic for the heavy-fixture COUNT gate (`pnpm perf:counts`,
 * CI job `perf-nightly`), extracted from the runner so it is unit-testable
 * (`counts.test.mjs`). No I/O here.
 *
 * The gate reads the work counters `webview/perf.ts`'s `countWork` stamps and
 * `e2e/perf-typing.mjs` sums over a mount-plus-burst (`report.fixtures[*].work`),
 * and holds each against a CEILING recorded in `e2e/perf/heavy-budget.json`.
 * Counts and never durations, for the reason `verdict.mjs` gives for leaving
 * `block` ungated: a duration inflates super-linearly under load and cannot be
 * gated on a shared runner, while a count of document-proportional work reads
 * the same on a loaded runner and an idle laptop. That is what lets a scheduled
 * job with no sibling build to interleave against fail hard on it.
 *
 * Not every count is that kind of count. A counter stamped by a TIMER (the
 * sync pipeline's `merge`, whose passes per burst are how many max-wait
 * windows the burst spanned) moves with runner speed exactly as a duration
 * does, and holding it to a ceiling would make the nightly red on a slow
 * night. The budget file therefore has two lists: `fixtures[*]`, the ceilings,
 * and `reported`, the counters printed beside them with the reason they are
 * not gated. The gate itself names no counter; the file does, so a new
 * `countWork` call reaches the gate by existing and is refused until somebody
 * places it in one list or the other.
 *
 * Four statuses, and three of them fail:
 *   OVER        the count exceeded its ceiling: a pass became proportional to
 *               the document again (AGENTS.md, "Launch performance").
 *   unbudgeted  the run stamped a counter neither list knows. A counter that
 *               exists and is not gated is the silent hole this gate was
 *               built to close.
 *   missing     a listed counter the run did not stamp. A dash reads exactly
 *               like "cheap" (MAR-311), so a mark that stops being stamped is
 *               a failure and never an abstention, on either list.
 *   reported    a counter in `reported`: printed, never failed on its value.
 *
 * The ceiling is a contract, not a measurement, exactly as `eagerBudget` is:
 * `--set-budget` writes the measured count plus headroom, and the file holds
 * nothing else. The headroom exists for the one non-determinism a
 * document-proportional count has in a burst: a runner stall longer than the
 * proofread debounce lands one extra rescan, which asks about one more block.
 * A regression this gate is for is a multiple of the ceiling, never a tenth.
 */

/** Headroom `--set-budget` adds over the measured count. */
export const COUNT_HEADROOM_PCT = 10;

/** Written verbatim into the budget file on every `--set-budget`. */
export const BUDGET_NOTE =
    "Work-count CEILINGS for the nightly heavy-fixture gate (`pnpm perf:counts --check <typing.json>`): " +
    "each is the count a mount-plus-burst on the named fixture handed across an instrumented boundary " +
    "(`countWork` in webview/perf.ts, summed by e2e/perf-typing.mjs), plus headroom. The gate fails when a " +
    "fresh run exceeds a ceiling, stamps a counter this file does not list, or stops stamping one it does. " +
    "`reported` lists the counters printed without a ceiling, each with the reason it cannot hold one. " +
    "Counts, never durations: a count of document-proportional work reads the same on a loaded runner and " +
    "an idle laptop. Re-set after a change that moves one deliberately: `node esbuild.mjs --production " +
    "--metafile && node e2e/perf-typing.mjs huge-outline --json typing.json && node e2e/perf-counts.mjs " +
    "--set-budget typing.json`, then commit this file and say why. This file holds ceilings and reasons and " +
    "NOTHING ELSE; for the current counts, run the tool.";

/**
 * The per-fixture work maps a typing report carries: `{ fixture: { counter: total } }`.
 * Counters are keyed as the runner keys them, `mdw:<mark>.<amount>`.
 */
export function collectWork(report) {
    const out = {};
    for (const [name, r] of Object.entries(report?.fixtures ?? {})) {
        if (r && r.work && typeof r.work === "object") out[name] = { ...r.work };
    }
    return out;
}

/** Ceiling for one measured count: the count plus headroom, rounded up to an integer. */
export function ceilingFor(measured, headroomPct = COUNT_HEADROOM_PCT) {
    return Math.ceil(measured * (1 + headroomPct / 100));
}

/**
 * A budget document from the work of one run: every counter gets a ceiling
 * except those in `reported`, which carry through with their reasons.
 */
export function proposeBudget(workByFixture, reported = {}, headroomPct = COUNT_HEADROOM_PCT) {
    const fixtures = {};
    for (const [fixture, work] of Object.entries(workByFixture)) {
        const ceilings = {};
        for (const [counter, v] of Object.entries(work)) {
            if (counter in reported) continue;
            if (typeof v === "number" && Number.isFinite(v)) ceilings[counter] = ceilingFor(v, headroomPct);
        }
        fixtures[fixture] = ceilings;
    }
    return { note: BUDGET_NOTE, headroomPct, reported: { ...reported }, fixtures };
}

/**
 * Hold one run's counts against the budget. Returns display rows and the
 * failures, and a run that reached no counter at all is itself a failure: an
 * instrument that measured nothing reports success otherwise.
 */
export function countVerdict(workByFixture, budget) {
    const rows = [];
    const failures = [];
    const budgeted = budget?.fixtures ?? {};
    const reported = budget?.reported ?? {};
    const fixtures = new Set([...Object.keys(budgeted), ...Object.keys(workByFixture)]);
    let reached = 0;
    for (const fixture of [...fixtures].sort()) {
        const work = workByFixture[fixture] ?? {};
        const ceilings = budgeted[fixture] ?? {};
        const counters = new Set([...Object.keys(ceilings), ...Object.keys(reported), ...Object.keys(work)]);
        for (const counter of [...counters].sort()) {
            const measured = typeof work[counter] === "number" ? work[counter] : null;
            const ceiling = typeof ceilings[counter] === "number" ? ceilings[counter] : null;
            const isReported = counter in reported;
            if (measured != null) reached++;
            let status;
            if (measured == null) status = "missing";
            else if (isReported) status = "reported";
            else if (ceiling == null) status = "unbudgeted";
            else if (measured > ceiling) status = "OVER";
            else status = "ok";
            const row = { fixture, counter, measured, ceiling, status, reason: isReported ? reported[counter] : "" };
            rows.push(row);
            if (status !== "ok" && status !== "reported") failures.push(row);
        }
    }
    if (reached === 0) {
        failures.push({ fixture: "*", counter: "*", measured: null, ceiling: null, status: "no counters", reason: "" });
    }
    return { rows, failures, reached };
}

/** The verdict as a GitHub-flavoured markdown table, which also reads fine in a terminal. */
export function formatVerdict(verdict) {
    const lines = ["| fixture | counter | measured | ceiling | status |", "| --- | --- | ---: | ---: | --- |"];
    const n = (x) => (x == null ? "–" : String(x));
    for (const r of verdict.rows) {
        const status = r.status === "reported" ? `reported (${r.reason})` : r.status;
        lines.push(`| ${r.fixture} | ${r.counter} | ${n(r.measured)} | ${n(r.ceiling)} | ${status} |`);
    }
    return lines.join("\n");
}
