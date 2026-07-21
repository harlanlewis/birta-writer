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
import { join, dirname, extname, normalize, resolve } from "node:path";
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

// A/B server: serves the SAME perf stub (index.html) at /base/ and /head/, with
// each variant's bundle under /<variant>/dist/*. The stub's relative asset refs
// (`dist/webview.js`, `dist/webview.css`) resolve against the /<variant>/ page
// URL, so no templating is needed — /base/ loads baseDir, /head/ loads headDir.
function serveAB(variants) {
    return createServer(async (req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
        const m = urlPath.match(/^\/(base|head)(\/.*)?$/);
        if (!m) { res.writeHead(404); res.end("not found"); return; }
        const rest = (m[2] ?? "/").replace(/^\/+/, "");
        let file;
        if (rest === "" || rest === "index.html") {
            file = join(suiteDir, "index.html");
        } else if (rest.startsWith("dist/")) {
            const asset = normalize(rest.slice("dist/".length)).replace(/^([/\\]|\.\.)+/, "");
            file = join(variants[m[1]], asset);
        } else {
            file = join(suiteDir, normalize(rest).replace(/^([/\\]|\.\.)+/, ""));
        }
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

// One cold-start sample: open a fresh page against `url`, inject the fixture,
// wait for the `editor-painted` mark, and return its `mdw:` spans. Throws a
// labelled Error on any console/page error or failed resource — a bad chunk URL
// or thrown init is exactly the kind of regression the perf harness must not
// silently average over (this is what caught the katex.css 404). `side` labels
// which bundle aborted so an A/B failure is diagnosable without a second script.
async function sampleOnce(browser, url, content, fixture = "?", side = "") {
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
    return spans(marks);
}

const aggregate = (samples, withMin = true) => {
    const agg = { median: {}, runs: samples.length };
    if (withMin) agg.min = {};
    for (const [label] of SPANS) {
        const vals = samples.map((s) => s[label]).filter((v) => v != null);
        agg.median[label] = vals.length ? round(median(vals)) : null;
        if (withMin) agg.min[label] = vals.length ? round(Math.min(...vals)) : null;
    }
    return agg;
};

async function measureFixture(chromium, baseUrl, content, runs, fixture = "?") {
    const samples = [];
    const browser = await chromium.launch();
    try {
        for (let i = 0; i < runs; i++) {
            try {
                samples.push(await sampleOnce(browser, baseUrl, content, fixture));
            } catch (e) {
                console.error(`\n  ${e.message}`);
                process.exit(3);
            }
        }
    } finally {
        await browser.close();
    }
    // Discard the first run (cold caches / JIT warmup); aggregate the rest.
    return aggregate(samples.slice(1));
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

// ── A/B mode: interleaved base-vs-head launch comparison ─────
// Only these fixtures fail the gate — their launch medians (~274 ms / ~944 ms)
// dwarf the 10 ms noise floor, so a real move is unambiguous. The small ones
// are reported for context but never block (their absolutes are proportionally
// noisier).
const GATED_FIXTURES = new Set(["medium", "large"]);

// One interleaved fixture: measure head then base back-to-back per iteration so
// slow machine drift cancels within the pair. First pair discarded as warmup.
async function measureFixtureAB(chromium, serverBase, content, runs, fixture) {
    const base = [], head = [];
    const browser = await chromium.launch();
    try {
        for (let i = 0; i < runs; i++) {
            let h, b;
            try {
                h = await sampleOnce(browser, `${serverBase}/head/`, content, fixture, "head");
                b = await sampleOnce(browser, `${serverBase}/base/`, content, fixture, "base");
            } catch (e) {
                console.error(`\n  ${e.message}`);
                process.exit(3);
            }
            if (i === 0) continue; // warmup pair
            head.push(h); base.push(b);
        }
    } finally {
        await browser.close();
    }
    return { base: aggregate(base, false), head: aggregate(head, false) };
}

// Per-fixture launch verdict using the same noise floor as --compare: a move
// counts only at ≥3% AND ≥10 ms. Returns the set of GATED fixtures that regressed.
function abVerdict(pass) {
    const rows = [];
    const regressed = new Set();
    for (const [name, r] of Object.entries(pass)) {
        const bl = r.base.median.launch, al = r.head.median.launch;
        if (bl == null || al == null) { rows.push({ name, empty: true }); continue; }
        const dMs = al - bl, dPct = (dMs / bl) * 100;
        const real = Math.abs(dPct) >= 3 && Math.abs(dMs) >= 10;
        const gated = GATED_FIXTURES.has(name);
        let mark = "  neutral";
        if (real && dMs > 0) { mark = gated ? "✗ REGRESSED" : "✗ slower (ungated)"; if (gated) regressed.add(name); }
        else if (real && dMs < 0) mark = "✓ faster";
        rows.push({ name, bl, al, dMs, dPct, gated, mark });
    }
    return { rows, regressed };
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
    const v1 = abVerdict(pass1);

    // Double-confirm: a gated regression must reproduce in a second full pass
    // before we fail — this is what makes a blocking browser-timing gate safe.
    const confirmed = new Set();
    let pass2 = null;
    if (v1.regressed.size) {
        console.log(`\n  pass-1 regression (${[...v1.regressed].join(", ")}) — confirming with a second pass…`);
        pass2 = await runPass();
        printAbTable("pass 2", pass2);
        const v2 = abVerdict(pass2);
        for (const f of v1.regressed) if (v2.regressed.has(f)) confirmed.add(f);
    }
    server.close();

    if (jsonOut) {
        const report = {
            base: baseDir, head: headDir, runsPerFixture: runs - 1,
            gated: [...GATED_FIXTURES], confirmedRegressions: [...confirmed],
            accepted: Boolean(accept) && confirmed.size > 0, pass1, pass2,
        };
        await writeFile(jsonOut, JSON.stringify(report, null, 2));
        console.log(`\nwrote ${jsonOut}`);
    }

    if (confirmed.size === 0) {
        console.log(
            v1.regressed.size
                ? `\nverdict: NEUTRAL — pass-1 regression not reproduced (transient noise)\n`
                : `\nverdict: NEUTRAL — no confirmed launch regression\n`,
        );
        process.exit(0);
    }
    if (accept) {
        console.log(`\nverdict: REGRESSED on ${[...confirmed].join(", ")} — ACCEPTED (${accept}); recorded, not blocking.\n`);
        process.exit(0);
    }
    console.error(
        `\nLAUNCH REGRESSED on ${[...confirmed].join(", ")} — confirmed across two passes (≥3% AND ≥10 ms).\n` +
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
