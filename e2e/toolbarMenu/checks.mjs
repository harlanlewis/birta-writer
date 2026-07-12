/**
 * Toolbar dropdown hover-menu behavior — real-browser hit-testing that jsdom
 * can't do. Guards the instant-close + transparent gap-bridge added when the
 * menu hide delay dropped to 0:
 *   - switching between adjacent dropdowns never briefly stacks two menus,
 *   - crossing the button→menu gap keeps the menu open (the
 *     .tb-fmt-wrap.tb-menu-open::after bridge holds the wrap "hovered"),
 *   - leaving a menu closes it on the next tick (no lingering delay),
 *   - --tb-menu-gap is published to CSS from the JS MENU_GAP constant.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector('[data-item-id="listMenu"] .tb-fmt-btn', { timeout: 10000 });
    await page.waitForSelector('[data-item-id="quote"] .tb-fmt-btn', { timeout: 10000 });

    const listWrap = '[data-item-id="listMenu"] .tb-fmt-wrap';
    const listBtn = '[data-item-id="listMenu"] .tb-fmt-btn';
    const listMenu = '[data-item-id="listMenu"] .tb-list-menu';
    const quoteBtn = '[data-item-id="quote"] .tb-fmt-btn';
    const quoteMenu = '[data-item-id="quote"] .tb-callout-menu';

    const disp = (sel) => page.$eval(sel, (el) => getComputedStyle(el).display);
    const box = (sel) =>
        page.$eval(sel, (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
        });
    const nextTick = () =>
        page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Both dropdowns must be on the bar (not collapsed into the ⋯ overflow menu),
    // or the interaction under test can't be exercised.
    const overflowed = await page.$eval(listWrap, (el) => !!el.closest(".tb-more-menu"));
    check("Lists + Quote render on the bar (not overflowed)", !overflowed);

    // ── 1. Switching adjacent dropdowns never stacks two menus ──
    await page.hover(listBtn);
    await page.waitForTimeout(30);
    check("hovering Lists opens its menu", (await disp(listMenu)) === "flex");

    await page.hover(quoteBtn);
    await page.waitForTimeout(30); // let the instant (setTimeout 0) close fire
    const listAfter = await disp(listMenu);
    const quoteAfter = await disp(quoteMenu);
    check("moving to Quote closes Lists (no stack)", listAfter === "none", `lists=${listAfter}`);
    check("moving to Quote opens Quote", quoteAfter === "flex", `quote=${quoteAfter}`);
    check("never two menus open at once", !(listAfter === "flex" && quoteAfter === "flex"));

    // reset to empty space
    await page.mouse.move(500, 800, { steps: 5 });
    await page.waitForTimeout(30);

    // ── 2. button→menu gap traversal keeps the menu open ──
    await page.hover(quoteBtn);
    await page.waitForTimeout(30);
    check("Quote menu open before the gap cross", (await disp(quoteMenu)) === "flex");
    const qb = await box(quoteBtn);
    const qm = await box(quoteMenu);
    const gap = qm.y - (qb.y + qb.h);
    check("a real gap exists to bridge (menu sits below the button)", gap > 2 && gap < 14, `gap=${gap.toFixed(1)}px`);
    // Move straight down from the button, through the gap, into the menu body,
    // in many small steps so any mid-travel mouseleave would close it first.
    await page.mouse.move(qb.cx, qb.cy);
    await page.mouse.move(qm.cx, qm.cy + 20, { steps: 40 });
    await page.waitForTimeout(30);
    check("menu stays open crossing the button→menu gap (bridge works)", (await disp(quoteMenu)) === "flex");

    // ── 3. leaving the menu closes it on the next tick (no lingering delay) ──
    check("menu still open before leaving", (await disp(quoteMenu)) === "flex");
    await page.mouse.move(qm.cx, qm.cy); // firmly inside the menu
    await page.mouse.move(500, 820, { steps: 20 }); // out to empty editor space
    await nextTick();
    check("menu closes immediately on leave (hideDelay 0)", (await disp(quoteMenu)) === "none");

    // ── 4. single-source gap: CSS var published from MENU_GAP ──
    const cssVar = await page.$eval(quoteBtn, (el) =>
        getComputedStyle(el.closest(".tb-fmt-wrap")).getPropertyValue("--tb-menu-gap").trim(),
    );
    check("--tb-menu-gap published to CSS from MENU_GAP", cssVar === "6px", `value="${cssVar}"`);

    // ── 5. Typography menu: the gutter-markers segmented control ──
    // A captioned None/Headings/All radio row under the width segments; picks
    // apply the gutter-rest-* body class immediately (menu stays open) and
    // post setGutterMarkers for the settings round-trip.
    const fontBtn = '[data-item-id="fontPreset"] .tb-fmt-btn';
    const fontMenu = '[data-item-id="fontPreset"] .tb-font-menu';
    const gutterSeg = '.tb-seg-row[aria-label="Gutter markers shown at rest"] .tb-seg-btn';
    const fontOverflowed = await page.$eval(fontBtn, (el) => !!el.closest(".tb-more-menu"));
    check("font menu renders on the bar (not overflowed)", !fontOverflowed);
    await page.hover(fontBtn);
    await page.waitForTimeout(30);
    check("hovering the A button opens the typography menu", (await disp(fontMenu)) === "flex");
    const caption = await page.$eval(`${fontMenu} .tb-seg-caption`, (el) => el.textContent).catch(() => null);
    check("the gutter segments carry their caption", caption === "Gutter markers", `caption=${caption}`);
    const segState = () =>
        page.$$eval(gutterSeg, (els) =>
            els.map((el) => ({ label: el.textContent, on: el.getAttribute("aria-checked") === "true" })));
    const atRest = await segState();
    check("three segments in display order with Headings (default) active",
        JSON.stringify(atRest) === JSON.stringify([
            { label: "None", on: false }, { label: "Headings", on: true }, { label: "All", on: false },
        ]), JSON.stringify(atRest));
    // Pick None: body class flips, the segment lights, the menu stays open.
    const noneBox = await page.$eval(gutterSeg, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(noneBox.x, noneBox.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(30);
    check("picking None applies the gutter-rest-none body class",
        await page.evaluate(() => document.body.classList.contains("gutter-rest-none")));
    check("picking None marks its segment active", (await segState())[0].on === true);
    check("the menu stays open after a segment pick", (await disp(fontMenu)) === "flex");
    const postedGutter = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "setGutterMarkers").map((m) => m.mode));
    check("the pick posts setGutterMarkers for the settings round-trip",
        JSON.stringify(postedGutter) === JSON.stringify(["none"]), JSON.stringify(postedGutter));
    // Restore the default for any checks that follow.
    const headingsBox = await page.$$eval(gutterSeg, (els) => {
        const r = els[1].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(headingsBox.x, headingsBox.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(30);
    check("picking Headings clears the override body class",
        await page.evaluate(() => !document.body.classList.contains("gutter-rest-none")
            && !document.body.classList.contains("gutter-rest-all")));
}
