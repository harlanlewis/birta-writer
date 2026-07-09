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
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "./perf/fixtures.mjs";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const suiteDir = join(repoRoot, "e2e", "perf");

// Spans derived from the marks, in display order. Each is [label, startMark, endMark].
// `launch` is the headline number: navigation start (0) → first painted frame.
const SPANS = [
    ["launch", null, "editor-painted"],
    ["eager", "eval-start", "ready-posted"],
    ["roundtrip", "ready-posted", "init-received"],
    ["create", "create-start", "create-end"],
    ["rtp", "rtp-start", "rtp-end"],
    ["toc", "toc-start", "toc-end"],
    ["toolbar", "toolbar-start", "toolbar-end"],
];

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
        // Chromium auto-requests /favicon.ico on the first page of a context; a
        // 404 there logs a console error that would abort the strict runner.
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

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x * 10) / 10;

function spans(marks) {
    const out = {};
    for (const [label, start, end] of SPANS) {
        const a = start ? marks[start] : 0;
        const b = marks[end];
        out[label] = a != null && b != null ? b - a : null;
    }
    return out;
}

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

async function measureFixture(chromium, baseUrl, content, runs, fixture = "?") {
    const samples = [];
    const browser = await chromium.launch();
    try {
        for (let i = 0; i < runs; i++) {
            const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
            const errors = [];
            // Any console/page error or failed resource aborts the run — a bad
            // chunk URL or thrown init is exactly the kind of regression the perf
            // harness must not silently average over (this is what caught the
            // katex.css 404). Capture the offending URL so the abort is
            // diagnosable without a second script.
            page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
            page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
            page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} (${r.failure()?.errorText ?? "?"})`));
            page.on("response", (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
            // Inject BEFORE any page script so the stub's ready handler has it.
            await page.addInitScript((c) => { window.__perfInit = { content: c, lineMap: [] }; }, content);
            await page.goto(baseUrl, { waitUntil: "commit" });
            await page.waitForFunction(
                () => performance.getEntriesByName("mdw:editor-painted").length > 0,
                { timeout: 15000 },
            );
            const marks = await page.evaluate(() => {
                const m = {};
                for (const e of performance.getEntriesByType("mark")) {
                    if (e.name.startsWith("mdw:")) m[e.name.slice(4)] = e.startTime;
                }
                return m;
            });
            await page.close();
            if (errors.length) {
                console.error(`\n  aborted on fixture "${fixture}" run ${i}:`);
                for (const e of [...new Set(errors)].slice(0, 6)) console.error(`    ${e}`);
                process.exit(3);
            }
            samples.push(spans(marks));
        }
    } finally {
        await browser.close();
    }
    // Discard the first run (cold caches / JIT warmup); aggregate the rest.
    const kept = samples.slice(1);
    const agg = { median: {}, min: {}, runs: kept.length };
    for (const [label] of SPANS) {
        const vals = kept.map((s) => s[label]).filter((v) => v != null);
        agg.median[label] = vals.length ? round(median(vals)) : null;
        agg.min[label] = vals.length ? round(Math.min(...vals)) : null;
    }
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
    const runsIdx = argv.indexOf("--runs");
    const runs = runsIdx !== -1 ? Number(argv[runsIdx + 1]) : 10;
    const jsonIdx = argv.indexOf("--json");
    const jsonOut = jsonIdx !== -1 ? argv[jsonIdx + 1] : null;
    const only = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--runs" && argv[i - 1] !== "--json");
    await measureMode(only, runs, jsonOut);
}
