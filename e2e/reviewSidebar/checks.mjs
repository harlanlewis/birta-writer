/**
 * The MAR-188 review sidebar, verified against the REAL bundle — the surface
 * the jsdom unit suite can only assume, since it never mounts Milkdown, never
 * parses markers out of a real markdown round-trip (HTML comments as `html`
 * atoms, `- [ ]` as a checked list_item), and never runs the proofread pass.
 *
 * Covers: the three tabs render; Notes lists every built-in marker in document
 * order and hides the checked box; Proofreading lists a live style finding;
 * clicking a Notes row selects its marker in the editor; and typing with the
 * Notes tab open keeps the list correct through the incremental scan — with a
 * page-error/console-error guard over the whole run (MAR-192 hardening).
 */
export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    // Let auto-open + the deferred proofread idle pass settle.
    await page.waitForSelector(".pf-style-hit", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);

    // ── Tabs render ───────────────────────────────────────────────────────
    const tabLabels = await page.$$eval(".toc-tab", (els) => els.map((e) => e.textContent));
    check("three tabs render, labelled Contents / Proofreading / Notes",
        JSON.stringify(tabLabels) === JSON.stringify(["Contents", "Proofreading", "Notes"]),
        JSON.stringify(tabLabels));

    // Contents is the default tab and lists the headings.
    const headingRows = await page.$$eval(".toc-list .toc-item", (els) => els.map((e) => e.textContent.trim()));
    check("Contents tab lists the document headings",
        headingRows.length === 4 && headingRows[0] === "Intro",
        JSON.stringify(headingRows));

    // ── Notes tab: markers in document order, checked box excluded ─────────
    await page.click(".toc-tab:nth-child(3)"); // Notes
    await page.waitForSelector(".review-list--notes:not(.toc-view--hidden)", { timeout: 5000 });
    const notes = await page.$$eval(".review-list--notes .review-item", (els) =>
        els.map((el) => ({
            tag: el.querySelector(".review-item__tag")?.textContent,
            label: el.querySelector(".review-item__label")?.textContent,
        })));
    check("Notes lists every built-in marker in document order",
        JSON.stringify(notes.map((n) => n.tag)) === JSON.stringify(["TK", "TODO", "Task", "FIXME"]),
        JSON.stringify(notes));
    check("a checked checkbox is NOT listed as a note",
        !notes.some((n) => n.label && n.label.includes("outline done")),
        JSON.stringify(notes.map((n) => n.label)));
    check("a bracketed/colon marker's trailing text becomes the row label",
        notes.some((n) => n.tag === "TODO" && /background section/.test(n.label || "")),
        JSON.stringify(notes.map((n) => n.label)));

    // ── Proofreading tab: a live style finding ────────────────────────────
    await page.click(".toc-tab:nth-child(2)"); // Proofreading
    await page.waitForSelector(".review-list--proofread:not(.toc-view--hidden)", { timeout: 5000 });
    const findings = await page.$$eval(".review-list--proofread .review-item", (els) =>
        els.map((el) => el.querySelector(".review-item__label")?.textContent));
    check("Proofreading lists the live style finding (filler 'really')",
        findings.some((f) => f === "really"),
        JSON.stringify(findings));

    // ── Click a Notes row → it selects the marker in the editor ───────────
    await page.click(".toc-tab:nth-child(3)"); // back to Notes
    await page.waitForSelector(".review-list--notes:not(.toc-view--hidden)", { timeout: 5000 });
    // The [TK] row is first (document order); clicking it must select "[TK]".
    await page.click(".review-list--notes .review-item:first-child .review-item__main");
    await page.waitForTimeout(150);
    const selected = await page.evaluate(() => (window.getSelection()?.toString() ?? ""));
    check("clicking the [TK] note selects its marker in the document",
        selected.includes("[TK]"), JSON.stringify(selected));

    // ── Type with the Notes tab open → incremental scan keeps it correct ──
    const beforeCount = notes.length;
    await page.click(".ProseMirror");
    // Type into the first paragraph, ahead of every marker, so every anchor
    // shifts — the incremental-scan path.
    await page.keyboard.press("Home");
    await page.keyboard.type("Prefixed. ");
    await page.waitForTimeout(300);
    const afterTags = await page.$$eval(".review-list--notes .review-item", (els) =>
        els.map((el) => el.querySelector(".review-item__tag")?.textContent));
    check("typing with the Notes tab open keeps the marker list intact",
        JSON.stringify(afterTags) === JSON.stringify(["TK", "TODO", "Task", "FIXME"]),
        `before=${beforeCount} after=${JSON.stringify(afterTags)}`);

    // Clicking [TK] AFTER the edit must still select it (anchors tracked live).
    await page.click(".review-list--notes .review-item:first-child .review-item__main");
    await page.waitForTimeout(150);
    const selectedAfter = await page.evaluate(() => (window.getSelection()?.toString() ?? ""));
    check("after typing, the [TK] note still selects its (shifted) marker",
        selectedAfter.includes("[TK]"), JSON.stringify(selectedAfter));

    check("no page errors or console errors during the run", errors.length === 0,
        errors.slice(0, 5).join(" | "));
}
