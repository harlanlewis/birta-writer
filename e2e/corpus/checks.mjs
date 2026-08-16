/**
 * Corpus launch suite: every real document in the corpus opens in the
 * production bundle, paints, and leaves the main thread alive. The perf
 * fixtures are synthetic and the perf gates are delta gates, so a document
 * class that hangs the editor was invisible to both — this is the only place
 * the corpus is ever RENDERED (roundTripCorpus.test.ts never builds a view).
 *
 * Per-document failure causes: no paint inside the ceiling, a post-paint
 * timer that never fires (the frozen-loop signature), an uncaught page error,
 * or a posted crash report. Console noise is NOT a failure — real documents
 * reference assets the stub server lacks. Each document runs in a fresh
 * context raced against a node-side deadline, because a wedged renderer can
 * hang Playwright calls past their own timeouts.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))));

/** Corpus roots, relative to the repo. Recursed. */
const CORPUS_DIRS = ["webview/__tests__/fixtures", "samples"];

/**
 * Document extensions the walk takes, mapped to the wire `format` the harness
 * page must init with. An `.mdx` file opened as markdown is a DIFFERENT
 * document (its islands parse as prose or HTML), so walking it without the
 * format would test nothing this suite claims to test.
 */
const FORMAT_BY_EXT = { ".md": "markdown", ".mdx": "mdx" };

/**
 * Per-format floors. A corpus small enough to be a glob accident fails the
 * suite, and each format needs its OWN floor: `.mdx` is a handful of files
 * against hundreds of `.md`, so a total-only floor would stay green with the
 * mdx walk broken to zero.
 */
const MIN_CORPUS_SIZE = { markdown: 30, mdx: 3 };

/** Generous by design: these are hang watchdogs, not perf gates. The outer
 *  deadline is a last resort for a renderer that hangs Playwright itself, so
 *  it must exceed the SUM of the stage budgets (~48s) — otherwise a slow but
 *  diagnosable document dies on the outer deadline with no stage named. */
const PAINT_CEILING_MS = 15000;
const RENDER_SETTLE_MS = 20000;
const PING_CEILING_MS = 2000;
const DOC_DEADLINE_MS = 60000;

/**
 * Every corpus document, plus a census of the file extensions the walk passed
 * over. The census is reported: a walk that reached nothing green-lights the
 * whole suite, and "0 documents" and "0 failures" read identically from a
 * summary line.
 */
async function collectCorpus() {
    const files = [];
    const skipped = new Map();
    for (const dir of CORPUS_DIRS) {
        const stack = [join(repoRoot, dir)];
        while (stack.length) {
            const d = stack.pop();
            for (const entry of await readdir(d, { withFileTypes: true })) {
                const p = join(d, entry.name);
                if (entry.isDirectory()) { stack.push(p); continue; }
                const ext = extname(entry.name).toLowerCase();
                const format = FORMAT_BY_EXT[ext];
                if (format) files.push({ path: p, format });
                else skipped.set(ext || "(none)", (skipped.get(ext || "(none)") ?? 0) + 1);
            }
        }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, skipped };
}

const deadline = (ms, label) =>
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms));

/**
 * Open one document in a fresh context and report how it settled.
 * Returns { ok: true, paintedMs, pingMs } or { ok: false, why }.
 */
async function openDoc(browser, baseUrl, content, format) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    try {
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e)));
        await page.addInitScript((init) => {
            window.__perfInit = { content: init.content, format: init.format, lineMap: [] };
        }, { content, format });

        const t0 = Date.now();
        await page.goto(`${baseUrl}/`, { waitUntil: "commit" });
        await page.waitForFunction(
            () => performance.getEntriesByName("mdw:editor-painted").length > 0,
            { timeout: PAINT_CEILING_MS },
        );
        const paintedMs = Date.now() - t0;

        // Diagrams render lazily AFTER paint (~1s of chunk load first), so a
        // paint-time ping misses a loop that starts late — the pre-fix bundle
        // passed a paint-only version of this suite. Wait for every VISIBLE
        // pane to settle (diagram or error card) before probing. Runs
        // unconditionally: with no active panes the predicate is immediately
        // true, and content-sniffing for fences would miss ~~~mermaid.
        // Visibility is computed style: every code block carries a hidden
        // pane, and inactive ones keep an empty inline style.
        //
        // `.diagram-preview` is the class EVERY engine's pane carries (they are
        // adapters over one pane, diagramPane.ts), which matters because the
        // corpus contains Mermaid, PlantUML and Graphviz: an engine the
        // predicate cannot see would let the responsiveness probe below run
        // while that engine was still loading, and "still loading" reads
        // exactly like "escaped its microtask chain" from here.
        //
        // `data-settled` is stamped BY the shared pane once a render reaches a
        // terminal state, diagram or error card. This used to enumerate the
        // engines' own class names instead, and adding a third engine walked
        // straight into the failure that shape always has: a Graphviz pane was
        // waited on, could never match `.mermaid-*` or `.puml-*`, and timed the
        // suite out. Ask the pane what it did; do not re-derive it per engine.
        await Promise.race([
            page.waitForFunction(() => {
                const panes = [...document.querySelectorAll(".diagram-preview")]
                    .filter((p) => getComputedStyle(p).display !== "none");
                return panes.every((p) => p.dataset.settled);
            }, { timeout: RENDER_SETTLE_MS, polling: 100 }),
            deadline(RENDER_SETTLE_MS + 1000, "diagram settle"),
        ]);

        // A timer that fires proves the main thread escaped its microtask
        // chain; the rAF proves frames still paint.
        const p0 = Date.now();
        await Promise.race([
            page.evaluate(() => new Promise((r) => {
                setTimeout(() => requestAnimationFrame(() => r(null)), 30);
            })),
            deadline(PING_CEILING_MS, "post-paint liveness ping"),
        ]);
        const pingMs = Date.now() - p0;

        const crashes = await page.evaluate(() =>
            (window.__posted ?? []).filter((m) => m.type === "crash").map((m) => m.message));
        if (crashes.length) return { ok: false, why: `crash reported: ${crashes[0]}` };
        if (pageErrors.length) return { ok: false, why: `page error: ${pageErrors[0]}` };
        return { ok: true, paintedMs, pingMs };
    } finally {
        // A wedged renderer may hang close(); leak it and let exit collect it.
        await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    }
}

export async function run({ page, check, baseUrl }) {
    const browser = page.context().browser();
    const { files, skipped } = await collectCorpus();

    const census = [...skipped.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ext, n]) => `${ext} x${n}`)
        .join(", ");
    for (const [format, floor] of Object.entries(MIN_CORPUS_SIZE)) {
        const n = files.filter((f) => f.format === format).length;
        check(`corpus inventory is real: ${n} ${format} documents`, n >= floor,
            `expected >= ${floor}; not walked: ${census || "nothing"}`);
    }

    for (const { path: file, format } of files) {
        const name = relative(repoRoot, file);
        const content = await readFile(file, "utf8");
        let result;
        try {
            result = await Promise.race([
                openDoc(browser, baseUrl, content, format),
                deadline(DOC_DEADLINE_MS, "document open"),
            ]);
        } catch (e) {
            result = { ok: false, why: String(e.message ?? e) };
        }
        check(`${name} opens and stays alive (${format})`, result.ok,
            result.ok ? `paint ${result.paintedMs}ms, ping ${result.pingMs}ms` : result.why);
    }
}
