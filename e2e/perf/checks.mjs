/**
 * Checks that the launch-perf harness measures what it claims to measure.
 *
 * Two ways it can stop doing that, both invisible to `pnpm perf` — which
 * reports a `–` for an unstamped span and a number for a scan that found
 * nothing:
 *
 * - Fixtures that trip zero style checks. Proofreading ships on, so every
 *   measured launch runs its scan; over prose that matches nothing the scan
 *   exercises the matcher's traversal but never the decoration build, which is
 *   the half that scales with how much a document actually trips. A green
 *   launch gate over such a fixture set is evidence of non-interference, not of
 *   coverage (MAR-310).
 * - A span whose marks are gone. Deferring work past the last mark does not
 *   make it cheaper, and a `–` reads exactly like "cheap" — worse than never
 *   having claimed to measure it (MAR-311).
 *
 * Neither can be caught by reading the harness, only by driving it. These
 * checks drive it.
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
        // Work COUNTERS, read back off the real timeline the way
        // `e2e/perf-typing.mjs` reads them. The jsdom gate that uses these
        // (`webview/__tests__/perKeystrokeWork.test.ts`) runs under fake timers,
        // whose `performance` ignores the options form of `mark` entirely, so it
        // captures counters at the call and CANNOT establish that a counter
        // survives to a timeline at all. This is the only place that does.
        work: performance.getEntriesByType("mark")
            .filter((e) => e.name.startsWith("mdw:") && e.detail && typeof e.detail === "object")
            .map((e) => ({ name: e.name.slice(4), detail: e.detail })),
        styleHits: document.querySelectorAll(".pf-style-hit").length,
    };
});

export async function run({ page, check, baseUrl }) {
    // ── proofreading ON (the shipped default, and what every gate measures) ──
    // `large` rather than `medium`: the two ordering checks below compare mark
    // timestamps, and on a small document both idle callbacks can land inside
    // the two frames between `create-end` and the `editor-painted` mark — on
    // `tiny`, proofread starts BEFORE it. That is not a violation of anything,
    // just a document with no work to defer, but asserting an ordering across a
    // margin of a few frames on a shared runner is how a check becomes flaky.
    // `large` has enough deferred work to put the margins beyond doubt.
    await load(page, baseUrl, FIXTURES.large, { expect: ["rtp-end", "proofread-end"] });
    const m = await readMarks(page);

    // The failure this exists for is `styleHits === 0` (MAR-310). The floor sits
    // far below what the seeded fixture actually produces, so it pins "the
    // decoration path runs at a realistic density" rather than a count a
    // word-list edit would churn.
    //
    // This counts `.pf-style-hit` ELEMENTS in the DOM, which since MAR-425 is
    // the scroll WINDOW's worth of the fixture and not the document's: the style
    // pass builds for the blocks near the viewport, so the floor is sized to a
    // few screens of the fixture rather than to the whole of it. `fixtures.test.mjs`
    // counts phrase MATCHES over the same fixture, and one match can decorate
    // several nodes. They are different metrics — don't reconcile the two numbers.
    check("large fixture trips the style check", m.styleHits >= 10, `${m.styleHits} .pf-style-hit`);

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

    // A work counter reaches the timeline WITH its numbers. `countWork` rides
    // `performance.mark`'s `detail`, which is the part a runtime can accept and
    // silently drop, and the whole value of a counter is the number rather than
    // the mark. Asserted on a real engine because it is the only place that can:
    // the counting gate runs under fake timers and reads its own stub.
    const lintCounter = m.work.find((w) => w.name === "lint-request");
    check("the lint work counter reaches the timeline", lintCounter != null,
        m.work.map((w) => w.name).join(", ") || "(no counters stamped)");
    check("and carries its counts rather than an empty detail",
        typeof lintCounter?.detail?.blocks === "number"
            && typeof lintCounter?.detail?.chars === "number"
            && lintCounter.detail.blocks > 0,
        JSON.stringify(lintCounter?.detail ?? null));

    // ── proofreading OFF ──────────────────────────────────────
    // The control (MAR-311): with the feature off the post-paint block is still
    // there, which is what separates round-trip protection's cost from
    // proofreading's. It also pins AGENTS.md's rule that a disabled feature
    // costs nothing — no scan, no decorations.
    await load(page, baseUrl, FIXTURES.medium, { query: "?proofreading=0", expect: ["rtp-end"] });
    const off = await readMarks(page);
    check("proofreading off ⇒ no style decorations", off.styleHits === 0, `${off.styleHits} .pf-style-hit`);
    check("proofreading off ⇒ no proofread pass at all", off.pfStart == null, `start=${off.pfStart}`);
    // The counter's own control, and the negative arm that makes the two checks
    // above it mean something: with the feature off nothing is handed across the
    // boundary, so nothing is counted. It also pins where `countWork` sits — move
    // it above the gate and a disabled feature starts reporting work.
    check("proofreading off ⇒ no work counter either",
        off.work.every((w) => w.name !== "lint-request"),
        off.work.map((w) => w.name).join(", ") || "(none)");
    check("proofreading off ⇒ round-trip protection still runs", off.rtpEnd != null, `end=${off.rtpEnd}`);
}
