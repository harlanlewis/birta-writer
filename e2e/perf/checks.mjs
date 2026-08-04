/**
 * Checks for the launch-perf harness's own instrumentation.
 *
 * `e2e/perf/` was a measurement runner with nothing asserting that what it
 * measures is what it claims to measure, and two blind spots grew in it:
 *
 * - Its fixtures tripped **zero** style checks, so every measured launch ran the
 *   proofread scan against prose it never matched — the matcher's traversal, but
 *   never the decoration build that scales with how much a document actually
 *   trips (MAR-310). A green launch gate over that fixture set is evidence of
 *   non-interference, not of coverage.
 * - The `rtp` span sat in `SPANS` reading `null` on every run, because its marks
 *   were deleted when round-trip protection moved off the mount path onto idle.
 *   The work did not get cheaper; it landed ~100 ms after `editor-painted`,
 *   past the last mark, where nothing looked (MAR-311).
 *
 * Both are invisible to `pnpm perf`, which reports a `–` for an unstamped span
 * and a number for a scan that found nothing. Neither can be caught by reading
 * the harness — only by driving it. These checks drive it.
 */
import { FIXTURES } from "./fixtures.mjs";

/**
 * Load a fixture into the perf harness page and wait for `expect`ed post-paint
 * marks. Waiting for the marks by name rather than for a fixed delay is what
 * makes a missing one show up as a failed assertion instead of a slow suite:
 * the wait is swallowed, and the check that follows reads `null`.
 */
async function load(page, baseUrl, content, { query = "", expect: expected = [] } = {}) {
    // addInitScript stacks and cannot be removed; a later call simply wins on
    // the next navigation, which is how one page serves several fixtures.
    await page.addInitScript((c) => { window.__perfInit = { content: c, lineMap: [] }; }, content);
    await page.goto(`${baseUrl}/${query}`, { waitUntil: "commit" });
    await page.waitForFunction(
        () => performance.getEntriesByName("mdw:editor-painted").length > 0,
        { timeout: 20000 },
    );
    for (const name of expected) {
        await page.waitForFunction(
            (n) => performance.getEntriesByName("mdw:" + n, "mark").length > 0,
            name,
            { timeout: 5000 },
        ).catch(() => {});
    }
    // A short tail so a mark expected NOT to appear has had its chance to. Both
    // post-paint passes are armed at mount, so if they were going to run they
    // have by now.
    await page.waitForTimeout(300);
}

const readMarks = (page) => page.evaluate(() => {
    const at = (n) => performance.getEntriesByName("mdw:" + n, "mark")[0]?.startTime ?? null;
    return {
        painted: at("editor-painted"),
        rtpStart: at("rtp-start"),
        rtpEnd: at("rtp-end"),
        pfStart: at("proofread-start"),
        pfEnd: at("proofread-end"),
        measures: performance.getEntriesByType("measure")
            .filter((m) => m.name.startsWith("mdw:")).map((m) => m.name.slice(4)),
        styleHits: document.querySelectorAll(".pf-style-hit").length,
    };
});

export async function run({ page, check, baseUrl }) {
    // ── proofreading ON (the shipped default, and what every gate measures) ──
    // `large` rather than `medium`: the two ordering checks below compare mark
    // timestamps, and on a small document both idle callbacks can land inside
    // the two frames between `create-end` and the `editor-painted` mark (on
    // `tiny`, proofread starts 15 ms BEFORE it). That is not a violation of
    // anything — it is a document with no work to defer — but asserting an
    // ordering with a 14 ms margin on a shared runner is how a check becomes
    // flaky. On `large` the margins are +61 ms and +135 ms.
    await load(page, baseUrl, FIXTURES.large, { expect: ["rtp-end", "proofread-end"] });
    const m = await readMarks(page);

    // MAR-310's exact failing observation was `styleHits === 0`. The floor sits
    // far below the 756 the seeded fixture produces (2026-08-04): it pins "the
    // decoration path runs at a realistic density", not a count a word-list edit
    // would churn.
    //
    // 756 counts `.pf-style-hit` ELEMENTS; `fixtures.test.mjs` counts 540 phrase
    // matches in the same fixture. Different metrics — one match can decorate
    // several nodes — so don't reconcile them.
    check("large fixture trips the style check", m.styleHits >= 300, `${m.styleHits} .pf-style-hit`);

    check("proofread first pass is marked", m.pfStart != null && m.pfEnd != null,
        `start=${m.pfStart} end=${m.pfEnd}`);
    // The plugin's contract is that proofreading never blocks the editor becoming
    // interactive (AGENTS.md → Launch performance). Asserting the mark lands
    // after the paint mark is that contract, stated where it can fail.
    check("proofread first pass runs after first paint",
        m.pfStart != null && m.painted != null && m.pfStart >= m.painted,
        `painted=${Math.round(m.painted)} proofread-start=${Math.round(m.pfStart ?? NaN)}`);

    check("round-trip protection is marked", m.rtpStart != null && m.rtpEnd != null,
        `start=${m.rtpStart} end=${m.rtpEnd}`);
    check("round-trip protection runs after first paint",
        m.rtpStart != null && m.painted != null && m.rtpStart >= m.painted,
        `painted=${Math.round(m.painted)} rtp-start=${Math.round(m.rtpStart ?? NaN)}`);

    check("both post-paint spans are measured, not just marked",
        m.measures.includes("rtp") && m.measures.includes("proofread"),
        m.measures.join(", "));

    // ── proofreading OFF ──────────────────────────────────────
    // The control from MAR-311: with the feature off the post-paint block is
    // still there, which is what proved it was not proofreading. It also pins
    // AGENTS.md's rule that a disabled feature costs nothing — no scan, no
    // decorations — which a mark makes checkable for the first time.
    await load(page, baseUrl, FIXTURES.medium, { query: "?proofreading=0", expect: ["rtp-end"] });
    const off = await readMarks(page);
    check("proofreading off ⇒ no style decorations", off.styleHits === 0, `${off.styleHits} .pf-style-hit`);
    check("proofreading off ⇒ no proofread pass at all", off.pfStart == null, `start=${off.pfStart}`);
    check("proofreading off ⇒ round-trip protection still runs", off.rtpEnd != null, `end=${off.rtpEnd}`);
}
