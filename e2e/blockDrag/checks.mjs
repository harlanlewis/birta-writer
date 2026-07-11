/**
 * Gutter drag-to-reorder (MAR-19) — real-browser truths (pointer sessions,
 * layout-driven drop targets, the indicator):
 *   - dragging a paragraph's P marker below the list reorders the document,
 *   - the accent drop indicator shows during a drag and hides after,
 *   - Escape cancels a drag without touching the document,
 *   - a heading's marker drags its whole section,
 *   - a drag does not also open the block menu; a plain click still does.
 */

/** The serialized doc after updates settle (updates are debounced 300ms). */
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

/**
 * Center of the gutter marker owned by the top-level block matching `sel`
 * (optionally disambiguated by contained text — earlier checks mutate the
 * document, so positional nth-of-type selectors would drift).
 */
async function markerCenter(page, sel, text) {
    const host = await page.$$eval(sel, (els, t) => {
        const el = (t ? els.find((e) => e.textContent.includes(t)) : els[0]) ?? els[0];
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(14, r.height / 2) };
    }, text ?? null);
    // Reveal (hover) first so geometry is stable, then measure.
    await page.mouse.move(host.x, host.y);
    await page.waitForTimeout(120);
    return page.$$eval(`${sel} .heading-fold-marker`, (els, t) => {
        const el = (t
            ? els.find((e) => e.closest(".ProseMirror > *")?.textContent.includes(t))
            : els[0]) ?? els[0];
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, text ?? null);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".heading-fold-marker--paragraph", { timeout: 10000 });
    await page.waitForTimeout(500);

    // ── 1. Drag the first paragraph below the list ──
    const pMarker = await markerCenter(page, ".ProseMirror > p");
    const listRect = await page.$eval(".ProseMirror > ul", (el) => {
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom, x: r.x + r.width / 2 };
    });
    await page.mouse.move(pMarker.x, pMarker.y);
    await page.mouse.down();
    await page.mouse.move(pMarker.x + 10, pMarker.y + 10); // cross the threshold
    await page.mouse.move(listRect.x, listRect.bottom - 2, { steps: 8 });
    await page.waitForTimeout(100);
    const indicatorVisible = await page.$eval(".block-drag-indicator", (el) =>
        getComputedStyle(el).display !== "none");
    check("drop indicator shows during a drag", indicatorVisible);
    await page.mouse.up();
    const reordered = await latestDoc(page, (doc) =>
        doc.indexOf("item two") < doc.indexOf("Alpha paragraph."));
    check("dragging the paragraph below the list reorders the doc", reordered !== null);
    const indicatorHidden = await page.$eval(".block-drag-indicator", (el) =>
        getComputedStyle(el).display === "none");
    check("indicator hides after the drop", indicatorHidden);
    check("the drag did not open the block menu", (await page.$(".block-menu")) === null);

    // ── 2. Escape cancels a drag ──
    const before = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? null;
    });
    const omega = await markerCenter(page, ".ProseMirror > p", "Omega");
    await page.mouse.move(omega.x, omega.y);
    await page.mouse.down();
    await page.mouse.move(omega.x + 10, omega.y + 60, { steps: 6 });
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(450);
    const after = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? null;
    });
    check("Escape cancels the drag without a doc change", before === after);
    const indicatorGone = await page.$eval(".block-drag-indicator", (el) =>
        getComputedStyle(el).display === "none");
    check("indicator hides after a cancel", indicatorGone);

    // ── 3. A heading drags its whole section ──
    // Drag "# Section A"'s marker to the very end of the document.
    const hMarker = await markerCenter(page, ".ProseMirror > h1", "Section A");
    const lastRect = await page.$eval(".ProseMirror > *:last-child", (el) => {
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom, x: r.x + r.width / 2 };
    });
    await page.mouse.move(hMarker.x, hMarker.y);
    await page.mouse.down();
    await page.mouse.move(hMarker.x + 10, hMarker.y + 10);
    await page.mouse.move(lastRect.x, lastRect.bottom - 1, { steps: 8 });
    await page.waitForTimeout(100);
    // The veil dims the whole dragged section: it must cover the heading AND
    // its content, and stop before the next section.
    const veil = await page.evaluate(() => {
        const el = document.querySelector(".block-drag-veil");
        if (!el || getComputedStyle(el).display === "none") return null;
        const v = el.getBoundingClientRect();
        const heads = [...document.querySelectorAll(".ProseMirror > h1")];
        const a = heads.find((h) => h.textContent.includes("Section A"))?.getBoundingClientRect();
        const b = heads.find((h) => h.textContent.includes("Section B"))?.getBoundingClientRect();
        if (!a || !b) return { missing: true };
        return {
            coversHeading: v.top <= a.top + 2,
            coversContent: v.bottom >= a.bottom + 10,
            stopsBeforeNext: v.bottom <= b.top + 2,
        };
    });
    check("drag veil dims exactly the dragged section",
        veil !== null && veil.coversHeading && veil.coversContent && veil.stopsBeforeNext,
        JSON.stringify(veil));
    await page.mouse.up();
    const veilGone = await page.$eval(".block-drag-veil", (el) =>
        getComputedStyle(el).display === "none");
    check("veil hides after the drop", veilGone);
    const sectionMoved = await latestDoc(page, (doc) => {
        const a = doc.indexOf("# Section A");
        const contentA = doc.indexOf("content of A");
        const b = doc.indexOf("# Section B");
        return b !== -1 && b < a && a < contentA; // B now precedes A; A kept its body
    });
    check("a heading drags its whole section", sectionMoved !== null);

    // ── 3b. A selection spanning blocks drags them all together ──
    // Select from inside "Omega paragraph." down into "content of B" (the doc
    // was reordered by earlier checks; both exist somewhere). Then drag the
    // marker of a block INSIDE the selection: the whole covered run moves.
    const omegaSel = await page.$$eval(".ProseMirror > p", (els) => {
        const el = els.find((e) => e.textContent.includes("Omega"));
        const r = el.getBoundingClientRect();
        return { x: r.x + 10, y: r.y + r.height / 2 };
    });
    const contentBSel = await page.$$eval(".ProseMirror > p", (els) => {
        const el = els.find((e) => e.textContent.includes("content of B"));
        const r = el.getBoundingClientRect();
        return { x: r.x + 30, y: r.y + r.height / 2 };
    });
    await page.mouse.click(omegaSel.x, omegaSel.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(contentBSel.x, contentBSel.y);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(100);
    // Discoverability: every covered block's marker surfaces while the
    // multi-block selection exists.
    const covered = await page.$$eval(".heading-fold-marker--covered", (els) =>
        els.map((el) => parseFloat(getComputedStyle(el).opacity)));
    check("covered blocks' markers surface during a multi-block selection",
        covered.length >= 2 && covered.every((o) => o > 0.4), JSON.stringify(covered));
    // Drag Omega's marker to the very top of the document.
    const multiMarker = await markerCenter(page, ".ProseMirror > p", "Omega");
    const firstRect = await page.$eval(".ProseMirror > *:first-child", (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, x: r.x + r.width / 2 };
    });
    await page.mouse.move(multiMarker.x, multiMarker.y);
    await page.mouse.down();
    await page.mouse.move(multiMarker.x + 10, multiMarker.y + 10);
    await page.waitForTimeout(80);
    const multiPill = await page.$eval(".block-drag-pill", (el) => el.textContent).catch(() => null);
    await page.mouse.move(firstRect.x, firstRect.top + 1, { steps: 8 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    check("multi-drag pill counts the selected blocks", /\d+ blocks/.test(multiPill ?? ""),
        `pill=${multiPill}`);
    const multiMoved = await latestDoc(page, (doc) =>
        doc.indexOf("Omega") < doc.indexOf("Alpha paragraph.") &&
        doc.indexOf("content of B") < doc.indexOf("Alpha paragraph."));
    check("dragging a marker inside a multi-block selection moves the whole run", multiMoved !== null);
    // Post-drop, the moved run stays selected (grabbable for another drag).
    const runSelected = await page.evaluate(() => {
        const sel = window.getSelection();
        return sel ? sel.toString().includes("Omega") && sel.toString().includes("content of B") : false;
    });
    check("the moved run stays selected after the drop", runSelected);

    // ── 4. A plain click (no movement) still opens the menu ──
    const pAgain = await markerCenter(page, ".ProseMirror > p");
    await page.mouse.click(pAgain.x, pAgain.y);
    await page.waitForTimeout(100);
    check("a plain marker click still opens the block menu", (await page.$(".block-menu")) !== null);

    // ── 5. The open menu stays glued to its marker while scrolling ──
    // (Regression: it used to keep its fixed viewport coordinates and float
    // away from the marker.)
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    const glued = await page.evaluate(() => {
        const menu = document.querySelector(".block-menu");
        const marker = document.querySelector(".heading-fold-marker--menu-open");
        if (!menu || !marker) return { menu: !!menu, marker: !!marker };
        const m = menu.getBoundingClientRect();
        const a = marker.getBoundingClientRect();
        // Below-anchor placement: menu top ≈ marker bottom + 4 (a flip to
        // above is also legal; accept either side within tolerance).
        const below = Math.abs(m.top - (a.bottom + 4)) <= 3;
        const above = Math.abs(m.bottom - (a.top - 4)) <= 3;
        return { menu: true, marker: true, tracks: below || above };
    });
    check("menu tracks its marker through a scroll",
        glued.menu && glued.marker && glued.tracks === true, JSON.stringify(glued));
    await page.keyboard.press("Escape");

    // ── 5b. Small viewport: the menu fits the available band and scrolls ──
    // (Regression: it used to clamp to y=8, sliding under the fixed topbar
    // and covering its own anchor block.)
    await page.setViewportSize({ width: 1000, height: 480 });
    await page.waitForTimeout(100);
    const pSmall = await markerCenter(page, ".ProseMirror > p");
    await page.mouse.click(pSmall.x, pSmall.y);
    await page.waitForTimeout(100);
    const fit = await page.evaluate(() => {
        const menu = document.querySelector(".block-menu");
        if (!menu) return null;
        const r = menu.getBoundingClientRect();
        const topbar = document.querySelector(".editor-topbar")?.getBoundingClientRect().height ?? 0;
        return {
            belowTopbar: r.top >= topbar,
            onScreen: r.bottom <= window.innerHeight - 4,
            scrolls: menu.scrollHeight > menu.clientHeight + 1 || r.height < 400,
        };
    });
    check("small viewport: menu clears the topbar, fits on screen, scrolls internally",
        fit !== null && fit.belowTopbar && fit.onScreen && fit.scrolls, JSON.stringify(fit));
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.waitForTimeout(100);

    // ── 6. Typing while the menu is open closes it (doc-change close) ──
    const pOnceMore = await markerCenter(page, ".ProseMirror > p");
    await page.mouse.click(pOnceMore.x, pOnceMore.y);
    await page.waitForTimeout(100);
    check("menu open before typing", (await page.$(".block-menu")) !== null);
    await page.keyboard.type("x");
    await page.waitForTimeout(100);
    check("typing closes the block menu", (await page.$(".block-menu")) === null);
}
