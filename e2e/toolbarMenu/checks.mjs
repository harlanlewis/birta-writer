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
}
