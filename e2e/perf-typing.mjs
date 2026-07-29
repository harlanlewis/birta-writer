/**
 * Typing-performance runner: drives the real built webview bundle
 * (dist/webview.js) in headless Chromium, types real keystrokes into each
 * fixture, and reads the `mdw:tx-apply` User-Timing measures the bundle stamps
 * around every doc-changing transaction (see instrumentTransactions in
 * webview/perf.ts). One measure = the synchronous DISPATCH block of one
 * keystroke: state apply + view DOM reconciliation + every plugin view's
 * update. That is the dominant slice of MAR-137's per-keystroke cost, but not
 * all of it — ProseMirror's pre-dispatch input path and rAF-coalesced
 * followers (TOC refresh, the scheduled serialize) fall outside the span
 * (~1/3 of a typing burst's total main-thread block on the 300 KB fixture).
 * The `block` column closes that blind spot (MAR-163): a buffered longtask
 * observer sums every main-thread task ≥50 ms during the measured burst, so a
 * change that merely MOVES work out of dispatch into a rAF still shows in
 * `block` even while the median "improves". Granularity caveat: tasks under
 * 50 ms are invisible to it, so `block` only carries signal on fixtures whose
 * per-keystroke tasks already blow the frame budget (large/xlarge) — on the
 * small fixtures it reads 0 and the dispatch median is the only gate.
 *
 * Usage:
 *   pnpm build && pnpm perf:typing               # all fixtures, table output
 *   node e2e/perf-typing.mjs large               # one fixture
 *   node e2e/perf-typing.mjs --keys 120 --json after.json
 *   node e2e/perf-typing.mjs --compare before.json after.json  # A/B, no browser
 *   node e2e/perf-typing.mjs --ab dist-base dist-head           # interleaved A/B
 *
 * Like the launch harness (e2e/perf.mjs), absolute ms drift with machine load;
 * the gate for an optimization is a SAME-SESSION A/B. `--compare` diffs two
 * self-captured JSONs; `--ab` is the stronger form and the one CI runs — it
 * interleaves both bundles in ONE browser session so machine drift cancels
 * within each pair, and double-confirms a regression across two full passes
 * before failing (`pnpm perf:typing:ab` builds the two bundles for it).
 * Per-keystroke medians are small numbers, so the noise floor is proportional:
 * a median move under 10% or under 0.5ms is neutral.
 */
import { stat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TYPING_FIXTURES } from "./perf/fixtures.mjs";
import { serve, serveAB, repoRoot } from "./perf/server.mjs";
// The pure gate logic lives in verdict.mjs so the check that blocks every PR is
// unit-testable (this file runs Playwright/process.exit on import and can't be).
import {
    TYPING_GATED_FIXTURES, typingAbVerdict, confirmRegressions,
} from "./perf/verdict.mjs";

// Plain prose, no characters that trigger input rules ([, ^, #, *, `, $...),
// so every keystroke measures the same "insert one character" transaction.
const TYPING_TEXT = "The quick brown fox jumps over the lazy dog and keeps going ";

// Caret moves per sample. Small on purpose: a selection transaction is far
// cheaper than a keystroke, so the median settles quickly, and every one of
// these is added CI wall-clock on the most expensive job in the repo.
const CARET_MOVES = 30;

// A/B mode measures ONLY the gated fixtures — currently just `xlarge`.
//
// This is a cost decision made from measurement. Per sample on a dev laptop,
// `xlarge` costs ~6.4 s to mount + ~8 s for an 80-key burst; `large` ~1.3 s +
// ~3.5 s. A CI runner is ~2× slower again. Every fixture in this list is that
// cost × 2 sides × (pairs + 1 warmup), twice over if a regression needs
// confirming — which is how the first shipped configuration reached ~8 min of
// CI on every PR.
//
// The smaller fixtures cannot inform the decision anyway: `medium` measured
// 1.8 ms per keystroke on CI, so even a large percentage move is a fraction of
// the gate's own 0.5 ms absolute floor. A number that cannot fire the gate is
// not context, it is cost. `large` was dropped on the same reasoning at the
// margin — ~1/5 the sensitivity of `xlarge` for a third of the runtime, and a
// regression that scales with document size shows on `xlarge` first.
//
// Run `pnpm perf:typing` for the full fixture spread when investigating.
const AB_FIXTURES = [...TYPING_GATED_FIXTURES];

const round = (x) => Math.round(x * 100) / 100;
const quantile = (sorted, q) => {
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

function stats(samples) {
    const s = [...samples].sort((a, b) => a - b);
    return {
        keystrokes: s.length,
        median: round(quantile(s, 0.5)),
        p95: round(quantile(s, 0.95)),
        max: round(s[s.length - 1]),
    };
}

// ── --compare mode: pure stats, no browser ──────────────────
async function compareMode(beforePath, afterPath) {
    const before = JSON.parse(await readFile(beforePath, "utf8"));
    const after = JSON.parse(await readFile(afterPath, "utf8"));
    console.log(`\ncompare  ${beforePath} → ${afterPath}\n`);
    let regressed = false;
    let improvedAny = false;
    let compared = 0;
    for (const fixture of Object.keys(after.fixtures)) {
        const b = before.fixtures[fixture];
        const a = after.fixtures[fixture];
        if (!b || !a) continue;
        compared++;
        if (b.keystrokes !== a.keystrokes) {
            console.warn(`  ${fixture}: keystroke counts differ (${b.keystrokes} vs ${a.keystrokes}) — medians are not like-for-like`);
        }
        const dMs = a.median - b.median;
        const dPct = (dMs / b.median) * 100;
        // Real move: ≥10% AND ≥0.5ms — per-keystroke medians are single-digit
        // ms, so the launch harness's 3%+10ms gate would never fire here.
        const real = Math.abs(dPct) >= 10 && Math.abs(dMs) >= 0.5;
        let verdict = "  neutral";
        if (real && dMs < 0) { verdict = "✓ improved"; improvedAny = true; }
        if (real && dMs > 0) { verdict = "✗ REGRESSED"; regressed = true; }
        const sign = dMs >= 0 ? "+" : "";
        let blockNote = "";
        // Companion gate (MAR-163): total longtask block over the burst. Missing
        // in pre-metric JSONs — skip silently rather than fake a zero baseline.
        // Coarser thresholds than the median (whole-burst sum, ≥50 ms task
        // granularity): a real move is ≥25% AND ≥250 ms.
        if (typeof b.blockMs === "number" && typeof a.blockMs === "number") {
            const dBlock = a.blockMs - b.blockMs;
            const dBlockPct = b.blockMs > 0 ? (dBlock / b.blockMs) * 100 : (a.blockMs > 0 ? 100 : 0);
            const realBlock = Math.abs(dBlockPct) >= 25 && Math.abs(dBlock) >= 250;
            const bSign = dBlock >= 0 ? "+" : "";
            blockNote = `  block ${round(b.blockMs)}ms → ${round(a.blockMs)}ms (${bSign}${round(dBlockPct)}%)`;
            if (realBlock && dBlock > 0) {
                verdict = "✗ REGRESSED (block)";
                regressed = true;
                // The moral hazard the metric exists to catch: dispatch median
                // "improved" while total main-thread block grew — work moved,
                // not removed.
                if (real && dMs < 0) blockNote += "  ⚠ median improved but block regressed — work was moved, not removed";
            } else if (realBlock && dBlock < 0) {
                improvedAny = true;
            }
        }
        // Caret (selection-only dispatch) — gated on the same floors as the
        // typing median. Missing in pre-metric JSONs: skip rather than invent a
        // zero baseline, exactly as `block` does.
        let caretNote = "";
        if (typeof b.caretMedian === "number" && typeof a.caretMedian === "number") {
            const dCaret = a.caretMedian - b.caretMedian;
            const dCaretPct = b.caretMedian > 0 ? (dCaret / b.caretMedian) * 100 : (a.caretMedian > 0 ? 100 : 0);
            const realCaret = Math.abs(dCaretPct) >= 10 && Math.abs(dCaret) >= 0.5;
            const cSign = dCaret >= 0 ? "+" : "";
            caretNote = `  caret ${round(b.caretMedian)}ms → ${round(a.caretMedian)}ms (${cSign}${round(dCaretPct)}%)`;
            if (realCaret && dCaret > 0) {
                verdict = "✗ REGRESSED (caret)";
                regressed = true;
                caretNote += "  ⚠ moving the caret got more expensive";
            } else if (realCaret && dCaret < 0) {
                improvedAny = true;
            }
        }
        console.log(
            `  ${fixture.padEnd(8)} median ${round(b.median)}ms → ${round(a.median)}ms ` +
            `(${sign}${round(dMs)}ms, ${sign}${round(dPct)}%)  p95 ${round(b.p95)}ms → ${round(a.p95)}ms  ${verdict}${blockNote}`,
        );
    }
    if (compared === 0) {
        // A verdict that compared nothing must not read as NEUTRAL.
        console.error("no fixture appears in BOTH files — nothing was compared");
        process.exit(2);
    }
    console.log(
        `\nverdict: ${regressed ? "REGRESSED — do not commit" : improvedAny ? "IMPROVED" : "NEUTRAL"}\n`,
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

/**
 * One typing burst against `url`: mount the fixture, warm up, type `keys`
 * characters, and return the raw per-keystroke dispatch durations plus the
 * burst's total longtask block. Throws a labelled Error on any console/page
 * error — a thrown init or a bad chunk URL is exactly the kind of regression
 * the harness must not silently average over. `side` labels which bundle
 * aborted so an A/B failure is diagnosable without a second script.
 */
async function sampleTyping(browser, url, content, keys, fixture = "?", side = "") {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    // Same strict posture as the launch harness: any page error aborts the
    // run rather than being silently averaged over.
    page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} (${r.failure()?.errorText ?? "?"})`));
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
    await page.addInitScript((c) => { window.__perfInit = { content: c, lineMap: [] }; }, content);
    // Longtask companion (MAR-163): everything the dispatch span misses —
    // pre-dispatch input path, TOC rAF refresh, scheduled serialize — still
    // lands in ≥50 ms main-thread tasks on the big fixtures. Installed
    // before the bundle boots so nothing is missed; reset with the measures
    // when the measured burst starts.
    // The block window ends 200 ms after the last keystroke, so work a
    // change DEFERS past that (a longer trailing debounce) leaves the
    // window and reads as an improvement — the same hazard one timer
    // further out. A bounded window can't chase arbitrary deferral; check
    // a surprising win in a devtools trace.
    await page.addInitScript(() => {
        window.__longtasks = [];
        try {
            window.__longtaskObs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) window.__longtasks.push(e.duration);
            });
            window.__longtaskObs.observe({ type: "longtask", buffered: true });
        } catch {
            // Runtime without longtask support: recorded as null so compare
            // mode skips the block gate instead of treating 0 as a real
            // baseline. The dispatch median still gates.
            window.__longtasks = null;
        }
    });
    await page.goto(url, { waitUntil: "commit" });
    await page.waitForFunction(
        () => performance.getEntriesByName("mdw:editor-painted").length > 0,
        { timeout: 30000 },
    );

    // Cursor into the first paragraph; let post-create normalization and
    // deferred work (protection recompute, TOC) settle before measuring.
    await page.click(".milkdown .ProseMirror p");
    await page.waitForTimeout(500);

    // Warmup keystrokes (JIT, first-touch lazy paths), then discard every
    // measure recorded so far and type the measured burst.
    await page.keyboard.type(TYPING_TEXT.slice(0, 10), { delay: 30 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        performance.clearMeasures("mdw:tx-apply");
        if (window.__longtasks) {
            // Flush warmup-era entries still queued in the observer so they
            // can't be delivered into the measured burst, then drop both.
            window.__longtaskObs.takeRecords();
            window.__longtasks.length = 0;
        }
    });

    let typed = "";
    while (typed.length < keys) typed += TYPING_TEXT;
    await page.keyboard.type(typed.slice(0, keys), { delay: 30 });
    // Let the last keystroke's transaction land before reading.
    await page.waitForTimeout(200);

    // ── Caret burst (MAR-137) ───────────────────────────────────────────
    // Selection-only transactions were the one class nothing measured, which
    // is exactly how a 2.4 ms-per-arrow-key cost hid in an upstream plugin
    // that walked the whole document above its own docChanged test. Two things
    // about the placement are deliberate:
    //   - It runs on the ALREADY-MOUNTED page. Mount is ~38% of an xlarge
    //     sample, so folding this in costs burst time only, not a second mount.
    //   - It runs AFTER the typed burst, never before. Arrow keys walk the
    //     caret into whatever the fixture holds, and `xlarge` is 440 sections
    //     of prose + table + code block: starting the typed burst from a caret
    //     parked in a code block measured 38.5 ms/key against prose's 5.4,
    //     because a caret inside a code block re-highlights the whole document
    //     on every keystroke. Ordering these the other way silently changed
    //     what the headline typing median means.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.evaluate(() => performance.clearMeasures("mdw:tx-select"));
    for (let i = 0; i < CARET_MOVES; i++) {
        await page.keyboard.press(i % 2 === 0 ? "ArrowDown" : "ArrowRight");
    }
    await page.waitForTimeout(150);

    const { durations, longtasks, caret } = await page.evaluate(() => ({
        durations: performance.getEntriesByName("mdw:tx-apply").map((e) => e.duration),
        // Delivered entries plus a takeRecords() flush — observer dispatch
        // is queued, not guaranteed ordered before this task, so drain the
        // queue explicitly rather than trusting the 200 ms settle.
        longtasks: window.__longtasks
            ? [...window.__longtasks, ...window.__longtaskObs.takeRecords().map((e) => e.duration)]
            : null,
        caret: performance.getEntriesByName("mdw:tx-select").map((e) => e.duration),
    }));
    await page.close();
    const where = side ? `${side} bundle, fixture "${fixture}"` : `fixture "${fixture}"`;
    if (errors.length) {
        const detail = [...new Set(errors)].slice(0, 6).map((e) => `    ${e}`).join("\n");
        throw new Error(`aborted on ${where}:\n${detail}`);
    }
    if (durations.length < keys * 0.9) {
        throw new Error(
            `${where}: only ${durations.length} tx-apply measures for ${keys} keystrokes — ` +
            "instrumentation missing from the bundle? (rebuild with pnpm build)",
        );
    }
    return {
        durations,
        caret,
        blockMs: longtasks ? round(longtasks.reduce((s, d) => s + d, 0)) : null,
        blockTasks: longtasks ? longtasks.length : null,
    };
}

async function measureFixture(chromium, baseUrl, content, keys, fixture) {
    const browser = await chromium.launch();
    let s;
    try {
        s = await sampleTyping(browser, baseUrl, content, keys, fixture);
    } catch (e) {
        console.error(`\n  ${e.message}`);
        process.exit(3);
    } finally {
        await browser.close();
    }
    const caret = s.caret && s.caret.length ? stats(s.caret) : null;
    return {
        ...stats(s.durations),
        blockMs: s.blockMs,
        blockTasks: s.blockTasks,
        // Selection-only dispatch: reported next to typing, and gated the same
        // way, because nothing else in the repo can see this cost (MAR-137).
        caretMedian: caret ? caret.median : null,
        caretMoves: caret ? caret.keystrokes : null,
    };
}

async function measureMode(only, keys, jsonOut) {
    try {
        await stat(join(repoRoot, "dist", "webview.js"));
    } catch {
        console.error("dist/webview.js not found — run `pnpm build` first.");
        process.exit(2);
    }
    const names = Object.keys(TYPING_FIXTURES).filter((n) => !only || n === only);
    if (names.length === 0) {
        console.error(only ? `no typing fixture named "${only}"` : "no fixtures");
        process.exit(2);
    }
    const { chromium } = await loadPlaywright();
    const server = serve();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const report = { fixtures: {} };
    const rows = [];
    for (const name of names) {
        const agg = await measureFixture(chromium, baseUrl, TYPING_FIXTURES[name], keys, name);
        const kb = round(TYPING_FIXTURES[name].length / 1024);
        report.fixtures[name] = { ...agg, kb };
        rows.push([name, `${kb} KB`, String(agg.median), String(agg.p95), String(agg.max), String(agg.caretMedian ?? "n/a"), String(agg.blockMs ?? "n/a"), String(agg.blockTasks ?? "n/a"), String(agg.keystrokes)]);
    }
    server.close();

    const header = ["fixture", "size", "median", "p95", "max", "caret", "block", "tasks", "keystrokes"];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
    console.log(`\ntyping perf — per-keystroke dispatch, ms (mdw:tx-apply) + total longtask block over the burst (block)\n`);
    console.log(fmt(header));
    console.log(widths.map((w) => "─".repeat(w)).join("  "));
    for (const r of rows) console.log(fmt(r));
    console.log("");

    if (jsonOut) {
        await writeFile(jsonOut, JSON.stringify(report, null, 2));
        console.log(`wrote ${jsonOut}\n`);
    }
}

// ── A/B mode: interleaved base-vs-head typing comparison ─────
// One interleaved fixture: type a burst against head then base back-to-back per
// iteration so slow machine drift cancels within the pair. First pair discarded
// as warmup. Durations are POOLED across pairs before taking the median — each
// burst is ~`keys` samples of the same operation, so the pool is the honest
// population; a median-of-medians would throw away most of it.
async function measureFixtureTypingAB(chromium, serverBase, content, keys, runs, fixture) {
    const base = [], head = [];
    const baseBlock = [], headBlock = [];
    const baseCaret = [], headCaret = [];
    const browser = await chromium.launch();
    try {
        for (let i = 0; i < runs; i++) {
            let h, b;
            try {
                h = await sampleTyping(browser, `${serverBase}/head/`, content, keys, fixture, "head");
                b = await sampleTyping(browser, `${serverBase}/base/`, content, keys, fixture, "base");
            } catch (e) {
                console.error(`\n  ${e.message}`);
                process.exit(3);
            }
            if (i === 0) continue; // warmup pair
            head.push(...h.durations); base.push(...b.durations);
            headBlock.push(h.blockMs); baseBlock.push(b.blockMs);
            // Caret samples pool like the keystroke durations do: each burst is
            // CARET_MOVES samples of the same operation, so the pool is the
            // honest population (block cannot be pooled — it is a burst SUM).
            headCaret.push(...(h.caret ?? [])); baseCaret.push(...(b.caret ?? []));
        }
    } finally {
        await browser.close();
    }
    // A burst's block is a whole-burst SUM, so it cannot be pooled with the
    // per-keystroke durations — take the median across bursts. Any null (no
    // longtask support) makes the whole metric null rather than a fake zero.
    const blockOf = (xs) => (xs.some((x) => x == null) ? null : round(quantile([...xs].sort((a, b) => a - b), 0.5)));
    // An empty pool means the bundle predates the caret metric (an older
    // merge-base). Null, never 0 — a zero baseline would read as a 100%
    // regression on every A/B against an older commit.
    const caretOf = (xs) => (xs.length ? stats(xs).median : null);
    return {
        base: { ...stats(base), blockMs: blockOf(baseBlock), caretMedian: caretOf(baseCaret) },
        head: { ...stats(head), blockMs: blockOf(headBlock), caretMedian: caretOf(headCaret) },
    };
}

function printTypingAbTable(label, pass) {
    console.log(`\n${label} — base → head per-keystroke dispatch (median ms)\n`);
    for (const r of typingAbVerdict(pass).rows) {
        // '·' marks a report-only fixture. AB_FIXTURES currently equals the
        // gated set, so this never renders in A/B — it is kept because the
        // verdict is generic over any pass (and is unit-tested for it), so
        // re-adding a report-only fixture needs no display change.
        const tag = r.empty ? "" : (r.gated ? "  " : "· ");
        if (r.empty) { console.log(`  ${tag}${r.name.padEnd(8)} no data`); continue; }
        const sign = r.dMs >= 0 ? "+" : "";
        let block = "";
        if (r.block) {
            const bSign = r.block.dBlock >= 0 ? "+" : "";
            block = `  block ${round(r.block.bb)}ms → ${round(r.block.ab)}ms (${bSign}${round(r.block.dBlockPct)}%)`;
        }
        // Caret is GATED, so it prints its own verdict word rather than riding
        // the typing median's — a run can be neutral on typing and regressed on
        // caret, which is the case this metric was added for.
        let caret = "";
        if (r.caret) {
            const cSign = r.caret.dCaret >= 0 ? "+" : "";
            const cMark = r.caret.realCaret
                ? (r.caret.dCaret > 0 ? (r.gated ? " \u2717 REGRESSED" : " slower") : " \u2713 faster")
                : "";
            caret = `  caret ${round(r.caret.bc)}ms \u2192 ${round(r.caret.ac)}ms (${cSign}${round(r.caret.dCaretPct)}%)${cMark}`;
        }
        console.log(
            `  ${tag}${r.name.padEnd(8)} ${round(r.bm)}ms → ${round(r.am)}ms  ` +
            `(${sign}${round(r.dMs)}ms, ${sign}${round(r.dPct)}%)  ${r.mark}${caret}${block}`,
        );
        if (r.blockNote) console.log(`      ${r.blockNote}`);
    }
}

async function abMode(baseDirArg, headDirArg, keys, runs, jsonOut, accept) {
    const baseDir = resolve(baseDirArg), headDir = resolve(headDirArg);
    for (const [side, dir] of [["base", baseDir], ["head", headDir]]) {
        try { await stat(join(dir, "webview.js")); }
        catch { console.error(`${side} bundle not found: ${join(dir, "webview.js")} — build it first.`); process.exit(2); }
    }
    // A renamed fixture would otherwise reach sampleTyping as `undefined`
    // content and fail deep inside Playwright with nothing naming the cause.
    const missing = AB_FIXTURES.filter((n) => !(n in TYPING_FIXTURES));
    if (missing.length) {
        console.error(`AB_FIXTURES names a fixture that no longer exists in TYPING_FIXTURES: ${missing.join(", ")}`);
        process.exit(2);
    }
    const { chromium } = await loadPlaywright();
    const server = serveAB({ base: baseDir, head: headDir });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const serverBase = `http://127.0.0.1:${server.address().port}`;

    const runPass = async () => {
        const pass = {};
        for (const name of AB_FIXTURES) {
            pass[name] = await measureFixtureTypingAB(chromium, serverBase, TYPING_FIXTURES[name], keys, runs, name);
        }
        return pass;
    };

    const skipped = Object.keys(TYPING_FIXTURES).filter((n) => !AB_FIXTURES.includes(n));
    console.log(`\ntyping A/B — merge-base vs head, ${runs - 1} interleaved pairs/fixture × ${keys} keystrokes`);
    console.log(`  base: ${baseDir}\n  head: ${headDir}`);
    console.log(`  gated: ${AB_FIXTURES.join(", ")} (not measured here: ${skipped.join(", ")} — see AB_FIXTURES; run \`pnpm perf:typing\` for the full spread)`);

    const pass1 = await runPass();
    printTypingAbTable("pass 1", pass1);
    const v1 = typingAbVerdict(pass1);

    // Double-confirm: a gated regression must reproduce in a second full pass
    // before we fail. Typing is noisier than launch, so this is load-bearing.
    let confirmed = new Set();
    let pass2 = null;
    if (v1.regressed.size) {
        console.log(`\n  pass-1 regression (${[...v1.regressed].join(", ")}) — confirming with a second pass…`);
        pass2 = await runPass();
        printTypingAbTable("pass 2", pass2);
        confirmed = confirmRegressions(v1.regressed, typingAbVerdict(pass2).regressed);
    }
    server.close();

    if (jsonOut) {
        const report = {
            base: baseDir, head: headDir, keys, pairsPerFixture: runs - 1,
            gated: [...TYPING_GATED_FIXTURES], confirmedRegressions: [...confirmed],
            accepted: Boolean(accept) && confirmed.size > 0, pass1, pass2,
        };
        await writeFile(jsonOut, JSON.stringify(report, null, 2));
        console.log(`\nwrote ${jsonOut}`);
    }

    if (confirmed.size === 0) {
        console.log(
            v1.regressed.size
                ? `\nverdict: NEUTRAL — pass-1 regression not reproduced (transient noise)\n`
                : `\nverdict: NEUTRAL — no confirmed typing regression\n`,
        );
        process.exit(0);
    }
    if (accept) {
        console.log(`\nverdict: REGRESSED on ${[...confirmed].join(", ")} — ACCEPTED (${accept}); recorded, not blocking.\n`);
        process.exit(0);
    }
    console.error(
        `\nTYPING REGRESSED on ${[...confirmed].join(", ")} — confirmed across two passes (≥10% AND ≥0.5 ms per keystroke).\n` +
        "Every keystroke pays this cost on a large document. Either:\n" +
        "  • fix it — the usual culprit is per-transaction work that scales with document size\n" +
        "    (mapping a whole DecorationSet, walking the doc) rather than with the change, or\n" +
        "  • accept it — add the `perf-accept` PR label or a `Perf-Regression-Accepted: <reason>` commit trailer.\n",
    );
    process.exit(1);
}

// ── arg parsing ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const compareIdx = argv.indexOf("--compare");
const abIdx = argv.indexOf("--ab");
const keysOf = () => {
    const i = argv.indexOf("--keys");
    const keys = i !== -1 ? Number(argv[i + 1]) : 80;
    if (!Number.isInteger(keys) || keys < 10) {
        console.error(`--keys must be an integer ≥ 10, got "${argv[i + 1]}"`);
        process.exit(2);
    }
    return keys;
};
if (compareIdx !== -1) {
    await compareMode(argv[compareIdx + 1], argv[compareIdx + 2]);
} else if (abIdx !== -1) {
    const baseDir = argv[abIdx + 1], headDir = argv[abIdx + 2];
    if (!baseDir || !headDir || baseDir.startsWith("--") || headDir.startsWith("--")) {
        console.error("usage: node e2e/perf-typing.mjs --ab <baseDistDir> <headDistDir> [--keys N] [--runs N] [--json out.json] [--accept]");
        process.exit(2);
    }
    const runsIdx = argv.indexOf("--runs");
    const runs = runsIdx !== -1 ? Number(argv[runsIdx + 1]) : 5;
    if (!Number.isInteger(runs) || runs < 2) {
        console.error("--ab needs --runs >= 2 (the first pair is discarded as warmup, leaving ≥1 measured)");
        process.exit(2);
    }
    const jsonIdx = argv.indexOf("--json");
    const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : null;
    // Escape hatch for an intentional, justified typing cost — the SAME hatch
    // the launch gate uses (the `perf-accept` label / `Perf-Regression-Accepted:`
    // trailer), deliberately not a second one.
    const accept = process.env.PERF_ACCEPT?.trim() || (argv.includes("--accept") ? "flag" : "");
    await abMode(baseDir, headDir, keysOf(), runs, jsonOut, accept);
} else {
    const jsonIdx = argv.indexOf("--json");
    const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : null;
    const only = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--keys" && argv[i - 1] !== "--json");
    await measureMode(only, keysOf(), jsonOut);
}
