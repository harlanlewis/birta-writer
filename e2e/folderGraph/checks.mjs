/**
 * The whole-folder graph against the REAL bundle (MAR-482), on a folder at
 * the VS Code index's cap. What a unit test cannot see: that the layout,
 * stepped inside animation frames, settles without holding the thread for
 * the folder; that the canvas really draws; that the lists name exactly the
 * hubs, the unconnected notes and the references to no note; and that a row
 * opens its note and takes the surface down.
 *
 * The frame-gap check is the one that matters most and the one most exposed to
 * a busy machine, so its bound is generous: it exists to catch a layout that
 * runs the whole folder in one task (seconds), not to time a frame.
 */
async function switchTab(page, name) {
    const select = page.locator(".toc-tabs--select .toc-tabs-select");
    if (await select.count()) {
        await select.dispatchEvent("mousedown");
        await page.locator(".toc-tabs-menu__item", { hasText: name }).first().dispatchEvent("mousedown");
    } else {
        await page.locator(".toc-tab", { hasText: name }).first().dispatchEvent("mousedown");
    }
    await page.waitForTimeout(150);
}

export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); } });

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    await page.waitForTimeout(500);
    await switchTab(page, "Graph");
    await page.waitForSelector(".review-list--graph .lg-whole-folder", { timeout: 5000 });

    // Watch the frames from before the view opens until it settles.
    await page.evaluate(() => {
        window.__frames = [];
        window.__longtasks = [];
        const tick = (ts) => { window.__frames.push(ts); if (!window.__stopFrames) { requestAnimationFrame(tick); } };
        requestAnimationFrame(tick);
        try {
            if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
                new PerformanceObserver((list) => { for (const e of list.getEntries()) { window.__longtasks.push(e.duration); } })
                    .observe({ type: "longtask" });
            }
        } catch { /* an engine without long tasks reports frame gaps alone */ }
    });
    await page.locator(".lg-whole-folder").dispatchEvent("mousedown");
    await page.waitForSelector(".fs-surface.fg-surface", { timeout: 5000 });
    check("Whole folder opens the folder graph on the fullscreen surface", true);

    const t0 = Date.now();
    await page.waitForSelector('.fg[data-settled="true"]', { timeout: 30000 });
    const settleMs = Date.now() - t0;
    const timing = await page.evaluate(() => {
        window.__stopFrames = true;
        const f = window.__frames;
        let maxGap = 0;
        for (let i = 1; i < f.length; i++) { maxGap = Math.max(maxGap, f[i] - f[i - 1]); }
        return { frames: f.length, maxGap: Math.round(maxGap), longtasks: window.__longtasks.map(Math.round) };
    });
    check("the layout settles at the index's cap", settleMs < 30000, `settled in ${settleMs} ms over ${timing.frames} frames`);
    check("and never holds the thread for the folder while it settles (no frame gap near a second)",
        timing.maxGap < 400, JSON.stringify(timing));

    const painted = await page.evaluate(() => {
        const c = document.querySelector(".fg-canvas");
        const ctx = c.getContext("2d");
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let inked = 0;
        for (let i = 3; i < data.length; i += 4 * 97) { if (data[i] > 0) { inked++; } }
        return { inked, width: c.width, height: c.height };
    });
    check("the canvas is drawn", painted.inked > 50 && painted.width > 0, JSON.stringify(painted));

    const lists = await page.evaluate(() => {
        const heads = [...document.querySelectorAll(".fg-heading")].map((h) => h.textContent);
        const rowsAfter = (i) => {
            const list = document.querySelectorAll(".fg-heading")[i].nextElementSibling;
            return list?.classList.contains("fg-list") ? [...list.querySelectorAll(".fg-row")].map((r) => r.title) : [];
        };
        return { heads, hubs: rowsAfter(0), orphans: rowsAfter(1), dangling: rowsAfter(2), expected: window.__expected };
    });
    check("Most connected lists ten notes, the hub first", lists.hubs.length === 10 && lists.hubs[0] === "d0/note-0.md",
        JSON.stringify(lists.hubs.slice(0, 3)));
    check("Unconnected lists exactly the notes nothing touches",
        JSON.stringify(lists.orphans) === JSON.stringify(lists.expected.orphans), JSON.stringify(lists.orphans));
    check("Links to no note lists each missing target once, most named first",
        JSON.stringify(lists.dangling) === JSON.stringify(lists.expected.dangling), JSON.stringify(lists.dangling));

    const layout = await page.evaluate(() => {
        const side = document.querySelector(".fg-side").getBoundingClientRect();
        const close = [...document.querySelectorAll(".fs-surface button")].find((b) => /close/i.test(b.getAttribute("aria-label") ?? b.title ?? ""));
        const c = close?.getBoundingClientRect();
        const firstHead = document.querySelector(".fg-search").getBoundingClientRect();
        const fit = document.querySelector(".fg-fit").getBoundingClientRect();
        const title = document.querySelector(".fs-title")?.getBoundingClientRect();
        const over = (r, box) => r.left < box.right - 1 && box.left < r.right - 1 && r.top < box.bottom - 1 && box.top < r.bottom - 1;
        const stage = document.querySelector(".fg-stage").getBoundingClientRect();
        return {
            sideLeftOfStage: side.right <= stage.left + 1,
            stageWiderThanSide: stage.width > side.width * 1.5,
            closeOnSide: c ? over(c, side) : false,
            fitOnSide: over(fit, side),
            titleOverSearch: title ? title.bottom > firstHead.top + 1 && over(title, side) : false,
        };
    });
    check("the lists sit left of the drawing, and the drawing gets the room",
        layout.sideLeftOfStage && layout.stageWiderThanSide, JSON.stringify(layout));
    check("the shell's Close and Fit float over the drawing, never over the lists",
        !layout.closeOnSide && !layout.fitOnSide, JSON.stringify(layout));
    check("and the title's band leaves the list's first control clear", !layout.titleOverSearch, JSON.stringify(layout));

    await page.fill(".fg-search", "Note 12");
    const summary = await page.textContent(".fg-summary");
    check("filtering by name narrows the notes the view counts", /of 2000 notes/.test(summary ?? ""), summary);

    await page.evaluate(() => { window.__posted.length = 0; });
    await page.locator(".fg-row", { hasText: "Note 0" }).first().click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
        opened: window.__posted.filter((m) => m.type === "openFile").map((m) => m.path),
        surface: !!document.querySelector(".fs-surface.fg-surface"),
    }));
    check("a row opens its note and takes the surface down", after.opened.length === 1 && !after.surface, JSON.stringify(after));

    check("no page errors while laying out and drawing the folder", errors.length === 0, JSON.stringify(errors));
}
