/**
 * e2e runner: drives the real built webview bundle (dist/webview.js) in
 * headless Chromium — the same production code the extension ships, minus
 * VS Code's chrome and message host (stubbed by each suite's index.html).
 *
 * Usage:
 *   pnpm build && pnpm test:e2e        # all suites
 *   node e2e/run.mjs imageView        # one suite
 *
 * Requires the playwright devDependency plus a browser install:
 *   npx playwright install chromium
 */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const e2eDir = join(repoRoot, "e2e");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".map": "application/json",
};

/** Serve /dist/* from the repo build output and everything else from the suite dir. */
function serveSuite(suiteDir) {
    return createServer(async (req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
        // Chromium auto-requests /favicon.ico; a 404 there logs a console error
        // that some suites assert against ("no page errors").
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

async function loadPlaywright() {
    try {
        return await import("playwright");
    } catch {
        console.error("playwright is not installed. Run: pnpm install && npx playwright install chromium");
        process.exit(2);
    }
}

// Confirm the bundle exists before burning browser startup time on a 404.
try {
    await stat(join(repoRoot, "dist", "webview.js"));
} catch {
    console.error("dist/webview.js not found — run `pnpm build` first.");
    process.exit(2);
}

const { chromium } = await loadPlaywright();
const only = process.argv[2];
const dirs = (await readdir(e2eDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!only || d.name === only))
    .map((d) => d.name);
// A directory is a pass/fail suite only if it has a checks.mjs. The perf
// harness (e2e/perf/) has none — it is a measurement runner (node e2e/perf.mjs),
// not a checks suite — so it is skipped here.
const suites = [];
for (const name of dirs) {
    try {
        await stat(join(e2eDir, name, "checks.mjs"));
        suites.push(name);
    } catch {
        // no checks.mjs — not a suite
    }
}
if (suites.length === 0) {
    console.error(only ? `no suite named "${only}" under e2e/` : "no suites found under e2e/");
    process.exit(2);
}

let failedTotal = 0;
for (const suite of suites) {
    const suiteDir = join(e2eDir, suite);
    const server = serveSuite(suiteDir);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => {
        if (m.type() === "error") pageErrors.push(m.text());
    });

    const results = [];
    const check = (name, ok, detail = "") => {
        results.push({ name, ok });
        console.log(`${ok ? "PASS" : "FAIL"} [${suite}] ${name}${detail ? ` — ${detail}` : ""}`);
    };

    try {
        const { run } = await import(join(suiteDir, "checks.mjs"));
        await run({ page, check, baseUrl });
        check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    } catch (e) {
        check("suite completed", false, String(e));
        const shot = join(tmpdir(), `e2e-${suite}-failure.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        console.error(`  screenshot: ${shot}`);
    }

    await browser.close();
    server.close();

    const failed = results.filter((r) => !r.ok).length;
    failedTotal += failed;
    console.log(`${suite}: ${results.length - failed}/${results.length} checks passed\n`);
}

process.exit(failedTotal ? 1 : 0);
