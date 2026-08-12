/**
 * Launch-performance runner: drives the real built webview bundle
 * (dist/webview.js) in headless Chromium and reads the `mdw:` User-Timing
 * marks the bundle stamps during cold start (see webview/perf.ts). It reports
 * the median and min of each launch span across repeated runs.
 *
 * Usage:
 *   pnpm build && pnpm perf                      # all fixtures, table output
 *   node e2e/perf.mjs medium                     # one fixture
 *   node e2e/perf.mjs --runs 12 --json after.json
 *   node e2e/perf.mjs --compare before.json after.json   # A/B verdict, no browser
 *
 * The gate for the optimization loop is a SAME-SESSION A/B (--compare): capture
 * before.json on clean HEAD, make the change, capture after.json, compare.
 * Absolute numbers drift with machine load; the deltas are what we trust.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FIXTURES } from "./perf/fixtures.mjs";
import { serve, serveAB, repoRoot } from "./perf/server.mjs";
// The pure gate logic lives in verdict.mjs so it can be unit-tested (this file
// runs Playwright/process.exit on import and can't be).
import {
    SPANS, SUB_SPANS, POST_PAINT_SPANS, GATED_FIXTURES,
    POST_PAINT_MIN_PCT, POST_PAINT_MIN_MS,
    median, round, spans, aggregate, abVerdict, postPaintVerdict, confirmRegressions,
} from "./perf/verdict.mjs";
import { acquireHarnessLock } from "./harnessLock.mjs";

// A timing capture is worthless on a contended machine (e2e/harnessLock.mjs).
acquireHarnessLock("perf");

// End marks of the POST_PAINT_SPANS. `editor-painted` is not the end of a
// launch: both of these are scheduled from the mount path onto idle and land in
// the frames just after first paint, so a sample that stops at the paint mark
// reads them as absent and their main-thread block goes unattributed (MAR-311).
const SETTLE_MARKS = ["rtp-end", "proofread-end"];
// Bound. Both are `requestIdleCallback`s with their own timeouts (2000 ms for
// round-trip protection, 1000 ms for the proofread first pass), so a bundle
// that stamps them always resolves well inside this; a bundle that does not
// (an older merge-base) pays it in full. The A/B therefore probes each side
// once, on the warmup pair, and stops waiting for what that side never stamps
// — see measureFixtureAB.
const SETTLE_TIMEOUT_MS = 3000;

// ── --compare mode: pure stats, no browser ──────────────────
async function compareMode(beforePath, afterPath) {
    const before = JSON.parse(await readFile(beforePath, "utf8"));
    const after = JSON.parse(await readFile(afterPath, "utf8"));
    console.log(`\ncompare  ${beforePath} → ${afterPath}\n`);
    let regressed = false;
    let improvedAny = false;
    for (const fixture of Object.keys(after.fixtures)) {
        const b = before.fixtures[fixture]?.median;
        const a = after.fixtures[fixture]?.median;
        if (!b || !a) continue;
        const bl = b.launch, al = a.launch;
        const dPct = ((al - bl) / bl) * 100;
        const dMs = al - bl;
        // Gate on launch: ≥3% AND ≥10ms to count as a real move (laptop noise floor).
        const real = Math.abs(dPct) >= 3 && Math.abs(dMs) >= 10;
        let verdict = "  neutral";
        if (real && dMs < 0) { verdict = "✓ improved"; improvedAny = true; }
        if (real && dMs > 0) { verdict = "✗ REGRESSED"; regressed = true; }
        const sign = dMs >= 0 ? "+" : "";
        console.log(
            `  ${fixture.padEnd(11)} launch ${round(bl)}ms → ${round(al)}ms  (${sign}${round(dMs)}ms, ${sign}${round(dPct)}%)  ${verdict}`,
        );
    }
    console.log(
        `\nverdict: ${regressed ? "REGRESSED — do not commit" : improvedAny ? "IMPROVED" : "NEUTRAL (check eager bytes)"}\n`,
    );
    process.exit(regressed ? 1 : 0);
}

// ── measure mode ────────────────────────────────────────────
async function loadPlaywright() {
    try {
        return await import("playwright");
    } catch {
        console.error("playwright is not installed. Run: pnpm install && npx playwright install chromium");
        process.exit(2);
    }
}

// One cold-start sample: open a fresh page against `url`, inject the fixture,
// wait for the `editor-painted` mark, and return its `mdw:` spans. Throws a
// labelled Error on any console/page error or failed resource — a bad chunk URL
// or thrown init is exactly the kind of regression the perf harness must not
// silently average over (this is what caught the katex.css 404). `side` labels
// which bundle aborted so an A/B failure is diagnosable without a second script.
//
// `settleMarks` additionally waits for the post-paint end marks before reading,
// and reports on `__missingSettle` whichever of them never arrived. Both modes
// pass it; the A/B narrows the list per side after its warmup pair so a bundle
// predating a mark pays the timeout once per fixture rather than once per
// sample. A caller passing `[]` reads whatever has been stamped by paint time.
async function sampleOnce(browser, url, content, fixture = "?", side = "", settleMarks = []) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} (${r.failure()?.errorText ?? "?"})`));
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
    // Inject BEFORE any page script so the stub's ready handler has it.
    await page.addInitScript((c) => { window.__perfInit = { content: c, lineMap: [] }; }, content);
    await page.goto(url, { waitUntil: "commit" });
    await page.waitForFunction(
        () => performance.getEntriesByName("mdw:editor-painted").length > 0,
        { timeout: 15000 },
    );
    let missingSettle = [];
    if (settleMarks.length) {
        missingSettle = await page.evaluate(async ([names, timeoutMs]) => {
            const absent = () => names.filter((n) => performance.getEntriesByName("mdw:" + n, "mark").length === 0);
            const deadline = performance.now() + timeoutMs;
            while (performance.now() < deadline) {
                if (absent().length === 0) { return []; }
                await new Promise((r) => setTimeout(r, 20));
            }
            return absent();
        }, [settleMarks, SETTLE_TIMEOUT_MS]);
    }
    const marks = await page.evaluate(() => {
        const m = {};
        for (const e of performance.getEntriesByType("mark")) {
            if (e.name.startsWith("mdw:")) m[e.name.slice(4)] = e.startTime;
        }
        return m;
    });
    await page.close();
    if (errors.length) {
        const where = side ? `${side} bundle, fixture "${fixture}"` : `fixture "${fixture}"`;
        const detail = [...new Set(errors)].slice(0, 6).map((e) => `    ${e}`).join("\n");
        const err = new Error(`aborted on ${where}:\n${detail}`);
        err.side = side;
        throw err;
    }
    const out = spans(marks);
    if (missingSettle.length) { out.__missingSettle = missingSettle; }
    return out;
}


async function measureFixture(chromium, baseUrl, content, runs, fixture = "?") {
    const samples = [];
    const missing = new Set();
    const browser = await chromium.launch();
    try {
        for (let i = 0; i < runs; i++) {
            try {
                const s = await sampleOnce(browser, baseUrl, content, fixture, "", SETTLE_MARKS);
                for (const m of s.__missingSettle ?? []) { missing.add(m); }
                samples.push(s);
            } catch (e) {
                console.error(`\n  ${e.message}`);
                process.exit(3);
            }
        }
    } finally {
        await browser.close();
    }
    // Discard the first run (cold caches / JIT warmup); aggregate the rest.
    const agg = aggregate(samples.slice(1));
    if (missing.size) { agg.missingSettle = [...missing]; }
    return agg;
}

async function measureMode(only, runs, jsonOut) {
    try {
        await stat(join(repoRoot, "dist", "webview.js"));
    } catch {
        console.error("dist/webview.js not found — run `pnpm build` first.");
        process.exit(2);
    }
    const names = Object.keys(FIXTURES).filter((n) => !only || n === only);
    if (names.length === 0) {
        console.error(only ? `no fixture named "${only}"` : "no fixtures");
        process.exit(2);
    }
    const { chromium } = await loadPlaywright();
    const server = serve();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const report = { fixtures: {} };
    const header = ["fixture", ...SPANS.map(([l]) => l)];
    const rows = [];
    for (const name of names) {
        const agg = await measureFixture(chromium, baseUrl, FIXTURES[name], runs, name);
        report.fixtures[name] = agg;
        rows.push([name, ...SPANS.map(([l]) => (agg.median[l] == null ? "–" : String(agg.median[l])))]);
    }
    server.close();

    // Print an aligned table of medians (ms).
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
    console.log(`\nlaunch perf — median of ${runs - 1} runs (ms)\n`);
    console.log(fmt(header));
    console.log(widths.map((w) => "─".repeat(w)).join("  "));
    for (const r of rows) console.log(fmt(r));
    console.log(`\n  ${[...POST_PAINT_SPANS].join(", ")} land AFTER editor-painted — reported, not part of launch.`);
    // A post-paint mark that never arrives is the failure this instrumentation
    // exists to make visible: `rtp` read `–` for a year because its marks were
    // deleted with the eager call site, and a dash reads exactly like "cheap".
    for (const [name, agg] of Object.entries(report.fixtures)) {
        if (agg.missingSettle) {
            console.log(`  ⚠ ${name}: no ${agg.missingSettle.join(", ")} mark within ${SETTLE_TIMEOUT_MS} ms of paint — that span is unmeasured, not zero.`);
        }
    }
    console.log("");

    if (jsonOut) {
        await writeFile(jsonOut, JSON.stringify(report, null, 2));
        console.log(`wrote ${jsonOut}\n`);
    }
}

// ── A/B mode: interleaved base-vs-head launch comparison ─────
// One interleaved fixture: measure head then base back-to-back per iteration so
// slow machine drift cancels within the pair. First pair discarded as warmup.
//
// The A/B waits for the post-paint end marks so those spans can be gated
// (MAR-314), and it learns each side's marks from the WARMUP pair rather than
// paying for them per sample. A bundle that stamps a mark satisfies the wait in
// a few ms; one that does not — a merge-base predating the mark — would pay
// SETTLE_TIMEOUT_MS on every sample, which is the cost that kept this gate
// unbuilt. Dropping the mark from that side after the warmup makes it one
// timeout per fixture instead of one per sample, and the span then aggregates
// to null and ABSTAINS in the verdict, which is the honest reading anyway.
async function measureFixtureAB(chromium, serverBase, content, runs, fixture) {
    const base = [], head = [];
    let headSettle = SETTLE_MARKS, baseSettle = SETTLE_MARKS;
    const browser = await chromium.launch();
    try {
        for (let i = 0; i < runs; i++) {
            let h, b;
            try {
                h = await sampleOnce(browser, `${serverBase}/head/`, content, fixture, "head", headSettle);
                b = await sampleOnce(browser, `${serverBase}/base/`, content, fixture, "base", baseSettle);
            } catch (e) {
                console.error(`\n  ${e.message}`);
                process.exit(3);
            }
            if (i === 0) {
                // Warmup pair: discarded as a sample, kept as the probe of which
                // marks each side actually stamps.
                const drop = (settle, s) => settle.filter((m) => !(s.__missingSettle ?? []).includes(m));
                headSettle = drop(headSettle, h);
                baseSettle = drop(baseSettle, b);
                continue;
            }
            head.push(h); base.push(b);
        }
    } finally {
        await browser.close();
    }
    return { base: aggregate(base, false), head: aggregate(head, false) };
}

function printAbTable(label, pass) {
    console.log(`\n${label} — base → head launch (median ms)\n`);
    for (const r of abVerdict(pass).rows) {
        const tag = r.empty ? "" : (r.gated ? "  " : "· "); // '·' marks report-only fixtures
        if (r.empty) { console.log(`  ${tag}${r.name.padEnd(11)} no data`); continue; }
        const sign = r.dMs >= 0 ? "+" : "";
        console.log(`  ${tag}${r.name.padEnd(11)} ${round(r.bl)}ms → ${round(r.al)}ms  (${sign}${round(r.dMs)}ms, ${sign}${round(r.dPct)}%)  ${r.mark}`);
    }
}


// The post-paint spans, printed as their own block rather than inline under the
// launch delta — they cannot compose launch, and putting `rtp +60ms` beside
// `create` and `paint` invites exactly the wrong conclusion (MAR-311).
function printPostPaint(pass) {
    const { rows } = postPaintVerdict(pass);
    if (!rows.length) return;
    console.log(`\n  post-paint spans — base → head (median ms), gated at ≥${POST_PAINT_MIN_PCT}% AND ≥${POST_PAINT_MIN_MS}ms\n`);
    for (const r of rows) {
        const tag = r.gated ? "  " : "· ";
        const where = `${r.name}:${r.span}`.padEnd(20);
        if (r.abstained) {
            // Never silent. An abstention is a gate declining to judge, and the
            // reader has to be able to tell that from a clean pass.
            console.log(`  ${tag}${where} ABSTAINED — ${r.reason}`);
            continue;
        }
        const sign = r.dMs >= 0 ? "+" : "";
        console.log(`  ${tag}${where} ${round(r.b)}ms → ${round(r.a)}ms  (${sign}${round(r.dMs)}ms, ${sign}${round(r.dPct)}%)  ${r.mark}`);
    }
}

function printAbSpans(pass) {
    for (const name of Object.keys(pass)) {
        if (!GATED_FIXTURES.has(name)) continue;
        const { base, head } = pass[name];
        const parts = [];
        for (const l of SUB_SPANS) {
            const b = base.median[l], a = head.median[l];
            if (b == null && a == null) continue;
            const d = (a ?? 0) - (b ?? 0);
            parts.push(`${l} ${round(b ?? 0)}→${round(a ?? 0)} (${d >= 0 ? "+" : ""}${round(d)})`);
        }
        if (parts.length) console.log(`    ${name}: ${parts.join("  ·  ")}`);
    }
}

async function abMode(baseDirArg, headDirArg, runs, jsonOut, accept) {
    const baseDir = resolve(baseDirArg), headDir = resolve(headDirArg);
    for (const [side, dir] of [["base", baseDir], ["head", headDir]]) {
        try { await stat(join(dir, "webview.js")); }
        catch { console.error(`${side} bundle not found: ${join(dir, "webview.js")} — build it first.`); process.exit(2); }
    }
    const { chromium } = await loadPlaywright();
    const server = serveAB({ base: baseDir, head: headDir });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const serverBase = `http://127.0.0.1:${server.address().port}`;

    const runPass = async () => {
        const pass = {};
        for (const name of Object.keys(FIXTURES)) {
            pass[name] = await measureFixtureAB(chromium, serverBase, FIXTURES[name], runs, name);
        }
        return pass;
    };

    console.log(`\nlaunch A/B — merge-base vs head, ${runs - 1} interleaved pairs/fixture`);
    console.log(`  base: ${baseDir}\n  head: ${headDir}`);
    console.log(`  gated: ${[...GATED_FIXTURES].join(", ")} (others report-only)`);

    const pass1 = await runPass();
    printAbTable("pass 1", pass1);
    printAbSpans(pass1);
    printPostPaint(pass1);
    const v1 = abVerdict(pass1);
    const p1 = postPaintVerdict(pass1);

    // Double-confirm: a gated regression must reproduce in a second full pass
    // before we fail — this is what makes a blocking browser-timing gate safe.
    // Launch and post-paint confirm INDEPENDENTLY (different key spaces, so a
    // `large` launch move can never confirm a `large:rtp` one), but either one
    // alone is enough to buy the second pass.
    let confirmed = new Set(), confirmedPostPaint = new Set();
    let pass2 = null;
    if (v1.regressed.size || p1.regressed.size) {
        const why = [...v1.regressed, ...p1.regressed].join(", ");
        console.log(`\n  pass-1 regression (${why}) — confirming with a second pass…`);
        pass2 = await runPass();
        printAbTable("pass 2", pass2);
        printPostPaint(pass2);
        confirmed = confirmRegressions(v1.regressed, abVerdict(pass2).regressed);
        confirmedPostPaint = confirmRegressions(p1.regressed, postPaintVerdict(pass2).regressed);
    }
    server.close();

    const anyConfirmed = confirmed.size + confirmedPostPaint.size;
    if (jsonOut) {
        const report = {
            base: baseDir, head: headDir, runsPerFixture: runs - 1,
            gated: [...GATED_FIXTURES],
            confirmedRegressions: [...confirmed],
            confirmedPostPaintRegressions: [...confirmedPostPaint],
            // Abstentions are part of the record: a reader has to be able to
            // tell a span that passed from one that was never judged.
            postPaintAbstentions: p1.rows.filter((r) => r.abstained).map((r) => `${r.name}:${r.span} (${r.reason})`),
            accepted: Boolean(accept) && anyConfirmed > 0, pass1, pass2,
        };
        await writeFile(jsonOut, JSON.stringify(report, null, 2));
        console.log(`\nwrote ${jsonOut}`);
    }

    if (anyConfirmed === 0) {
        console.log(
            v1.regressed.size || p1.regressed.size
                ? `\nverdict: NEUTRAL — pass-1 regression not reproduced (transient noise)\n`
                : `\nverdict: NEUTRAL — no confirmed launch or post-paint regression\n`,
        );
        process.exit(0);
    }
    const what = [
        confirmed.size ? `LAUNCH on ${[...confirmed].join(", ")}` : null,
        confirmedPostPaint.size ? `POST-PAINT on ${[...confirmedPostPaint].join(", ")}` : null,
    ].filter(Boolean).join(" + ");
    if (accept) {
        console.log(`\nverdict: REGRESSED — ${what} — ACCEPTED (${accept}); recorded, not blocking.\n`);
        process.exit(0);
    }
    console.error(
        `\nREGRESSED — ${what} — confirmed across two passes.\n` +
        (confirmed.size ? `  launch floors: ≥3% AND ≥10 ms.\n` : "") +
        (confirmedPostPaint.size
            ? `  post-paint floors: ≥${POST_PAINT_MIN_PCT}% AND ≥${POST_PAINT_MIN_MS} ms. These spans land after first paint,\n` +
              "  so they cost nothing in `launch` and everything in the window the user's\n" +
              "  first keystroke or scroll lands in (MAR-314).\n"
            : "") +
        "Boot time is first-class (AGENTS.md 'Launch performance'). Either:\n" +
        "  • fix it — defer the added work off the mount path / lazy-import it, or\n" +
        "  • accept it — add the `perf-accept` PR label or a `Perf-Regression-Accepted: <reason>` commit trailer.\n",
    );
    process.exit(1);
}

// ── arg parsing ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const compareIdx = argv.indexOf("--compare");
const abIdx = argv.indexOf("--ab");
if (compareIdx !== -1) {
    await compareMode(argv[compareIdx + 1], argv[compareIdx + 2]);
} else if (abIdx !== -1) {
    const baseDir = argv[abIdx + 1], headDir = argv[abIdx + 2];
    if (!baseDir || !headDir || baseDir.startsWith("--") || headDir.startsWith("--")) {
        console.error("usage: node e2e/perf.mjs --ab <baseDistDir> <headDistDir> [--runs N] [--json out.json] [--accept]");
        process.exit(2);
    }
    const runsIdx = argv.indexOf("--runs");
    const runs = runsIdx !== -1 ? Number(argv[runsIdx + 1]) : 10;
    if (!Number.isInteger(runs) || runs < 2) {
        console.error("--ab needs --runs >= 2 (the first pair is discarded as warmup, leaving ≥1 measured)");
        process.exit(2);
    }
    const jsonIdx = argv.indexOf("--json");
    const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : null;
    // Escape hatch for an intentional, justified launch cost (CI sets PERF_ACCEPT
    // from the `perf-accept` label or a `Perf-Regression-Accepted:` commit trailer).
    const accept = process.env.PERF_ACCEPT?.trim() || (argv.includes("--accept") ? "flag" : "");
    await abMode(baseDir, headDir, runs, jsonOut, accept);
} else {
    const runsIdx = argv.indexOf("--runs");
    const runs = runsIdx !== -1 ? Number(argv[runsIdx + 1]) : 10;
    const jsonIdx = argv.indexOf("--json");
    const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : null;
    const only = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--runs" && argv[i - 1] !== "--json");
    await measureMode(only, runs, jsonOut);
}
