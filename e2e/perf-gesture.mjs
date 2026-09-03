/**
 * Gesture-cost runner: drives the real built webview bundle (dist/webview.js)
 * on a fixture and reads what ONE editing gesture costs, gesture by gesture:
 * a typed character for scale, Enter at the end of a paragraph (a new empty
 * block), Backspace on that empty block, Enter inside a paragraph (a split),
 * Backspace across the seam (a join), and a block drag in its three parts,
 * the pickup past the drag threshold, the moves, and the drop.
 *
 * The other runners cannot see these. `pnpm perf` reads open, `pnpm
 * perf:typing` reads a burst of plain characters and holds its keystroke
 * apart from the sync a pause buys, `pnpm perf:scroll` reads the viewport
 * moving. A structural edit is none of those: it is one transaction that
 * every decoration plugin treats as "structure changed", followed by the
 * sync the pause after it buys, and a drag is not a transaction at all
 * until the drop. The classes this exists for: a plugin that redoes the
 * whole document for a one-block change, a body-class flip whose CSS
 * restyles every element, a per-block lookup made quadratic by asking the
 * view once per block, a forced layout in a pointer handler.
 *
 * What it reports, per gesture, as medians over `--reps`:
 *   dispatch   the synchronous main-thread block of the gesture's own
 *              doc-changing transactions (`mdw:tx-apply`), in ms
 *   paint      keydown to the next frame, for the keyboard gestures
 *   longtask   total main-thread tasks of 50 ms or more inside the gesture's
 *              window, the sync a pause buys included (Chromium only)
 *   stall      frame gaps of 50 ms or more in that window, summed
 *   work       every `countWork` counter the gesture stamped (webview/perf.ts);
 *              a `blocks` near the document's block count on a one-block
 *              gesture is a whole-document walk
 *
 * The window is the gesture plus the settle after it, long enough for the
 * trailing sync to land, so `longtask` and `stall` carry the sync's cost and
 * `dispatch` does not: a gesture the user feels as slow is usually the sync
 * behind it, and the two columns tell them apart.
 *
 * Two hazards the runner is built around. On macOS in headless Chromium the
 * End and Home keys SCROLL the page rather than moving the caret, and the
 * smooth scroll drives the scroll-window observer into a rebuild per frame,
 * so the caret is placed through the view (`__birtaPerf.view()`, installed
 * by webview/editor.ts for the harness) and never by key. And the harness
 * page opens the outline docked and open, over the gutter the drag grabs;
 * the runner closes it and refuses to read a drag whose handle was not
 * under the pointer, because a drag that never started measures nothing
 * and reports a very good number.
 *
 * `--profile` (Chromium) takes a CPU profile per gesture and prints self
 * time by module and by function, attributed through the `// path` comments
 * a DEV build carries (`node esbuild.mjs`); a production bundle attributes
 * to chunks and lines only. `--trace` sums the renderer's own events over
 * the window (style recalc, layout, hit test, paint), which is how a cost
 * that is the browser's work rather than the bundle's is named.
 *
 * Usage:
 *   pnpm build && pnpm perf:gesture                     # huge-outline, 5 reps
 *   node e2e/perf-gesture.mjs xlarge --reps 3
 *   BIRTA_E2E_BROWSER=webkit node e2e/perf-gesture.mjs
 *   node esbuild.mjs && node e2e/perf-gesture.mjs --profile --only drag,drop
 *   node e2e/perf-gesture.mjs --trace --json gesture.json
 *
 * A figure this prints is a reading, not a record: quote it from a run on an
 * idle machine, and compare two bundles in one session.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, HEAVY_FIXTURES } from "./perf/fixtures.mjs";
import { serve, repoRoot } from "./perf/server.mjs";
import { acquireHarnessLock } from "./harnessLock.mjs";

acquireHarnessLock("perf:gesture");

const BROWSER = process.env.BIRTA_E2E_BROWSER || "chromium";
if (BROWSER !== "chromium" && BROWSER !== "webkit") {
    console.error(`BIRTA_E2E_BROWSER must be "chromium" or "webkit", got "${BROWSER}".`);
    process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : fallback;
};
const reps = Number(flag("--reps", "5"));
if (!Number.isInteger(reps) || reps < 1) {
    console.error("--reps must be a positive integer");
    process.exit(2);
}
const profile = argv.includes("--profile");
const trace = argv.includes("--trace");
const only = flag("--only", null);
const jsonOut = flag("--json", null);
const takesValue = new Set(["--reps", "--only", "--json"]);
const named = argv.find((a, i) => !a.startsWith("--") && !takesValue.has(argv[i - 1]));
const pool = { ...FIXTURES, ...HEAVY_FIXTURES };
const fixture = named ?? "huge-outline";
if (!Object.hasOwn(pool, fixture)) {
    console.error(`no fixture named "${fixture}"`);
    process.exit(2);
}
const content = pool[fixture];

// A frame gap or a task this long counts: the floor the typing runner uses.
const STALL_MS = 50;
// The settle after each gesture. The sync scheduler's trailing window is
// 300 ms, so this holds the sync and its long task inside the reading.
const SETTLE_MS = 700;

async function loadPlaywright() {
    try {
        const pw = await import("playwright");
        return pw[BROWSER];
    } catch {
        console.error(`playwright is not installed. Run: pnpm install && npx playwright install ${BROWSER}`);
        process.exit(2);
    }
}

const round = (x) => Math.round(x * 10) / 10;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const median = (a) => {
    if (a.length === 0) return null;
    const s = [...a].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ── attribution: a dev bundle's `// path` module comments ────────────────
const bundleOwners = new Map();
async function moduleOf(url, line) {
    if (!url.includes("/dist/")) return url ? url.replace(/^.*\//, "") : "(native)";
    const rel = url.replace(/^.*\/dist\//, "dist/");
    if (!bundleOwners.has(rel)) {
        const src = await readFile(join(repoRoot, rel), "utf8").catch(() => "");
        const lines = src.split("\n");
        const owners = new Array(lines.length);
        let cur = rel;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*\/\/ ((?:webview|shared|packages|node_modules|src)\/\S+)$/);
            if (m) cur = m[1].replace(/^node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/, "npm:");
            owners[i] = cur;
        }
        bundleOwners.set(rel, owners);
    }
    return bundleOwners.get(rel)[line] ?? rel;
}

async function summarizeProfile(prof) {
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const self = new Map();
    for (let i = 0; i < prof.samples.length; i++) {
        self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
    }
    const byModule = new Map();
    const byFn = new Map();
    let total = 0;
    for (const [id, us] of self) {
        const n = byId.get(id);
        if (["(idle)", "(garbage collector)"].includes(n.callFrame.functionName)) continue;
        total += us;
        // Native self time folds into the nearest caller inside the bundle.
        let cur = n;
        while (cur && !cur.callFrame.url.includes("/dist/")) cur = byId.get(parent.get(cur.id));
        const frame = (cur ?? n).callFrame;
        const mod = await moduleOf(frame.url, frame.lineNumber);
        byModule.set(mod, (byModule.get(mod) ?? 0) + us);
        const fn = `${frame.functionName || "(anon)"} @ ${mod}:${frame.lineNumber + 1}`;
        byFn.set(fn, (byFn.get(fn) ?? 0) + us);
    }
    const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
        .map(([name, us]) => [name, round(us / 1000), total ? Math.round((100 * us) / total) : 0]);
    return { totalMs: round(total / 1000), modules: top(byModule, 12), functions: top(byFn, 16) };
}

function summarizeTrace(events) {
    const byName = new Map();
    for (const e of events) {
        if (e.ph !== "X" || typeof e.dur !== "number") continue;
        const cur = byName.get(e.name) ?? { n: 0, us: 0 };
        cur.n++;
        cur.us += e.dur;
        byName.set(e.name, cur);
    }
    return [...byName.entries()].filter(([, v]) => v.us > 500).sort((a, b) => b[1].us - a[1].us).slice(0, 12)
        .map(([name, v]) => ({ name, ms: round(v.us / 1000), n: v.n }));
}

// ── the page ──────────────────────────────────────────────────────────────
async function mount(browser, url) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()}`));
    await page.addInitScript((c) => { window.__perfInit = { content: c, lineMap: [] }; }, content);
    await page.addInitScript(() => {
        window.__longtasks = [];
        try {
            if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) throw new Error("unsupported");
            window.__longtaskObs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) window.__longtasks.push(e.duration);
            });
            window.__longtaskObs.observe({ type: "longtask", buffered: true });
        } catch {
            // WebKit delivers none; null keeps the column honest rather than a clean zero.
            window.__longtasks = null;
        }
    });
    await page.goto(url, { waitUntil: "commit" });
    await page.waitForFunction(() => performance.getEntriesByName("mdw:editor-painted").length > 0, { timeout: 60000 });
    await page.waitForFunction(
        () => performance.getEntriesByName("mdw:stream-start").length === 0
            || performance.getEntriesByName("mdw:stream-end").length > 0,
        { timeout: 60000 },
    );
    await page.waitForTimeout(1500);
    const hook = await page.evaluate(() => typeof window.__birtaPerf?.view === "function");
    if (!hook) {
        throw new Error("this bundle has no `__birtaPerf.view` probe; build from a tree that has it (webview/editor.ts, installPerfProbes)");
    }
    return { page, errors };
}

/** Caret to the end, or a few characters in, of the paragraph in the middle of the document. */
async function caretTo(page, where) {
    await page.evaluate((w) => {
        const view = window.__birtaPerf.view();
        const { doc } = view.state;
        const paras = [];
        doc.forEach((node, offset) => { if (node.type.name === "paragraph" && node.content.size > 8) paras.push({ node, offset }); });
        const p = paras[Math.floor(paras.length / 2)];
        const pos = w === "end" ? p.offset + 1 + p.node.content.size : p.offset + 1 + 3;
        const Sel = view.state.selection.constructor;
        view.dispatch(view.state.tr.setSelection(Sel.near(doc.resolve(pos))).scrollIntoView());
        view.focus();
    }, where);
    await page.waitForTimeout(400);
}

async function beginWindow(page) {
    await page.evaluate(() => {
        performance.clearMeasures("mdw:tx-apply");
        performance.clearMeasures("mdw:tx-select");
        if (window.__longtasks) { window.__longtaskObs.takeRecords(); window.__longtasks.length = 0; }
        window.__marksBefore = performance.getEntriesByType("mark").length;
        window.__frameGaps = [];
        window.__stopFrames = false;
        let last = performance.now();
        const tick = (ts) => { window.__frameGaps.push(ts - last); last = ts; if (!window.__stopFrames) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        window.__keyToFrame = [];
        window.__keyListener = () => {
            const at = performance.now();
            requestAnimationFrame(() => { window.__keyToFrame.push(performance.now() - at); });
        };
        document.addEventListener("keydown", window.__keyListener, true);
    });
}

async function endWindow(page) {
    await page.waitForTimeout(SETTLE_MS);
    return page.evaluate((stallMs) => {
        window.__stopFrames = true;
        document.removeEventListener("keydown", window.__keyListener, true);
        const work = {};
        for (const m of performance.getEntriesByType("mark").slice(window.__marksBefore)) {
            if (!m.name.startsWith("mdw:") || !m.detail || typeof m.detail !== "object") continue;
            for (const [k, v] of Object.entries(m.detail)) {
                if (typeof v === "number") work[`${m.name.slice(4)}.${k}`] = (work[`${m.name.slice(4)}.${k}`] ?? 0) + v;
            }
        }
        const longtasks = window.__longtasks
            ? [...window.__longtasks, ...window.__longtaskObs.takeRecords().map((e) => e.duration)]
            : null;
        return {
            dispatch: performance.getEntriesByName("mdw:tx-apply").reduce((s, m) => s + m.duration, 0),
            transactions: performance.getEntriesByName("mdw:tx-apply").length,
            paint: window.__keyToFrame[0] ?? null,
            longtaskMs: longtasks ? longtasks.reduce((s, d) => s + d, 0) : null,
            stallMs: window.__frameGaps.slice(1).filter((g) => g >= stallMs).reduce((s, g) => s + g, 0),
            work,
        };
    }, STALL_MS);
}

/**
 * The drag's handle: the gutter marker of the paragraph in the middle of the
 * document, revealed by hovering the paragraph, with the outline closed if it
 * is docked over the gutter. Returns null when no handle is under the pointer,
 * which the caller treats as a gesture it cannot read rather than a fast one.
 */
async function dragHandle(page) {
    // An open panel hides its reveal tab and shows a hide button in its
    // header instead, so the close goes through whichever is on screen.
    const opened = await page.evaluate(() => document.body.classList.contains("toc-open"));
    if (opened) {
        await page.evaluate(() => {
            const control = document.querySelector(".toc-hide-btn") ?? document.querySelector(".toc-toggle-tab");
            control?.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(400);
    }
    const target = await page.evaluate(() => {
        const ps = [...document.querySelectorAll(".ProseMirror > p")].filter((p) => p.textContent.length > 8);
        const p = ps[Math.floor(ps.length / 2)];
        p.scrollIntoView({ block: "center" });
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(14, r.height / 2) };
    });
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(250);
    return page.evaluate(() => {
        const ps = [...document.querySelectorAll(".ProseMirror > p")].filter((p) => p.textContent.length > 8);
        const p = ps[Math.floor(ps.length / 2)];
        const marker = p.querySelector(".heading-fold-marker");
        if (!marker) return null;
        const r = marker.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const under = document.elementFromPoint(x, y);
        if (!under || !under.closest(".heading-fold-marker")) return null;
        const next = p.nextElementSibling?.nextElementSibling ?? p.nextElementSibling;
        const nr = next.getBoundingClientRect();
        return { x, y, dropX: nr.x + nr.width / 2, dropY: nr.bottom - 2 };
    });
}

const GESTURES = [
    { name: "type char", keyboard: true },
    { name: "enter at end", keyboard: true },
    { name: "backspace empty", keyboard: true },
    { name: "enter mid-para", keyboard: true },
    { name: "backspace join", keyboard: true },
    { name: "drag start", keyboard: false },
    { name: "drag move", keyboard: false },
    { name: "drop", keyboard: false },
];
// `--only` takes comma-separated name prefixes: `--only drag,drop` is the
// whole drag, `--only enter` both Enters.
const wanted = (name) => !only || only.split(",").some((prefix) => name.startsWith(prefix.trim()));

async function measure(browserType, url) {
    const browser = await browserType.launch();
    try {
        const { page, errors } = await mount(browser, url);
        const blocks = await page.evaluate(() => document.querySelectorAll(".ProseMirror > *").length);
        let cdp = null;
        if ((profile || trace) && BROWSER === "chromium") {
            cdp = await page.context().newCDPSession(page);
        }
        const readings = Object.fromEntries(GESTURES.map((g) => [g.name, []]));
        const profiles = {};
        const traces = {};
        const skipped = [];

        const run = async (name, act) => {
            if (!wanted(name)) { await act(); await page.waitForTimeout(300); return; }
            await beginWindow(page);
            let traceEvents = null;
            if (cdp && trace) {
                traceEvents = [];
                const collect = (e) => traceEvents.push(...e.value);
                cdp.on("Tracing.dataCollected", collect);
                await cdp.send("Tracing.start", {
                    traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"], recordMode: "recordContinuously" },
                    transferMode: "ReportEvents",
                });
                traceEvents.off = () => cdp.off("Tracing.dataCollected", collect);
            }
            if (cdp && profile) {
                await cdp.send("Profiler.enable");
                await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
                await cdp.send("Profiler.start");
            }
            await act();
            if (cdp && profile) {
                await page.waitForTimeout(SETTLE_MS);
                const { profile: prof } = await cdp.send("Profiler.stop");
                profiles[name] ??= await summarizeProfile(prof);
            }
            if (traceEvents) {
                await page.waitForTimeout(400);
                const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
                await cdp.send("Tracing.end");
                await done;
                traceEvents.off();
                traces[name] ??= summarizeTrace(traceEvents);
            }
            readings[name].push(await endWindow(page));
        };

        // Warm-up: one of each keyboard gesture, so JIT and lazy paths are paid.
        await caretTo(page, "end");
        await page.keyboard.type("x");
        await page.waitForTimeout(400);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(SETTLE_MS);

        for (let i = 0; i < reps; i++) {
            await caretTo(page, "end");
            await run("type char", () => page.keyboard.type("y"));
            await run("enter at end", () => page.keyboard.press("Enter"));
            await run("backspace empty", () => page.keyboard.press("Backspace"));
            await caretTo(page, "mid");
            await run("enter mid-para", () => page.keyboard.press("Enter"));
            await run("backspace join", () => page.keyboard.press("Backspace"));
        }

        for (let i = 0; i < reps; i++) {
            if (!["drag start", "drag move", "drop"].some(wanted)) break;
            const handle = await dragHandle(page);
            if (!handle) {
                skipped.push("drag: no gutter handle was under the pointer, so no drag was read");
                break;
            }
            // Held IN the page: a node serialized across the protocol is a
            // plain object that never equals the live one, and a comparison
            // made that way had discarded nothing while claiming to.
            await page.evaluate(() => { window.__docBeforeDrag = window.__birtaPerf.view().state.doc; });
            await run("drag start", async () => {
                await page.mouse.move(handle.x, handle.y);
                await page.mouse.down();
                await page.mouse.move(handle.x + 10, handle.y + 10);
            });
            const dragging = await page.evaluate(() => document.body.classList.contains("block-dragging"));
            await run("drag move", () => page.mouse.move(handle.dropX, handle.dropY, { steps: 8 }));
            await run("drop", () => page.mouse.up());
            const moved = await page.evaluate(() => window.__birtaPerf.view().state.doc !== window.__docBeforeDrag);
            if (!dragging || !moved) {
                skipped.push(`drag: the session ${dragging ? "started" : "never started"} and the drop ${moved ? "moved a block" : "changed nothing"}; its readings are discarded`);
                for (const g of ["drag start", "drag move", "drop"]) readings[g].pop();
                break;
            }
            await page.waitForTimeout(400);
        }

        await page.close();
        if (errors.length) {
            throw new Error(`aborted on fixture "${fixture}":\n${[...new Set(errors)].slice(0, 6).map((e) => `    ${e}`).join("\n")}`);
        }
        return { blocks, readings, profiles, traces, skipped };
    } finally {
        await browser.close();
    }
}

try {
    await stat(join(repoRoot, "dist", "webview.js"));
} catch {
    console.error("dist/webview.js not found; run `pnpm build` first.");
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

const rows = [];
for (const { name } of GESTURES) {
    const r = result.readings[name];
    if (r.length === 0) continue;
    rows.push({
        gesture: name,
        n: r.length,
        dispatch: median(r.map((x) => x.dispatch)),
        paint: r.some((x) => x.paint !== null) ? median(r.map((x) => x.paint).filter((v) => v !== null)) : null,
        longtask: r[0].longtaskMs === null ? null : median(r.map((x) => x.longtaskMs)),
        stall: median(r.map((x) => x.stallMs)),
        work: r.reduce((acc, x) => { for (const [k, v] of Object.entries(x.work)) acc[k] = Math.max(acc[k] ?? 0, v); return acc; }, {}),
    });
}
// An instrument that read nothing must say so rather than print a table of gaps.
if (rows.length === 0) {
    console.error(`\n  no gesture was read${result.skipped.length ? `:\n    ${result.skipped.join("\n    ")}` : ""}`);
    process.exit(3);
}

const fmt = (v, w) => (v === null ? "n/a" : String(round(v))).padEnd(w);
console.log(`\ngesture perf: ${fixture} (${Math.round(content.length / 1024)} KB, ${result.blocks} top-level blocks), ${BROWSER}, medians over ${reps} reps\n`);
console.log(`  ${"gesture".padEnd(16)} ${"dispatch".padEnd(9)} ${"paint".padEnd(7)} ${"longtask".padEnd(9)} ${"stall".padEnd(7)}`);
for (const row of rows) {
    console.log(`  ${row.gesture.padEnd(16)} ${fmt(row.dispatch, 9)} ${fmt(row.paint, 7)} ${fmt(row.longtask, 9)} ${fmt(row.stall, 7)}`);
}
console.log("\n  work handed across an instrumented boundary, per gesture (the max over reps; counts, not ms):");
for (const row of rows) {
    const work = Object.entries(row.work).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");
    console.log(`    ${row.gesture.padEnd(16)} ${work || "(none)"}`);
}
if (result.skipped.length) {
    console.log(`\n  not read:\n    ${result.skipped.join("\n    ")}`);
}
for (const [name, prof] of Object.entries(result.profiles)) {
    console.log(`\n  profile ${name}: ${prof.totalMs} ms sampled, self time folded into the nearest bundle frame`);
    for (const [mod, ms, pct] of prof.modules) console.log(`    ${String(ms).padStart(7)} ms ${String(pct).padStart(3)}%  ${mod}`);
    console.log("    functions:");
    for (const [fn, ms, pct] of prof.functions) console.log(`    ${String(ms).padStart(7)} ms ${String(pct).padStart(3)}%  ${fn}`);
}
for (const [name, ev] of Object.entries(result.traces)) {
    console.log(`\n  trace ${name}: renderer events over the window`);
    for (const { name: n, ms, n: count } of ev) console.log(`    ${String(ms).padStart(7)} ms x${String(count).padStart(4)}  ${n}`);
}
console.log("");
if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({
        fixture, browser: BROWSER, reps, blocks: result.blocks,
        gestures: rows.map((r) => ({ ...r, dispatch: round(r.dispatch), paint: r.paint === null ? null : round(r.paint), longtask: r.longtask === null ? null : round(r.longtask), stall: round(r.stall) })),
        skipped: result.skipped,
        profiles: result.profiles,
        traces: result.traces,
    }, null, 2));
    console.log(`wrote ${jsonOut}\n`);
}
