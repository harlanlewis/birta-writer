/**
 * Corpus launch suite: every real markdown file in the repo's corpus opens in
 * the PRODUCTION bundle, paints, and leaves the main thread alive.
 *
 * This exists because the perf fixtures are synthetic by design (size ×
 * isolated-subsystem) and the perf gates are delta gates — a document class
 * that hangs the editor is structurally invisible to both. The corpus below
 * (the round-trip fixtures plus samples/) is real-shaped, and this suite is
 * the only place it is ever RENDERED: roundTripCorpus.test.ts serializes it
 * in jsdom and never builds a view. The motivating failure was a document
 * whose one invalid mermaid diagram froze the whole window on open — every
 * unit test green, every gate green, because nothing ever opened a document
 * shaped like a user's.
 *
 * Failure is scoped per document and per cause: no paint inside the ceiling,
 * a post-paint timer that never fires (the frozen-loop signature), an uncaught
 * page error, or a crash report posted to the host. Console noise (CSP-blocked
 * remote fetches, missing sibling images) is deliberately NOT a failure —
 * real documents reference assets a stub server does not have, and failing on
 * that would teach this suite to be ignored.
 *
 * Each document gets a FRESH browser context raced against a node-side
 * deadline: a renderer wedged hard enough can hang Playwright calls past
 * their own timeouts (the motivating bug did), and a shared page would let
 * one bad document wedge the whole runner.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))));

/** Corpus roots, relative to the repo. Recursed; only .md files are taken. */
const CORPUS_DIRS = ["webview/__tests__/fixtures", "samples"];

/** A corpus small enough to be a glob accident fails the suite. */
const MIN_CORPUS_SIZE = 30;

/** Generous by design: these are hang watchdogs, not perf gates. */
const PAINT_CEILING_MS = 15000;
const RENDER_SETTLE_MS = 20000;
const PING_CEILING_MS = 2000;
const DOC_DEADLINE_MS = 45000;

async function collectCorpus() {
    const files = [];
    for (const dir of CORPUS_DIRS) {
        const stack = [join(repoRoot, dir)];
        while (stack.length) {
            const d = stack.pop();
            for (const entry of await readdir(d, { withFileTypes: true })) {
                const p = join(d, entry.name);
                if (entry.isDirectory()) stack.push(p);
                else if (entry.name.endsWith(".md")) files.push(p);
            }
        }
    }
    return files.sort();
}

const deadline = (ms, label) =>
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms));

/**
 * Open one document in a fresh context and report how it settled.
 * Returns { ok: true, paintedMs, pingMs } or { ok: false, why }.
 */
async function openDoc(browser, baseUrl, content) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    try {
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e)));
        await page.addInitScript((c) => {
            window.__perfInit = { content: c, lineMap: [] };
        }, content);

        const t0 = Date.now();
        await page.goto(`${baseUrl}/`, { waitUntil: "commit" });
        await page.waitForFunction(
            () => performance.getEntriesByName("mdw:editor-painted").length > 0,
            { timeout: PAINT_CEILING_MS },
        );
        const paintedMs = Date.now() - t0;

        // Lazy previews (mermaid today) start AFTER paint: the chunk loads for
        // around a second before any render runs, so a liveness ping taken at
        // paint time reads a healthy thread and misses a loop that starts
        // late. Proven, not hypothetical: the pre-fix bundle sailed through a
        // paint-time-only version of this suite. Wait until every active
        // mermaid pane settled — a diagram or an error card, no loading state
        // — before probing. A wedged renderer can't run the poll, so the
        // deadline converts a frozen page into this document's failure.
        // Every VISIBLE pane must settle. Non-empty mermaid blocks enter
        // preview synchronously at NodeView construction, so their panes are
        // visible before editor-painted; every other code block also carries
        // a (hidden) pane, which is why visibility — computed, since inactive
        // panes keep an empty inline style — is the membership test, not a
        // fence count parsed out of the markdown.
        if (content.includes("```mermaid")) {
            await Promise.race([
                page.waitForFunction(() => {
                    const panes = [...document.querySelectorAll(".mermaid-preview")]
                        .filter((p) => getComputedStyle(p).display !== "none");
                    return panes.every((p) =>
                        p.querySelector(".mermaid-svg-container > svg") ||
                        p.querySelector(".mermaid-error"));
                }, { timeout: RENDER_SETTLE_MS, polling: 100 }),
                deadline(RENDER_SETTLE_MS + 1000, "mermaid settle"),
            ]);
        }

        // Post-paint liveness. The setTimeout ping is the load-bearing probe:
        // the frozen-retry failure mode starves the timer queue, so a timer
        // that fires proves the main thread escaped its microtask chain. The
        // rAF proves frames are still being produced.
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
        // Racing close keeps a wedged renderer from hanging the suite; the
        // context is leaked in that case, which the process exit collects.
        await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    }
}

export async function run({ page, check, baseUrl }) {
    const browser = page.context().browser();
    const corpus = await collectCorpus();
    check(`corpus inventory is real (${corpus.length} documents)`, corpus.length >= MIN_CORPUS_SIZE,
        `expected >= ${MIN_CORPUS_SIZE}`);

    for (const file of corpus) {
        const name = relative(repoRoot, file);
        const content = await readFile(file, "utf8");
        let result;
        try {
            result = await Promise.race([
                openDoc(browser, baseUrl, content),
                deadline(DOC_DEADLINE_MS, "document open"),
            ]);
        } catch (e) {
            result = { ok: false, why: String(e.message ?? e) };
        }
        check(`${name} opens and stays alive`, result.ok,
            result.ok ? `paint ${result.paintedMs}ms, ping ${result.pingMs}ms` : result.why);
    }
}
