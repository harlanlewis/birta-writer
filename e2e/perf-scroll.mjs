/**
 * Scroll-performance runner: drives the real built webview bundle
 * (dist/webview.js) on a fixture, scrolls it one step per animation frame
 * from inside the page, and reads what the main thread did while the
 * viewport moved.
 *
 * Scrolling is the one gesture the other runners never make. `pnpm perf`
 * reads open, `pnpm perf:typing` reads the keystroke, and the count gate
 * behind `perf-nightly` reads a mount plus a burst, so a cost that lands only
 * while the viewport moves is invisible to every one of them. The class this
 * exists for: an inherited custom property written on `<html>` restyles the
 * whole document, a whole-document walk run on a scroll-window commit, a
 * forced layout per heading per frame. Each is a stall the reader feels as
 * the page going blank mid-flick and catching up when the finger stops, and
 * none moves a keystroke or an open by a millisecond.
 *
 * What it reports, per fixture:
 *   gap        the frame interval's median, p95 and max, in ms
 *   frames>33  frames that took more than two frame budgets
 *   stall      the total over those frames of the time past one budget
 *   longtask   total main-thread tasks of 50 ms or more (Chromium only)
 *   root       custom-property writes on <html> during the scroll, by name,
 *              because each one is a whole-document restyle
 *   work       every `countWork` counter the scroll stamped (webview/perf.ts)
 *
 * The scroll is driven from the page rather than through the input path on
 * purpose: `scrollBy` per rAF measures the main thread's frame cadence
 * directly, in both engines, and does not depend on how a headless build
 * turns wheel deltas into scroll. What it does not measure is compositor
 * checkerboarding, which is what a real flick shows when this thread is held;
 * a frame gap here is the cause of that, read one level down.
 *
 * `--profile` (Chromium) takes a CPU profile across the scroll and prints
 * self time by function plus the call stacks under the hottest, which is how
 * a stall is named rather than guessed at. The bundle is minified, so the
 * names are short; a function's chunk and line locate it in `dist/`.
 *
 * Usage:
 *   pnpm build && pnpm perf:scroll                  # huge-outline, 40 screens
 *   node e2e/perf-scroll.mjs xlarge --screens 20
 *   BIRTA_E2E_BROWSER=webkit node e2e/perf-scroll.mjs
 *   node e2e/perf-scroll.mjs --profile --json scroll.json
 *
 * A figure this prints is a reading, not a record: quote it from a run on an
 * idle machine, and compare two bundles in one session.
 */
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, HEAVY_FIXTURES } from "./perf/fixtures.mjs";
import { serve, repoRoot } from "./perf/server.mjs";
import { acquireHarnessLock } from "./harnessLock.mjs";

acquireHarnessLock("perf:scroll");

const BROWSER = process.env.BIRTA_E2E_BROWSER || "chromium";
if (BROWSER !== "chromium" && BROWSER !== "webkit") {
    console.error(`BIRTA_E2E_BROWSER must be "chromium" or "webkit", got "${BROWSER}".`);
    process.exit(2);
}

// Two frame budgets at 60 Hz: a frame past this is one the reader saw drop.
const SLOW_FRAME_MS = 33;
const FRAME_BUDGET_MS = 1000 / 60;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : fallback;
};
const screens = Number(flag("--screens", "40"));
const stepPx = Number(flag("--step", "40"));
if (!Number.isInteger(screens) || screens < 1 || !Number.isInteger(stepPx) || stepPx < 1) {
    console.error("--screens and --step must be positive integers");
    process.exit(2);
}
const profile = argv.includes("--profile");
const jsonOut = flag("--json", null);
const takesValue = new Set(["--screens", "--step", "--json"]);
const only = argv.find((a, i) => !a.startsWith("--") && !takesValue.has(argv[i - 1]));
const pool = { ...FIXTURES, ...HEAVY_FIXTURES };
const fixture = only ?? "huge-outline";
if (!Object.hasOwn(pool, fixture)) {
    console.error(`no fixture named "${fixture}"`);
    process.exit(2);
}
const content = pool[fixture];

async function loadPlaywright() {
    try {
        const pw = await import("playwright");
        return pw[BROWSER];
    } catch {
        console.error(`playwright is not installed. Run: pnpm install && npx playwright install ${BROWSER}`);
        process.exit(2);
    }
}

const round = (x) => Math.round(x * 100) / 100;
const quantile = (sorted, q) => {
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** Self time by function and the stacks under the hottest, from a CDP profile. */
function summarizeProfile(prof) {
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const key = (n) => {
        const f = n.callFrame;
        return `${f.functionName || "(anon)"}  ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber}`;
    };
    const self = new Map();
    for (let i = 0; i < prof.samples.length; i++) {
        const k = key(byId.get(prof.samples[i]));
        self.set(k, (self.get(k) ?? 0) + prof.timeDeltas[i] / 1000);
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const stacks = {};
    for (const [k] of top.filter(([name]) => !name.startsWith("(")).slice(0, 3)) {
        const chains = new Map();
        for (let i = 0; i < prof.samples.length; i++) {
            const n = byId.get(prof.samples[i]);
            if (key(n) !== k) continue;
            const chain = [];
            let id = n.id;
            while (id !== undefined && chain.length < 12) {
                const nn = byId.get(id);
                chain.push(`${nn.callFrame.functionName || "(anon)"}@${nn.callFrame.url.split("/").pop()}:${nn.callFrame.lineNumber}`);
                id = parent.get(id);
            }
            const sk = chain.join(" < ");
            chains.set(sk, (chains.get(sk) ?? 0) + prof.timeDeltas[i] / 1000);
        }
        stacks[k] = [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    }
    return { top, stacks };
}

async function measure(browserType, url) {
    const browser = await browserType.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
        const errors = [];
        page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
        page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
        await page.addInitScript((c) => { window.__perfInit = { content: c, lineMap: [] }; }, content);
        await page.addInitScript(() => {
            // Every custom-property write on <html>, with when it happened. An
            // inherited one restyles the whole document, so the count is the
            // reading and the names say who.
            window.__rootWrites = [];
            const setProperty = CSSStyleDeclaration.prototype.setProperty;
            CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
                if (document.documentElement && this === document.documentElement.style && name.startsWith("--")) {
                    window.__rootWrites.push({ t: performance.now(), name });
                }
                return setProperty.call(this, name, value, priority);
            };
            window.__longtasks = [];
            try {
                if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
                    throw new Error("longtask unsupported");
                }
                window.__longtaskObs = new PerformanceObserver((list) => {
                    for (const e of list.getEntries()) window.__longtasks.push(e.duration);
                });
                window.__longtaskObs.observe({ type: "longtask", buffered: true });
            } catch {
                // WebKit: no long tasks are ever delivered; null keeps the
                // column honest rather than a clean zero.
                window.__longtasks = null;
            }
        });
        await page.goto(url, { waitUntil: "commit" });
        await page.waitForFunction(() => performance.getEntriesByName("mdw:editor-painted").length > 0, { timeout: 60000 });
        // A progressive open streams the rest of the document behind the
        // paint; the scroll reads the whole document, so it waits for it.
        await page.waitForFunction(
            () => performance.getEntriesByName("mdw:stream-start").length === 0
                || performance.getEntriesByName("mdw:stream-end").length > 0,
            { timeout: 60000 },
        );
        // Post-paint work (protection precompute, the first proofread pass,
        // the deferred affordance build) settles before the scroll starts,
        // so what the scroll reads is the scroll's own.
        await page.waitForTimeout(1500);
        const marksBefore = await page.evaluate(() => performance.getEntriesByType("mark").length);
        let cdp = null;
        if (profile && BROWSER === "chromium") {
            cdp = await page.context().newCDPSession(page);
            await cdp.send("Profiler.enable");
            await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
            await cdp.send("Profiler.start");
        }
        await page.evaluate(() => {
            if (window.__longtasks) { window.__longtaskObs.takeRecords(); window.__longtasks.length = 0; }
        });
        const scroll = await page.evaluate(async ({ screens, stepPx }) => {
            const total = screens * window.innerHeight;
            const gaps = [];
            const t0 = performance.now();
            let last = t0;
            let scrolled = 0;
            await new Promise((done) => {
                const tick = (ts) => {
                    gaps.push(ts - last);
                    last = ts;
                    const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
                    if (scrolled >= total || atEnd) { done(); return; }
                    scrolled += stepPx;
                    window.scrollBy(0, stepPx);
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
            const rootWrites = {};
            for (const w of window.__rootWrites) {
                if (w.t >= t0) rootWrites[w.name] = (rootWrites[w.name] ?? 0) + 1;
            }
            // The first gap is from before the first frame, not between two.
            return { gaps: gaps.slice(1), elapsed: performance.now() - t0, scrolled, docHeight: document.documentElement.scrollHeight, rootWrites };
        }, { screens, stepPx });
        await page.waitForTimeout(400);
        let prof = null;
        if (cdp) {
            prof = (await cdp.send("Profiler.stop")).profile;
        }
        const { longtasks, work } = await page.evaluate((before) => {
            const work = {};
            for (const m of performance.getEntriesByType("mark").slice(before)) {
                if (!m.name.startsWith("mdw:") || !m.detail || typeof m.detail !== "object") continue;
                for (const [k, v] of Object.entries(m.detail)) {
                    if (typeof v === "number") work[`${m.name}.${k}`] = (work[`${m.name}.${k}`] ?? 0) + v;
                }
            }
            return {
                longtasks: window.__longtasks
                    ? [...window.__longtasks, ...window.__longtaskObs.takeRecords().map((e) => e.duration)]
                    : null,
                work,
            };
        }, marksBefore);
        await page.close();
        if (errors.length) {
            throw new Error(`aborted on fixture "${fixture}":\n${[...new Set(errors)].slice(0, 6).map((e) => `    ${e}`).join("\n")}`);
        }
        // A scroll that moved nothing measured nothing: refuse rather than
        // report a very good number over an empty room.
        if (scroll.gaps.length < 10 || scroll.scrolled === 0) {
            throw new Error(`fixture "${fixture}": the scroll produced ${scroll.gaps.length} frames over ${scroll.scrolled}px`);
        }
        return { ...scroll, longtasks, work, profile: prof ? summarizeProfile(prof) : null };
    } finally {
        await browser.close();
    }
}

try {
    await stat(join(repoRoot, "dist", "webview.js"));
} catch {
    console.error("dist/webview.js not found — run `pnpm build` first.");
    process.exit(2);
}
const browserType = await loadPlaywright();
const server = serve();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let result;
try {
    result = await measure(browserType, `http://127.0.0.1:${server.address().port}/`);
} catch (e) {
    console.error(`\n  ${e.message}`);
    process.exit(3);
} finally {
    server.close();
}

const sorted = [...result.gaps].sort((a, b) => a - b);
const slow = result.gaps.filter((g) => g > SLOW_FRAME_MS);
const stallMs = slow.reduce((s, g) => s + g - FRAME_BUDGET_MS, 0);
const rootWriteCount = Object.values(result.rootWrites).reduce((s, n) => s + n, 0);
console.log(`\nscroll perf — ${fixture} (${Math.round(content.length / 1024)} KB), ${BROWSER}, ${screens} screens at ${stepPx}px per frame\n`);
console.log(`  frames ${result.gaps.length}, ${result.elapsed.toFixed(0)} ms, ${result.scrolled}px of ${result.docHeight}px`);
console.log(`  gap median ${round(quantile(sorted, 0.5))}  p95 ${round(quantile(sorted, 0.95))}  max ${round(sorted[sorted.length - 1])} ms`);
console.log(`  frames>33 ${slow.length}  stall ${stallMs.toFixed(0)} ms`);
console.log(result.longtasks
    ? `  longtask ${result.longtasks.reduce((s, d) => s + d, 0).toFixed(0)} ms in ${result.longtasks.length} tasks`
    : "  longtask n/a in this engine (read stall)");
console.log(`  root custom-property writes ${rootWriteCount}${rootWriteCount ? ` ${JSON.stringify(result.rootWrites)}` : ""}`);
const work = Object.entries(result.work).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");
console.log(`  work ${work || "(none)"}\n`);
if (result.profile) {
    console.log("  self time, top 20 (ms):");
    for (const [k, v] of result.profile.top) console.log(`    ${v.toFixed(1).padStart(8)}  ${k}`);
    for (const [k, chains] of Object.entries(result.profile.stacks)) {
        console.log(`  under ${k}:`);
        for (const [chain, ms] of chains) console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${chain}`);
    }
    console.log("");
}
if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({
        fixture, browser: BROWSER, screens, stepPx,
        frames: result.gaps.length, elapsedMs: round(result.elapsed),
        gapMedian: round(quantile(sorted, 0.5)), gapP95: round(quantile(sorted, 0.95)), gapMax: round(sorted[sorted.length - 1]),
        slowFrames: slow.length, stallMs: round(stallMs),
        longtaskMs: result.longtasks ? round(result.longtasks.reduce((s, d) => s + d, 0)) : null,
        longtaskCount: result.longtasks ? result.longtasks.length : null,
        rootWrites: result.rootWrites, work: result.work,
    }, null, 2));
    console.log(`wrote ${jsonOut}\n`);
}
