/**
 * TOC as a structural editor — real-browser truths the jsdom suite can't reach
 * (measured band hit-testing, the real scheduler's clock, actual paint):
 *   - dropping a section ONTO an item makes it that section's CHILD (rank =
 *     owner + 1), including the in-place case where the target sits directly
 *     above the dragged section,
 *   - dropping on a gap LINE makes it a SIBLING of the heading below,
 *   - the rendered outline's own rank classes follow the relevel,
 *   - the outline tracks the DOCUMENT, not the save debounce (it updates
 *     inside the trailing window, before any update is posted),
 *   - a FLYOUT outline re-renders after a reorder (rendering used to be gated
 *     on `isOpen`, which the flyout is not — it froze).
 *
 * Fixture: "# One / ### Deep / ## Two / # Three" (see index.html) — mixed
 * ranks, so sibling-vs-child produce distinguishable levels.
 */

/** The serialized doc once an update matching `matcher` lands. */
async function latestDoc(page, matcher, tries = 30) {
    for (let i = 0; i < tries; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last && matcher(last)) return last;
        await page.waitForTimeout(100);
    }
    return null;
}

/** Center + top edge of the rendered TOC item whose text matches exactly. */
function tocItemBox(page, label) {
    return page.$$eval(".toc-item", (els, wanted) => {
        const el = els.find((e) => e.textContent === wanted);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, h: r.height };
    }, label);
}

/** The outline as rendered: label + the rank class the row carries. */
function outline(page) {
    return page.$$eval(".toc-item", (els) => els.map((el) => ({
        text: el.textContent,
        level: (el.className.match(/toc-item--h(\d)/) ?? [])[1] ?? null,
    })));
}

/** A fresh document — every drop below mutates it, so each scenario reboots. */
async function boot(page, baseUrl) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".toc-panel--open .toc-item", { timeout: 10000 });
    await page.waitForTimeout(400);
}

/** Drag the TOC item labelled `from` onto `to` — `where` picks the slot:
 *  "into" = the item's middle band (child), "gap" = its top edge (sibling). */
async function dragItem(page, from, to, where) {
    const src = await tocItemBox(page, from);
    const dst = await tocItemBox(page, to);
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(src.x + 6, src.y + (src.y > dst.y ? -6 : 6)); // cross the 4px threshold
    const targetY = where === "into" ? dst.y : dst.top + 1;
    await page.mouse.move(dst.x, targetY, { steps: 8 });
    await page.waitForTimeout(120);
    const highlighted = await page.$$eval(".toc-item--drop-into", (els) => els.map((e) => e.textContent));
    await page.mouse.up();
    return highlighted;
}

/** Hover a drag from `from` over `to`'s slot and report the drop line's left
 *  edge, WITHOUT dropping — the indent is the only cue for the rank a drop
 *  will impose, so it has to be readable mid-gesture. */
async function hoverLineLeft(page, from, to, where) {
    const src = await tocItemBox(page, from);
    const dst = await tocItemBox(page, to);
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(src.x + 6, src.y + (src.y > dst.y ? -6 : 6));
    await page.mouse.move(dst.x, where === "into" ? dst.y : dst.top + 1, { steps: 8 });
    await page.waitForTimeout(120);
    const left = await page.evaluate(() => {
        const el = document.querySelector(".block-drag-indicator");
        if (!el || getComputedStyle(el).display === "none") return null;
        return Math.round(el.getBoundingClientRect().left);
    });
    await page.keyboard.press("Escape"); // cancel: measure the cue, don't commit
    await page.mouse.up();
    await page.waitForTimeout(150);
    return left;
}

export async function run({ page, check, baseUrl }) {
    // ── 0. Baseline: the fixture's mixed-rank outline renders ──
    await boot(page, baseUrl);
    const start = await outline(page);
    check("panel auto-opened with the mixed-rank outline",
        JSON.stringify(start) === JSON.stringify([
            { text: "One", level: "1" }, { text: "Deep", level: "3" },
            { text: "Two", level: "2" }, { text: "Three", level: "1" },
        ]), JSON.stringify(start));

    // ── 1. Drop ONTO an item ⇒ become its CHILD (owner rank + 1) ──
    // "Three" (H1) onto "Deep" (H3) ⇒ H4, filed at the end of Deep's section
    // (before "## Two", which is what closes it).
    const intoHighlight = await dragItem(page, "Three", "Deep", "into");
    check("dragging a section onto an item highlights it (drop-into)",
        JSON.stringify(intoHighlight) === JSON.stringify(["Deep"]), JSON.stringify(intoHighlight));
    const asChild = await latestDoc(page, (doc) =>
        /### Deep\s+deep text\.\s+#### Three\s+three text\.\s+## Two/.test(doc));
    check("dropping an H1 section onto an H3 relevels it to H4 and files it in that section",
        asChild !== null, JSON.stringify(asChild));
    const childOutline = await outline(page);
    check("the rendered outline follows the relevel (Three now renders as h4)",
        JSON.stringify(childOutline) === JSON.stringify([
            { text: "One", level: "1" }, { text: "Deep", level: "3" },
            { text: "Three", level: "4" }, { text: "Two", level: "2" },
        ]), JSON.stringify(childOutline));

    // ── 2. Drop on a GAP line ⇒ become a SIBLING of the heading below it ──
    await boot(page, baseUrl);
    await dragItem(page, "Three", "Deep", "gap");
    const asSibling = await latestDoc(page, (doc) =>
        /one text\.\s+### Three\s+three text\.\s+### Deep/.test(doc));
    check("dropping an H1 section on the gap above an H3 relevels it to H3 (sibling)",
        asSibling !== null, JSON.stringify(asSibling));

    // ── 3. In-place relevel: drop onto the heading DIRECTLY above you ──
    // "Two" (H2) onto "Deep" (H3): Deep's section ends exactly where Two
    // begins, so the commit pos IS Two's own start — the put-it-back position.
    // The rank still changes (H2 → H4), so this must be a real edit, not the
    // no-op the guard would otherwise swallow.
    await boot(page, baseUrl);
    const inPlaceHighlight = await dragItem(page, "Two", "Deep", "into");
    check("dropping a section onto the heading directly above it offers the into slot",
        JSON.stringify(inPlaceHighlight) === JSON.stringify(["Deep"]), JSON.stringify(inPlaceHighlight));
    const inPlace = await latestDoc(page, (doc) =>
        /### Deep\s+deep text\.\s+#### Two\s+two text\.\s+# Three/.test(doc));
    check("...and relevels it IN PLACE (H2 → H4) instead of doing nothing",
        inPlace !== null, JSON.stringify(inPlace));

    // ── 3b. A COLLAPSED section takes a child — and OPENS to show it ──
    // Relevelling a run into a collapsed section would land it under that fold,
    // at display:none, which reads as a delete. The rule is that landings are
    // REVEALED, not refused (moveBlocks clause 4 / revealPosition, MAR-146):
    // the drop is offered like any other, and the fold opens over the landing
    // afterwards. Refusing the slot instead — the rule this suite used to pin —
    // would deny the plainest nesting gesture the outline has, to defend against
    // a hazard that no longer exists.
    await boot(page, baseUrl);
    await page.$$eval(".ProseMirror h3", (els) => {
        els.find((e) => e.textContent.includes("Deep"))?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(120);
    const deepRect = await page.$$eval(".ProseMirror h3", (els) => {
        const el = els.find((e) => e.textContent.includes("Deep"));
        const r = el.getBoundingClientRect();
        return { x: r.x + 40, cy: r.y + r.height / 2 };
    });
    await page.mouse.move(deepRect.x, deepRect.cy);
    await page.waitForTimeout(200);
    const chevron = await page.$$eval(".ProseMirror .heading-fold-toggle", (els) => {
        const el = els.find((e) => e.closest("h1,h2,h3")?.textContent.includes("Deep"));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    check("the Deep section has a fold chevron to collapse", chevron !== null);
    await page.mouse.click(chevron.cx, chevron.cy);
    await page.waitForTimeout(300);
    check("Deep is collapsed (its body is hidden)",
        await page.evaluate(() => [...document.querySelectorAll(".ProseMirror p")]
            .some((p) => p.textContent.includes("deep text") &&
                getComputedStyle(p).display === "none")));
    const collapsedHighlight = await dragItem(page, "Two", "Deep", "into");
    check("a collapsed section OFFERS its into target (the landing is revealed, not refused)",
        JSON.stringify(collapsedHighlight) === JSON.stringify(["Deep"]), JSON.stringify(collapsedHighlight));
    await page.waitForTimeout(500);
    const nothingHidden = await page.evaluate(() =>
        [...document.querySelector(".ProseMirror").children]
            .filter((el) => getComputedStyle(el).display === "none")
            .map((el) => (el.textContent || "").slice(0, 20)));
    check("nothing the drag touched ends up hidden (no content vanishes)",
        !nothingHidden.some((t) => t.includes("two text") || t.includes("Two")),
        JSON.stringify(nothingHidden));
    // The fold OPENED — the whole point. Its own body coming back is the proof
    // the section unfolded, rather than the run merely landing outside it.
    check("...and the fold opened, so the section's own body is visible again",
        !nothingHidden.some((t) => t.includes("deep text")), JSON.stringify(nothingHidden));
    // The drop still did what it said: Two is now Deep's child (H3 → H4).
    const nested = await latestDoc(page, (doc) => /### Deep\s+deep text\.\s+#### Two/.test(doc));
    check("...and the run landed as the collapsed section's child (H2 → H4)",
        nested !== null, JSON.stringify(nested));

    // ── 3c. The drop line INDENTS to the rank the drop will impose ──
    // The outline is the one surface where a drop silently changes rank, so it
    // is the one that most needs the depth cue the canvas already draws
    // (DESIGN_PRINCIPLES: "the accent drop line, indented to the target
    // depth"). Every gap line used to span the full list width, so an H1
    // dropped above an H3 became an H3 with nothing on screen saying so.
    // Rows indent by (level - 1) * 12 + 8, and the line must agree.
    await boot(page, baseUrl);
    const listLeft = await page.$eval(".toc-list", (el) => Math.round(el.getBoundingClientRect().left));
    // Gap above "Deep" (H3) ⇒ sibling of an H3 ⇒ indent (3-1)*12+8 = 32.
    const deepGapLeft = await hoverLineLeft(page, "Three", "Deep", "gap");
    // Gap above "Three" (H1) ⇒ sibling of an H1 ⇒ indent 8. Dragged from
    // "Deep", whose section ends before Three — dragging "Two" here would aim
    // at a slot inside Two's OWN section, which is refused (no line to read).
    const rootGapLeft = await hoverLineLeft(page, "Deep", "Three", "gap");
    check("a gap line above an H3 indents to H3's depth (not the full list width)",
        deepGapLeft === listLeft + 32, JSON.stringify({ listLeft, deepGapLeft }));
    check("a gap line above an H1 indents to H1's depth",
        rootGapLeft === listLeft + 8, JSON.stringify({ listLeft, rootGapLeft }));
    check("...so the two depths are visibly different (the cue actually carries information)",
        deepGapLeft - rootGapLeft === 24, JSON.stringify({ deepGapLeft, rootGapLeft }));

    // ── 4. Timeliness: the outline tracks the doc, not the save debounce ──
    // The outline used to refresh only from the serialize callback, so its
    // latency followed the scheduler (leading 0 / trailing 300ms / max-wait
    // 2s) — "sometimes instant, sometimes late". Prove the decoupling: land an
    // edit INSIDE the trailing window and confirm the outline already shows it
    // while the save pipeline demonstrably has not run.
    await boot(page, baseUrl);
    const deepH = await page.$$eval("h3", (els) => {
        const el = els.find((e) => e.textContent.includes("Deep"));
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(deepH.x, deepH.y);
    await page.keyboard.press("End");
    await page.keyboard.type("X");        // consumes the scheduler's leading edge
    await page.waitForTimeout(140);       // let that leading sync land
    const beforeCount = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").length);
    await page.keyboard.type("Y");        // now inside the 300ms trailing window
    await page.waitForTimeout(90);        // a few frames — well under the debounce
    const timely = await page.evaluate(() => ({
        toc: [...document.querySelectorAll(".toc-item")].map((el) => el.textContent),
        updates: window.__posted.filter((m) => m.type === "update").length,
    }));
    check("the outline shows an edit made inside the save debounce window",
        timely.toc.includes("DeepXY"), JSON.stringify(timely));
    check("...without the save pipeline having run (no new update posted yet)",
        timely.updates === beforeCount, `${JSON.stringify(timely)} before=${beforeCount}`);

    // ── 5. Flyout freshness: a flown-out outline must re-render after a drop ──
    // Rendering was gated on `isOpen`, which the flyout is NOT — so the flyout
    // list froze at whatever it showed when it flew out, and its stale
    // data-headingPos values then armed the next drag against dead positions.
    await boot(page, baseUrl);
    await page.evaluate(() => document.querySelector(".toc-hide-btn")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await page.waitForTimeout(400);
    await page.locator(".toc-toggle-tab").hover();
    await page.waitForTimeout(400);
    check("the flyout is out for the freshness check",
        await page.evaluate(() => document.querySelector(".toc-panel")
            .classList.contains("toc-panel--flyout-in")));
    await dragItem(page, "Three", "Deep", "gap");
    // The outline must track the drop within a frame or two — measure it
    // rather than sleeping past the question. A generous ceiling (well under
    // the 300ms save debounce) keeps this a freshness check, not a race.
    const latency = await page.evaluate(() => {
        const t0 = performance.now();
        return new Promise((resolve) => {
            const tick = () => {
                const rows = [...document.querySelectorAll(".toc-item")].map((e) => e.textContent);
                if (rows[1] === "Three") return resolve(Math.round(performance.now() - t0));
                if (performance.now() - t0 > 2000) return resolve(-1);
                requestAnimationFrame(tick);
            };
            tick();
        });
    });
    check("the flyout outline re-renders promptly after the drop (< 150ms, no save debounce)",
        latency >= 0 && latency < 150, `latency=${latency}ms`);
    const flyoutOutline = await outline(page);
    check("the FLYOUT outline re-renders after a reorder (order AND rank)",
        JSON.stringify(flyoutOutline) === JSON.stringify([
            { text: "One", level: "1" }, { text: "Three", level: "3" },
            { text: "Deep", level: "3" }, { text: "Two", level: "2" },
        ]), JSON.stringify(flyoutOutline));
    check("the flyout stayed out across the drop",
        await page.evaluate(() => document.querySelector(".toc-panel")
            .classList.contains("toc-panel--flyout-in")));
}
