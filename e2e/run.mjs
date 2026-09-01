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
 *
 * BIRTA_E2E_BROWSER=webkit runs the same suites in Playwright's WebKit build
 * (npx playwright install webkit), the engine the Mac shell (mac/) renders in;
 * VS Code is Chromium, so this is the only check a WebKit-only gap can fail.
 */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { acquireHarnessLock } from "./harnessLock.mjs";

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

const BROWSER = process.env.BIRTA_E2E_BROWSER || "chromium";
if (BROWSER !== "chromium" && BROWSER !== "webkit") {
    console.error(`BIRTA_E2E_BROWSER must be "chromium" or "webkit", got "${BROWSER}".`);
    process.exit(2);
}
const playwright = await loadPlaywright();
const browserType = playwright[BROWSER];
const only = process.argv[2];
const dirs = (await readdir(e2eDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!only || d.name === only))
    .map((d) => d.name);
// A directory is a pass/fail suite only if it has a checks.mjs. The perf
// harness (e2e/perf/) is mostly a measurement runner (node e2e/perf.mjs), but it
// carries a checks.mjs of its own that asserts its INSTRUMENTATION — that the
// spans it reports are actually stamped and its fixtures actually exercise what
// they claim. Nothing else can catch a span that silently reads `–`.
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

// One harness at a time; see e2e/harnessLock.mjs for what running two costs.
acquireHarnessLock(only ? `e2e ${only}` : "e2e sweep");

let failedTotal = 0;
const skippedSuites = [];
const timings = [];
const sweepStart = Date.now();
for (const suite of suites) {
    const suiteStart = Date.now();
    const suiteDir = join(e2eDir, suite);
    const server = serveSuite(suiteDir);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const browser = await browserType.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });

    // Backspace on a document that is not editable is still "go back" in
    // WebKit, and Playwright's first navigation leaves an `about:blank` behind
    // it, so a suite that presses Backspace outside an editable region loses
    // the whole page mid-run and everything after it times out on a selector
    // that will never return.
    //
    // No host of ours can do that. A WKWebView reports `history.length` 1 after
    // loading the app's page, because its first load IS the first entry and
    // there is no `about:blank` before it, and the extension's webview is the
    // same shape. So the browser here has a back entry the product never has,
    // and modelling the host is this page's job, exactly as stubbing
    // `acquireVsCodeApi` is.
    //
    // Unconditional rather than WebKit-only, so both engines run the same
    // harness and a cross-engine difference is never this. In Chromium, which
    // dropped Backspace navigation years ago, it changes nothing.
    //
    // Scoped to targets that cannot consume the key themselves: where the
    // target IS editable the engine will not navigate anyway, and cancelling
    // there would break every suite that types.
    await page.addInitScript(() => {
        addEventListener("keydown", (e) => {
            if (e.key !== "Backspace") return;
            const t = e.target;
            const editable = t instanceof Element
                && (t.isContentEditable || t.closest("input, textarea") !== null);
            if (!editable) e.preventDefault();
        }, true);
    });

    // Console output an ENGINE emits about itself, which no product change can
    // stop and no user is affected by. Filtered so "no page errors" keeps
    // meaning "the product logged an error", and printed rather than dropped,
    // because a filter that hides things silently is how a real error joins the
    // list nobody reads.
    //
    // Each entry carries what was checked, not just what was seen:
    //
    //  * The sandbox flag. `allow-presentation` is a valid HTML token that
    //    WebKit does not implement, so it complains once per embedded player.
    //    The containment question that actually matters was measured rather
    //    than assumed: WebKit keeps all four tokens in the iframe's sandbox
    //    list and applies the three it supports, so removing the flag to
    //    silence this would cost Chromium a capability and buy nothing.
    //  * The ResizeObserver notice. Not an exception: it is the spec's way of
    //    saying a resize callback queued more work than one frame could
    //    deliver, and both engines emit it under load.
    const ENGINE_NOISE = [
        /invalid sandbox flag/i,
        /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
    ];
    const pageErrors = [];
    const noteError = (text) => {
        if (ENGINE_NOISE.some((re) => re.test(text))) {
            console.log(`NOTE [${suite}] engine noise, not counted: ${text.slice(0, 120)}`);
            return;
        }
        pageErrors.push(text);
    };
    page.on("pageerror", (e) => noteError(String(e)));
    page.on("console", (m) => {
        if (m.type() === "error") noteError(m.text());
    });
    // A console "Failed to load resource: … 404" names no URL, which makes it
    // the least actionable line a suite can fail on. The response is where the
    // URL exists, so it is printed beside it; the console error is still what
    // counts, so this adds a name rather than a second failure.
    page.on("response", (r) => {
        if (!r.ok() && !r.request().isNavigationRequest()) {
            console.log(`NOTE [${suite}] ${r.status()} for ${r.url()}`);
        }
    });
    // A suite serves its OWN directory as `/`, so `page.goto` takes
    // `${baseUrl}/index.html` — a repo-relative `${baseUrl}/e2e/<suite>/…` 404s.
    // Playwright resolves that navigation happily, and the suite then dies 30s
    // later on a waitFor timeout that reads like a product failure. Name it at
    // the moment it happens instead: plantUmlRender shipped with exactly this
    // typo and its nine checks had never run.
    page.on("response", (r) => {
        const req = r.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !r.ok()) {
            pageErrors.push(
                `navigation to ${r.url()} returned ${r.status()} — a suite is served at the ` +
                `ROOT of its own directory, so page.goto wants \`\${baseUrl}/index.html\``,
            );
        }
    });

    const results = [];
    const check = (name, ok, detail = "") => {
        results.push({ name, ok });
        console.log(`${ok ? "PASS" : "FAIL"} [${suite}] ${name}${detail ? ` — ${detail}` : ""}`);
    };
    // A suite that CANNOT run in this engine is not a suite that failed, and
    // the two must not read alike: a red count that mixes them measures the
    // harness's portability rather than the product's behaviour. The touch
    // suites are the case this exists for, since touch emulation is driven
    // through a CDP session and CDP is Chromium-only.
    //
    // Deliberately not a pass. A skip is printed, counted, and reported in the
    // suite's line, so a suite that quietly stopped running anywhere is visible
    // rather than being a green row.
    let skipped = null;
    const skip = (reason) => {
        skipped = reason;
        console.log(`SKIP [${suite}] ${reason}`);
    };

    try {
        const { run } = await import(join(suiteDir, "checks.mjs"));
        await run({ page, check, baseUrl, skip, browserName: BROWSER });
        if (!skipped) {
            check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
        }
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
    if (skipped) skippedSuites.push(suite);
    const elapsed = Date.now() - suiteStart;
    timings.push({ suite, ms: elapsed });
    console.log(skipped
        ? `${suite}: SKIPPED in ${BROWSER} (${skipped})\n`
        : `${suite}: ${results.length - failed}/${results.length} checks passed (${(elapsed / 1000).toFixed(1)}s)\n`);
}

// Where the sweep's time actually goes. Printed every run, because a suite
// that has quietly become the slow one is invisible from a total.
const sweepMs = Date.now() - sweepStart;
timings.sort((a, b) => b.ms - a.ms);
const slowest = timings.slice(0, 8)
    .map((t) => `${t.suite} ${(t.ms / 1000).toFixed(1)}s`)
    .join(", ");
console.log(`sweep: ${suites.length} suites in ${(sweepMs / 1000).toFixed(1)}s`
    + (skippedSuites.length ? `, ${skippedSuites.length} skipped in ${BROWSER}: ${skippedSuites.join(", ")}` : ""));
console.log(`slowest: ${slowest}`);

process.exit(failedTotal ? 1 : 0);
