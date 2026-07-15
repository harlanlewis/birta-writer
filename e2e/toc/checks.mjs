/**
 * Table-of-contents end-to-end checks against the real bundle. The behavior
 * under test — CSS transitions — is invisible to the jsdom unit suite, so it
 * can only be verified by driving dist/webview.js in a real browser.
 *
 * Contract:
 *   - The initial auto-open reveal on load is INSTANT (no slide/fade), so the
 *     switch into the rendered editor doesn't draw attention to itself.
 *   - A user-invoked show/hide STILL animates.
 *
 * The panel is first opened by toc.refresh() *after* the editor mounts (the
 * init rAF runs before getEditorView() exists), which is exactly why an earlier
 * fix that suppressed only the init rAF failed — this suite is the regression
 * guard for that.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    // Let the load-time auto-open settle (init rAF + refresh + any transitions).
    await page.waitForTimeout(500);

    const state = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel");
        return {
            open: !!panel?.classList.contains("toc-panel--open"),
            docked: document.body.classList.contains("toc-docked"),
            initialTransitions: window.__tocTransitions.slice(),
            // The suppression class must not be left stuck on the body.
            initialClassStuck: document.body.classList.contains("toc-initial"),
        };
    });

    // Guard the guard: if the panel never opened (e.g. overlay), a zero-transition
    // result would be a false pass. Assert we actually exercised the reveal.
    check("panel auto-opened docked on load", state.open && state.docked,
        `open=${state.open} docked=${state.docked}`);
    check("initial reveal is instant (no panel transitions on load)",
        state.initialTransitions.length === 0,
        JSON.stringify(state.initialTransitions));
    check("toc-initial suppression class is not left on <body>", !state.initialClassStuck);
    check("panel transitions are re-enabled after load (0.2s)",
        await page.locator(".toc-panel").evaluate((el) =>
            getComputedStyle(el).transitionDuration.split(",")[0].trim() === "0.2s"));

    // ── A user-invoked hide must still animate ──
    await page.evaluate(() => { window.__phase = "toggle"; });
    await page.evaluate(() => {
        document.querySelector(".toc-hide-btn")
            ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await page.waitForTimeout(300);

    const toggleTransitions = await page.evaluate(() =>
        window.__tocTransitions.filter((t) => t.phase === "toggle"));
    check("user-invoked hide animates (panel transitions fire)",
        toggleTransitions.length > 0,
        JSON.stringify(toggleTransitions));
    check("panel is closed after the hide toggle",
        !(await page.locator(".toc-panel").evaluate((el) => el.classList.contains("toc-panel--open"))));

    // ── Flyout: hovering the collapsed reveal tab flies the panel out
    // transiently; leaving retracts it, and it never becomes a persistent open ──
    await page.waitForTimeout(300); // settle the collapse
    await page.locator(".toc-toggle-tab").hover();
    await page.waitForTimeout(350); // let the slide/fade-in (0.2s) settle
    const flyout = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel");
        const tab = document.querySelector(".toc-toggle-tab");
        const pr = panel.getBoundingClientRect();
        const tr = tab.getBoundingClientRect();
        return {
            flyout: panel.classList.contains("toc-panel--flyout"),
            bodyFlag: document.body.classList.contains("toc-flyout-open"),
            open: panel.classList.contains("toc-panel--open"),
            visible: getComputedStyle(panel).opacity === "1",
            belowTab: pr.top >= tr.bottom - 1, // panel starts at/under the tab's bottom
            sameSide: Math.abs(pr.left - tr.left) < 40, // roughly aligned to the tab
            tabMoved: Math.round(tr.left), // tab position captured for the "unmoved" check
            controlsHidden: getComputedStyle(panel.querySelector(".toc-controls")).display === "none",
            zIndex: parseInt(getComputedStyle(panel).zIndex, 10) || 0,
            capped: pr.height <= Math.min(0.7 * window.innerHeight, 620) + 1,
            gapTop: Math.round(tr.bottom), // for the hover-band probe below
            gapLeft: Math.round(pr.left + 40),
        };
    });
    check("hovering the tab flies the panel out", flyout.flyout && flyout.bodyFlag && flyout.visible,
        JSON.stringify(flyout));
    check("the flyout is transient, not a persistent open", !flyout.open);
    check("the flyout sits BELOW the tab, on its side (not the full-height drawer)",
        flyout.belowTab && flyout.sameSide, JSON.stringify(flyout));
    check("the flyout hides the docked drawer's controls", flyout.controlsHidden);
    check("the flyout is capped in height (the card scrolls, not the whole viewport)",
        flyout.capped, JSON.stringify(flyout));
    check("the flyout layers ABOVE the formatting/link palettes (z >= 9999)",
        flyout.zIndex >= 9999, `z=${flyout.zIndex}`);

    // Hover band: move into the gap between the tab and the flyout (below the
    // tab, above the panel, within the panel's width) — the flyout must stay.
    await page.mouse.move(flyout.gapLeft, flyout.gapTop + 3);
    await page.waitForTimeout(300); // longer than the grace period
    check("the hover band over the gap keeps the flyout open (no precision needed)",
        await page.evaluate(() =>
            document.querySelector(".toc-panel").classList.contains("toc-panel--flyout-in")));
    // ...but the band must NOT reach into the tab: the tab stays fully clickable
    // (its bottom edge hits the tab, not the panel's ::before band).
    check("the reveal tab stays fully clickable under the flyout (band doesn't steal it)",
        await page.evaluate(() => {
            const t = document.querySelector(".toc-toggle-tab").getBoundingClientRect();
            const el = document.elementFromPoint(t.left + t.width / 2, t.bottom - 2);
            return Boolean(el && el.closest(".toc-toggle-tab"));
        }));
    // The tab's own tooltip is suppressed while the flyout is out (it's redundant
    // and would overlap the panel) — no visible .custom-tooltip.
    const tipVisible = await page.evaluate(() => {
        const tip = document.querySelector(".custom-tooltip");
        return Boolean(tip && getComputedStyle(tip).display !== "none");
    });
    check("the tab tooltip is suppressed while the flyout is out", !tipVisible);

    // Move the pointer away → the flyout retracts after its grace period.
    await page.mouse.move(760, 420);
    await page.waitForTimeout(400);
    const retracted = await page.evaluate(() => ({
        flyout: document.querySelector(".toc-panel").classList.contains("toc-panel--flyout"),
        bodyFlag: document.body.classList.contains("toc-flyout-open"),
    }));
    check("leaving the tab/panel retracts the flyout",
        !retracted.flyout && !retracted.bodyFlag, JSON.stringify(retracted));

    // ── Keyboard: the tab is focusable (Tab order); focus flies it out, and
    // Enter docks it open persistently (a11y — not pointer-only) ──
    await page.evaluate(() => document.querySelector(".toc-toggle-tab").focus());
    await page.waitForTimeout(350);
    check("focusing the tab flies the panel out",
        await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--flyout")));
    check("the reveal tab is in the tab order (tabIndex 0)",
        await page.evaluate(() => document.querySelector(".toc-toggle-tab").tabIndex === 0));
    await page.evaluate(() => document.querySelector(".toc-toggle-tab")
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await page.waitForTimeout(300);
    check("Enter on the focused tab docks the panel open",
        await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--open")));
}
