/**
 * TOC drag-and-drop — real-browser truths the jsdom suite can't reach
 * (pointer drag sessions, measured drop slots, panel overlay hit-testing):
 *   - dragging a top-level TOC item reorders its whole section,
 *   - the shared drop-indicator line draws over the panel at gap slots,
 *   - Escape mid-drag cancels without touching the document,
 *   - an in-place micro-drag (jittery click) still navigates on release,
 *   - a gutter-handle drag into an item's middle band highlights it
 *     (.toc-item--drop-into) AND draws the gap line at the section's end,
 *     then drops the block there,
 *   - in overlay mode a handle drag entering the panel does not close it.
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

/** The last update posted (or null) — the "did the doc change" baseline. */
function lastUpdate(page) {
    return page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? null;
    });
}

/** Center of the rendered TOC item whose text matches exactly. */
function tocItemBox(page, label) {
    return page.$$eval(".toc-item", (els, wanted) => {
        const el = els.find((e) => e.textContent === wanted);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, h: r.height };
    }, label);
}

/**
 * Center of the gutter marker owned by the top-level block containing `text`
 * — scrolled into view and hover-revealed first so geometry is stable.
 */
async function markerCenter(page, sel, text) {
    const host = await page.$$eval(sel, (els, t) => {
        const el = (t ? els.find((e) => e.textContent.includes(t)) : els[0]) ?? els[0];
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(14, r.height / 2) };
    }, text ?? null);
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
    await page.waitForSelector(".toc-panel--open .toc-item", { timeout: 10000 });
    await page.waitForTimeout(500);

    const outline = await page.$$eval(".toc-item", (els) => els.map((el) => el.textContent));
    check("panel auto-opened with the outline rendered",
        JSON.stringify(outline) === JSON.stringify(["Alpha", "Alpha sub", "Beta", "Gamma"]),
        JSON.stringify(outline));

    // ── 1. Dragging a top-level item reorders its whole section ──
    // Grab "Beta" and drop it at the gap ABOVE "Alpha" (an item's top edge is
    // its gap line).
    const beta = await tocItemBox(page, "Beta");
    const alpha = await tocItemBox(page, "Alpha");
    await page.mouse.move(beta.x, beta.y);
    await page.mouse.down();
    await page.mouse.move(beta.x + 6, beta.y - 6); // cross the 4px threshold
    await page.mouse.move(alpha.x, alpha.top + 1, { steps: 6 });
    await page.waitForTimeout(100);
    const midDrag = await page.evaluate(() => {
        const ind = document.querySelector(".block-drag-indicator");
        const panel = document.querySelector(".toc-panel").getBoundingClientRect();
        const r = ind?.getBoundingClientRect();
        return {
            source: [...document.querySelectorAll(".toc-item")]
                .find((el) => el.textContent === "Beta")
                ?.classList.contains("toc-item--drag-source") ?? false,
            shown: !!ind && getComputedStyle(ind).display !== "none",
            overPanel: !!r && r.left >= panel.left - 2 && r.right <= panel.right + 2,
        };
    });
    check("mid-drag: source item ghosts (toc-item--drag-source)", midDrag.source);
    check("mid-drag: shared drop-indicator line draws over the panel",
        midDrag.shown && midDrag.overPanel, JSON.stringify(midDrag));
    await page.mouse.up();
    const reordered = await latestDoc(page, (doc) => {
        const b = doc.indexOf("# Beta");
        return b !== -1 && b < doc.indexOf("# Alpha") &&
            doc.indexOf("beta text.") < doc.indexOf("# Alpha") && // body traveled with it
            doc.indexOf("# Alpha") < doc.indexOf("## Alpha sub"); // Alpha kept its sub
    });
    check("dropping at the gap reorders the whole Beta section above Alpha", reordered !== null);
    check("indicator hides after the drop",
        await page.$eval(".block-drag-indicator", (el) => getComputedStyle(el).display === "none"));

    // ── 2. Escape mid-drag cancels without touching the document ──
    const before = await lastUpdate(page);
    const gamma = await tocItemBox(page, "Gamma");
    const alpha2 = await tocItemBox(page, "Alpha");
    await page.mouse.move(gamma.x, gamma.y);
    await page.mouse.down();
    await page.mouse.move(gamma.x + 6, gamma.y - 6);
    await page.mouse.move(alpha2.x, alpha2.top + 1, { steps: 5 });
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(450);
    check("Escape cancels a TOC drag without a doc change",
        (await lastUpdate(page)) === before);
    check("indicator hides after the cancel",
        await page.$eval(".block-drag-indicator", (el) => getComputedStyle(el).display === "none"));

    // ── 3. An in-place micro-drag still navigates on release ──
    // A jittery click on "Gamma" crosses the 4px drag threshold but never
    // leaves the item: the started (self-targeted, no-op) drag must not
    // swallow the click the release produces — the user meant to navigate.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    const gamma2 = await tocItemBox(page, "Gamma");
    await page.mouse.move(gamma2.x, gamma2.y - 3);
    await page.mouse.down();
    await page.mouse.move(gamma2.x, gamma2.y + 3, { steps: 3 }); // >4px, same item
    await page.mouse.up();
    // The navigation scroll is smooth — wait for it to settle (the active
    // item is re-derived from scroll position while in flight).
    const settleScroll = () => page.evaluate(() => new Promise((resolve) => {
        let last = window.scrollY;
        const tick = () => {
            if (window.scrollY === last && window.scrollY > 0) return resolve();
            last = window.scrollY;
            setTimeout(tick, 150);
        };
        setTimeout(tick, 150);
    }));
    await settleScroll();
    await page.waitForTimeout(200);
    const microNav = await page.evaluate(() => ({
        scrolled: window.scrollY > 50,
        active: [...document.querySelectorAll(".toc-item--active")].map((el) => el.textContent),
    }));
    check("an in-place micro-drag still navigates on release",
        microNav.scrolled && microNav.active.includes("Gamma"), JSON.stringify(microNav));

    // ── 4. A plain click also navigates ──
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const gamma3 = await tocItemBox(page, "Gamma");
    await page.mouse.click(gamma3.x, gamma3.y);
    await settleScroll();
    await page.waitForTimeout(200);
    const nav = await page.evaluate(() => ({
        scrolled: window.scrollY > 50,
        active: [...document.querySelectorAll(".toc-item--active")].map((el) => el.textContent),
    }));
    check("a plain TOC item click navigates to the heading",
        nav.scrolled && nav.active.includes("Gamma"), JSON.stringify(nav));

    // ── 5. Gutter handle → item middle band refiles the block into the section ──
    // Drag "loose paragraph." (Gamma's last block) into "Alpha": the item
    // highlights (drop-into) AND the shared gap line marks the landing — the
    // END of Alpha's whole section, i.e. the "Gamma" item's top edge (after
    // "alpha sub text.", before the next H1).
    const pMarker = await markerCenter(page, ".ProseMirror > p", "loose paragraph");
    const alphaItem = await tocItemBox(page, "Alpha");
    await page.mouse.move(pMarker.x, pMarker.y);
    await page.mouse.down();
    await page.mouse.move(pMarker.x + 8, pMarker.y + 8); // cross the threshold
    await page.mouse.move(alphaItem.x, alphaItem.y, { steps: 8 }); // item's middle band
    await page.waitForTimeout(100);
    const intoState = await page.evaluate(() => {
        const ind = document.querySelector(".block-drag-indicator");
        const gammaItem = [...document.querySelectorAll(".toc-item")]
            .find((el) => el.textContent === "Gamma");
        return {
            into: [...document.querySelectorAll(".toc-item--drop-into")].map((el) => el.textContent),
            indicator: getComputedStyle(ind).display !== "none",
            // The 2px line centers on the boundary (top = y − 1).
            lineAtSectionEnd: Math.abs(
                ind.getBoundingClientRect().top + 1 - gammaItem.getBoundingClientRect().top) < 2,
        };
    });
    check("handle drag over an item's middle band highlights it (drop-into)",
        JSON.stringify(intoState.into) === JSON.stringify(["Alpha"]), JSON.stringify(intoState));
    check("the into hover also draws the gap line at the section's end (Gamma's top)",
        intoState.indicator && intoState.lineAtSectionEnd, JSON.stringify(intoState));
    await page.mouse.up();
    const refiled = await latestDoc(page, (doc) => {
        const loose = doc.indexOf("loose paragraph.");
        return loose !== -1 &&
            doc.indexOf("alpha sub text.") < loose && // at the section's end…
            loose < doc.indexOf("# Gamma");           // …before the next top-level section
    });
    check("dropping into Alpha files the block at that section's end", refiled !== null);
    check("drop-into highlight clears after the drop",
        (await page.$(".toc-item--drop-into")) === null);

    // ── 6. Overlay mode: a handle drag entering the panel must not close it ──
    // Shrink below the docked threshold (860 < 220 + 720) → overlay; reopen
    // via the reveal tab, then flip the panel to the RIGHT edge so the left
    // gutter markers stay grabbable beside it.
    await page.setViewportSize({ width: 860, height: 900 });
    await page.waitForTimeout(200);
    check("narrow viewport switches the panel to overlay (auto-closed)",
        await page.evaluate(() =>
            document.body.classList.contains("toc-overlay") &&
            !document.querySelector(".toc-panel").classList.contains("toc-panel--open")));
    await page.$eval(".toc-toggle-tab", (el) =>
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await page.waitForTimeout(300);
    check("reveal tab opens the overlay panel",
        await page.evaluate(() => document.body.classList.contains("toc-overlay-open")));
    await page.$eval(".toc-flip-btn", (el) =>
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await page.waitForTimeout(300);
    check("panel flipped right, still open",
        await page.evaluate(() => {
            const panel = document.querySelector(".toc-panel");
            return panel.classList.contains("toc-panel--right") &&
                panel.classList.contains("toc-panel--open");
        }));

    // Drag "beta text." toward the "Gamma" item — a foreign section, so the
    // into slot is legal (dropping a block over its OWN section's item is the
    // put-it-back gesture and deliberately shows no target).
    const beforeOverlay = await lastUpdate(page);
    const marker2 = await markerCenter(page, ".ProseMirror > p", "beta text");
    const overlayItem = await tocItemBox(page, "Gamma");
    check("overlay panel leaves the gutter grabbable beside it",
        overlayItem !== null && marker2.x < (await page.$eval(".toc-panel",
            (el) => el.getBoundingClientRect().left)));
    await page.mouse.move(marker2.x, marker2.y);
    await page.mouse.down();
    await page.mouse.move(marker2.x + 8, marker2.y + 8); // threshold — mousedown was outside the panel
    await page.mouse.move(overlayItem.x, overlayItem.y, { steps: 10 });
    await page.waitForTimeout(100);
    const overlayMid = await page.evaluate(() => ({
        open: document.querySelector(".toc-panel").classList.contains("toc-panel--open"),
        into: [...document.querySelectorAll(".toc-item--drop-into")].map((el) => el.textContent),
    }));
    check("handle drag entering the overlay panel does not close it",
        overlayMid.open, JSON.stringify(overlayMid));
    check("overlay panel still targets drop-into mid-drag",
        JSON.stringify(overlayMid.into) === JSON.stringify(["Gamma"]), JSON.stringify(overlayMid));
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(450);
    check("Escape-canceled overlay drag leaves the doc unchanged",
        (await lastUpdate(page)) === beforeOverlay);
    check("panel remains open after the canceled drag",
        await page.evaluate(() =>
            document.querySelector(".toc-panel").classList.contains("toc-panel--open")));

    // ── Flyout parity: a reorder drag INSIDE the flyout must draw its indicator
    // over the flyout panel (dnd engages, 1:1 with the docked sidebar), layer
    // above the flyout, and not retract mid-drag. ──
    await page.evaluate(() =>
        document.querySelector(".toc-hide-btn")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await page.waitForTimeout(400);
    await page.locator(".toc-toggle-tab").hover();
    await page.waitForTimeout(400);
    check("the flyout is out for the drag-parity check",
        await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--flyout-in")));

    const items = await page.$$eval(".toc-item", (els) => els.map((el) => el.textContent));
    const src = await tocItemBox(page, items[1]); // some top-level item
    const dst = await tocItemBox(page, items[0]); // drop above the first
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(src.x + 6, src.y - 6); // cross the drag threshold
    await page.mouse.move(dst.x, dst.top + 1, { steps: 6 });
    await page.waitForTimeout(120);
    const flyoutDrag = await page.evaluate(() => {
        const ind = document.querySelector(".block-drag-indicator");
        const panel = document.querySelector(".toc-panel").getBoundingClientRect();
        const r = ind?.getBoundingClientRect();
        return {
            shown: !!ind && getComputedStyle(ind).display !== "none",
            overPanel: !!r && r.left >= panel.left - 2 && r.right <= panel.right + 2,
            indZ: ind ? parseInt(getComputedStyle(ind).zIndex, 10) : 0,
            flyoutStillOpen: document.body.classList.contains("toc-flyout-open"),
        };
    });
    check("flyout drag: the drop indicator draws over the FLYOUT panel, not the page",
        flyoutDrag.shown && flyoutDrag.overPanel, JSON.stringify(flyoutDrag));
    check("flyout drag: the indicator layers above the flyout (z > 10000)",
        flyoutDrag.indZ > 10000, JSON.stringify(flyoutDrag));
    check("flyout drag: the flyout stays open mid-drag (doesn't retract)",
        flyoutDrag.flyoutStillOpen, JSON.stringify(flyoutDrag));
    await page.mouse.up();
}
