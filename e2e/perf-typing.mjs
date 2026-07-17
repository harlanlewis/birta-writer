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
 *
 * Like the launch harness (e2e/perf.mjs), absolute ms drift with machine load;
 * the gate for an optimization is a SAME-SESSION A/B (--compare). Per-keystroke
 * medians are small numbers, so the noise floor is proportional: a median move
 * under 10% or under 0.5ms is neutral.
 */
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TYPING_FIXTURES } from "./perf/fixtures.mjs";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const suiteDir = join(repoRoot, "e2e", "perf");

// Plain prose, no characters that trigger input rules ([, ^, #, *, `, $...),
// so every keystroke measures the same "insert one character" transaction.
const TYPING_TEXT = "The quick brown fox jumps over the lazy dog and keeps going ";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

function serve() {
    return createServer(async (req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
        const rel = normalize(urlPath).replace(/^([/\\]|\.\.)+/, "");
        const base = rel.startsWith("dist/") ? repoRoot : suiteDir;
        const file = join(base, rel === "" || rel === "." ? "index.html" : rel);
        try {
            const body = await readFile(file);
            res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
            res.end(body);
        } catch {
            res.writeHead(404);
            res.end("not found");
        }
    });
}

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

async function measureFixture(chromium, baseUrl, content, keys, fixture) {
    const browser = await chromium.launch();
    try {
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
        await page.goto(baseUrl, { waitUntil: "commit" });
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

        const { durations, longtasks } = await page.evaluate(() => ({
            durations: performance.getEntriesByName("mdw:tx-apply").map((e) => e.duration),
            // Delivered entries plus a takeRecords() flush — observer dispatch
            // is queued, not guaranteed ordered before this task, so drain the
            // queue explicitly rather than trusting the 200 ms settle.
            longtasks: window.__longtasks
                ? [...window.__longtasks, ...window.__longtaskObs.takeRecords().map((e) => e.duration)]
                : null,
        }));
        if (errors.length) {
            console.error(`\n  aborted on fixture "${fixture}":`);
            for (const e of [...new Set(errors)].slice(0, 6)) console.error(`    ${e}`);
            process.exit(3);
        }
        if (durations.length < keys * 0.9) {
            console.error(
                `\n  fixture "${fixture}": only ${durations.length} tx-apply measures for ${keys} keystrokes — ` +
                "instrumentation missing from the bundle? (rebuild with pnpm build)",
            );
            process.exit(3);
        }
        return {
            ...stats(durations),
            blockMs: longtasks ? round(longtasks.reduce((s, d) => s + d, 0)) : null,
            blockTasks: longtasks ? longtasks.length : null,
        };
    } finally {
        await browser.close();
    }
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
        rows.push([name, `${kb} KB`, String(agg.median), String(agg.p95), String(agg.max), String(agg.blockMs ?? "n/a"), String(agg.blockTasks ?? "n/a"), String(agg.keystrokes)]);
    }
    server.close();

    const header = ["fixture", "size", "median", "p95", "max", "block", "tasks", "keystrokes"];
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

// ── arg parsing ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const compareIdx = argv.indexOf("--compare");
if (compareIdx !== -1) {
    await compareMode(argv[compareIdx + 1], argv[compareIdx + 2]);
} else {
    const keysIdx = argv.indexOf("--keys");
    const keys = keysIdx !== -1 ? Number(argv[keysIdx + 1]) : 80;
    if (!Number.isInteger(keys) || keys < 10) {
        console.error(`--keys must be an integer ≥ 10, got "${argv[keysIdx + 1]}"`);
        process.exit(2);
    }
    const jsonIdx = argv.indexOf("--json");
    const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : null;
    const only = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--keys" && argv[i - 1] !== "--json");
    await measureMode(only, keys, jsonOut);
}
