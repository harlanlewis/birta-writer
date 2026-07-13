/**
 * Sticky heading badge — real-browser truths (fixed-position mirroring,
 * computed opacity, live menu wiring):
 *   - scrolling past a heading shows the sticky mirror with its title,
 *   - the H-badge is a real <button> block handle (not a display-only span)
 *     and clicking it opens the block menu, marking the badge menu-open,
 *   - in "Hover only" mode (body.handles-rest-hover) the sticky gutter rests
 *     at opacity 0 and reveals while the sticky title is hovered — except
 *     when the stuck heading is collapsed (data-collapsed carve-out).
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(400);

    // ── 1. Scrolling past "Section One" reveals its sticky mirror ──
    check("sticky hidden at the top of the document",
        await page.$eval(".heading-sticky-title", (el) => el.hidden));
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(250);
    const sticky = await page.$eval(".heading-sticky-title", (el) => ({
        hidden: el.hidden,
        text: el.querySelector(".heading-sticky-text")?.textContent,
    }));
    check("scrolling past the heading shows the sticky with its title",
        !sticky.hidden && sticky.text === "Section One", JSON.stringify(sticky));

    // ── 2. The badge is a real button that opens the block menu ──
    const badge = await page.$eval(".heading-sticky-marker", (el) => ({
        tag: el.tagName,
        type: el.getAttribute("type"),
        label: el.textContent,
        haspopup: el.getAttribute("aria-haspopup"),
        expanded: el.getAttribute("aria-expanded"),
    }));
    check("sticky badge is a <button type=button> with menu semantics",
        badge.tag === "BUTTON" && badge.type === "button" &&
            badge.haspopup === "menu" && badge.expanded === "false",
        JSON.stringify(badge));
    check("badge carries the heading level (H1)", badge.label === "H1", `label=${badge.label}`);

    const markerBox = await page.$eval(".heading-sticky-marker", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(markerBox.x, markerBox.y);
    await page.waitForTimeout(150);
    const menuState = await page.evaluate(() => ({
        menu: !!document.querySelector(".block-menu"),
        menuOpenClass: document.querySelector(".heading-sticky-marker")
            ?.classList.contains("heading-fold-marker--menu-open") ?? false,
    }));
    check("clicking the badge opens the block menu", menuState.menu, JSON.stringify(menuState));
    check("open menu marks the badge (heading-fold-marker--menu-open)",
        menuState.menuOpenClass, JSON.stringify(menuState));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const closed = await page.evaluate(() => ({
        menu: !!document.querySelector(".block-menu"),
        menuOpenClass: document.querySelector(".heading-sticky-marker")
            ?.classList.contains("heading-fold-marker--menu-open") ?? false,
    }));
    check("Escape closes the menu and clears the badge's menu-open state",
        !closed.menu && !closed.menuOpenClass, JSON.stringify(closed));

    // ── 3. "Hover only" mode: gutter rests hidden, reveals on sticky hover ──
    // The toolbarMenu suite covers the real toggle path; here the body class
    // is applied directly, exactly what the toolbar pick does.
    await page.evaluate(() => document.body.classList.add("handles-rest-hover"));
    await page.mouse.move(500, 800); // pointer well away from the sticky
    await page.waitForTimeout(300); // opacity transition is 120ms
    const restOpacity = await page.$eval(".heading-sticky-gutter", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: sticky gutter rests at opacity 0", restOpacity === 0,
        `opacity=${restOpacity}`);
    const textBox = await page.$eval(".heading-sticky-text", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
    });
    await page.mouse.move(textBox.x, textBox.y);
    await page.waitForTimeout(300);
    const hoverOpacity = await page.$eval(".heading-sticky-gutter", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: hovering the sticky title reveals the gutter",
        hoverOpacity > 0.9, `opacity=${hoverOpacity}`);
    // The badge stays clickable through the reveal (the full loop).
    const markerBox2 = await page.$eval(".heading-sticky-marker", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(markerBox2.x, markerBox2.y);
    await page.waitForTimeout(150);
    await page.mouse.click(markerBox2.x, markerBox2.y);
    await page.waitForTimeout(150);
    check("hover-only mode: the revealed badge still opens the menu",
        (await page.$(".block-menu")) !== null);
    // While the menu is open the gutter must not fade, even unhovered.
    await page.mouse.move(500, 800);
    await page.waitForTimeout(300);
    const menuOpenOpacity = await page.$eval(".heading-sticky-gutter", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: gutter never fades while its menu is open",
        menuOpenOpacity > 0.9, `opacity=${menuOpenOpacity}`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.body.classList.remove("handles-rest-hover"));

    // ── 4. Scrolling into Section Two swaps the sticky's content ──
    // Scroll the heading 20px ABOVE the viewport top explicitly —
    // scrollIntoView can land it a hair below the sticky threshold (topbar
    // bottom minus the heading-padding offset), which is not the scenario
    // under test.
    await page.evaluate(() => {
        const h = [...document.querySelectorAll(".ProseMirror h1")]
            .find((el) => el.textContent.includes("Section Two"));
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY + 20);
    });
    await page.waitForTimeout(250);
    const swapped = await page.$eval(".heading-sticky-title", (el) => ({
        hidden: el.hidden,
        text: el.querySelector(".heading-sticky-text")?.textContent,
    }));
    check("scrolling into the next section swaps the sticky title",
        !swapped.hidden && swapped.text === "Section Two", JSON.stringify(swapped));

    // ── 5. Hover-only mode spares a COLLAPSED stuck heading's gutter ──
    // A collapsed section must keep its badge visible (the in-flow parity
    // rule). Holding a REAL collapsed heading stuck is not stable in this
    // two-section fixture — collapsing a section puts the next heading
    // immediately below it, so the sticky is pushed out almost instantly —
    // so stamp the dataset the plugin writes (updateSticky sets
    // data-collapsed from the fold state on every refresh) and assert the
    // CSS carve-out directly.
    // The class flip first: the plugin's body-class observer re-runs
    // updateSticky (which re-stamps data-collapsed from the fold state), so
    // stamping in the same breath would be overwritten a frame later.
    await page.evaluate(() => document.body.classList.add("handles-rest-hover"));
    await page.mouse.move(500, 800); // pointer well away from the sticky
    await page.waitForTimeout(200); // let the observer-driven refresh settle
    await page.evaluate(() => {
        document.querySelector(".heading-sticky-title").dataset.collapsed = "true";
    });
    await page.waitForTimeout(300);
    const collapsedRest = await page.$eval(".heading-sticky-gutter", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: a collapsed sticky's gutter stays visible at rest",
        collapsedRest === 1, `opacity=${collapsedRest}`);
    // Restore the expanded stamp: the hide rule applies again.
    await page.evaluate(() => {
        document.querySelector(".heading-sticky-title").dataset.collapsed = "false";
    });
    await page.waitForTimeout(300);
    const expandedRest = await page.$eval(".heading-sticky-gutter", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: the expanded sticky's gutter hides at rest again",
        expandedRest === 0, `opacity=${expandedRest}`);
    await page.evaluate(() => document.body.classList.remove("handles-rest-hover"));
}
