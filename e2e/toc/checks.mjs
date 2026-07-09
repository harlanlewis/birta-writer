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
}
