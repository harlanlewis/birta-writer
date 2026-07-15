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

    // Menus open on a hover-intent delay (~140ms) now, so wait past it before
    // asserting a hover opened one; closes are still instant.
    const OPEN_WAIT = 220;

    // The toolbar (and its downward menus) layer above the content-area chrome
    // — above the ToC flyout (z 10000) so a menu is never occluded by it.
    check("the toolbar layers above the content-area chrome (z > flyout)",
        await page.evaluate(() =>
            parseInt(getComputedStyle(document.querySelector(".editor-topbar")).zIndex, 10) > 10000));

    // ── 1. Hover-intent delay: not instant, opens after the delay ──
    await page.hover(listBtn);
    await page.waitForTimeout(45); // well under the intent delay
    check("a hover does NOT open the menu instantly (intent delay guards flicker)",
        (await disp(listMenu)) === "none");
    await page.waitForTimeout(OPEN_WAIT);
    check("hovering Lists opens its menu after the intent delay", (await disp(listMenu)) === "flex");

    await page.hover(quoteBtn);
    await page.waitForTimeout(OPEN_WAIT); // Lists closes at once; Quote opens after the intent delay
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
    await page.waitForTimeout(OPEN_WAIT);
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

    // ── 5. Typography menu: the block-handles radio rows ──
    // A captioned Always show/Headings and hover/Hover only radio trio under
    // the width segments; picks apply the handles-rest-* body class
    // immediately (menu stays open) and post setBlockHandles for the
    // settings round-trip.
    const fontBtn = '[data-item-id="fontPreset"] .tb-fmt-btn';
    const fontMenu = '[data-item-id="fontPreset"] .tb-font-menu';
    const handleRowLabels = ["Always show", "Headings and hover", "Hover only"];
    const fontOverflowed = await page.$eval(fontBtn, (el) => !!el.closest(".tb-more-menu"));
    check("font menu renders on the bar (not overflowed)", !fontOverflowed);
    await page.hover(fontBtn);
    await page.waitForTimeout(OPEN_WAIT);
    check("hovering the A button opens the typography menu", (await disp(fontMenu)) === "flex");
    const caption = await page.$eval(`${fontMenu} .tb-seg-caption`, (el) => el.textContent).catch(() => null);
    check("the handle rows carry their caption", caption === "Show Block Handles", `caption=${caption}`);
    const rowState = () =>
        page.$$eval(`${fontMenu} [role="menuitemradio"]`, (els, labels) =>
            els.filter((el) => labels.includes(el.querySelector(".tb-check-label")?.textContent))
                .map((el) => ({
                    label: el.querySelector(".tb-check-label")?.textContent,
                    on: el.getAttribute("aria-checked") === "true",
                })), handleRowLabels);
    const atRest = await rowState();
    check("three radio rows in display order with Headings and hover (default) active",
        JSON.stringify(atRest) === JSON.stringify([
            { label: "Always show", on: false },
            { label: "Headings and hover", on: true },
            { label: "Hover only", on: false },
        ]), JSON.stringify(atRest));
    // Pick Hover only: body class flips, the row checks, the menu stays open.
    const rowBox = (label) =>
        page.$$eval(`${fontMenu} [role="menuitemradio"]`, (els, wanted) => {
            const el = els.find((e) => e.querySelector(".tb-check-label")?.textContent === wanted);
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, label);
    const hoverBox = await rowBox("Hover only");
    await page.mouse.move(hoverBox.x, hoverBox.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(30);
    check("picking Hover only applies the handles-rest-hover body class",
        await page.evaluate(() => document.body.classList.contains("handles-rest-hover")));
    check("picking Hover only checks its row", (await rowState())[2].on === true);
    check("the menu stays open after a handle-row pick", (await disp(fontMenu)) === "flex");
    const postedHandles = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "setBlockHandles").map((m) => m.mode));
    check("the pick posts setBlockHandles for the settings round-trip",
        JSON.stringify(postedHandles) === JSON.stringify(["hover"]), JSON.stringify(postedHandles));
    // Always show is the third state: its own body class, replacing hover's.
    const alwaysBox = await rowBox("Always show");
    await page.mouse.move(alwaysBox.x, alwaysBox.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(30);
    check("picking Always show swaps in the handles-rest-always body class",
        await page.evaluate(() => document.body.classList.contains("handles-rest-always")
            && !document.body.classList.contains("handles-rest-hover")));
    // Restore the default for any checks that follow.
    const headingsBox = await rowBox("Headings and hover");
    await page.mouse.move(headingsBox.x, headingsBox.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(30);
    check("picking Headings and hover clears the override body class",
        await page.evaluate(() => !document.body.classList.contains("handles-rest-hover")
            && !document.body.classList.contains("handles-rest-always")));
    // Leave the menu before the gear checks below.
    await page.mouse.move(500, 800, { steps: 5 });
    await page.waitForTimeout(30);

    // ── 6. Settings gear menu: five rows, two group separators, no header ──
    // The menu mirrors TOOLBAR_MENU_COMMANDS (layout | shortcuts | settings
    // groups); the old .tb-fmt-header title row is gone.
    const gearBtn = '[data-item-id="settings"] .tb-fmt-btn';
    const gearMenu = '[data-item-id="settings"] .tb-settings-menu';
    await page.hover(gearBtn);
    await page.waitForTimeout(OPEN_WAIT);
    check("hovering the gear opens the settings menu", (await disp(gearMenu)) === "flex");
    const gearShape = await page.$eval(gearMenu, (menu) => ({
        header: !!menu.querySelector(".tb-fmt-header"),
        // Child sequence: row/sep kinds in DOM order.
        kinds: [...menu.children].map((el) =>
            el.classList.contains("tb-menu-sep") ? "sep"
                : el.classList.contains("tb-fmt-item") ? "item" : el.className),
        labels: [...menu.querySelectorAll(".tb-fmt-item")].map((el) => el.textContent),
        sepRoles: [...menu.querySelectorAll(".tb-menu-sep")]
            .map((el) => el.getAttribute("role")),
    }));
    check("gear menu has no .tb-fmt-header title row", !gearShape.header);
    check("gear menu rows: Customize / Hide / Show Shortcuts / Edit Shortcuts / Settings",
        JSON.stringify(gearShape.labels) === JSON.stringify([
            "Customize Toolbar",
            "Hide Toolbar",
            "Show Keyboard Shortcuts",
            "Edit Keyboard Shortcuts",
            "Birta Writer Settings",
        ]), JSON.stringify(gearShape.labels));
    check("gear menu groups split by two separators (item,item,sep,item,item,sep,item)",
        JSON.stringify(gearShape.kinds) ===
            JSON.stringify(["item", "item", "sep", "item", "item", "sep", "item"]),
        JSON.stringify(gearShape.kinds));
    check("gear menu separators carry role=separator",
        JSON.stringify(gearShape.sepRoles) === JSON.stringify(["separator", "separator"]),
        JSON.stringify(gearShape.sepRoles));
}
