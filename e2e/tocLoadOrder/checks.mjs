/**
 * The load reveal must be instant in EITHER order (the flake behind `toc`'s
 * intermittent "initial reveal is instant" failure).
 *
 * Two commits make up the reveal — the TOC's own init rAF, and the first
 * refresh after the editor mounts — and which one opens the panel depends on
 * whether the editor finishes mounting inside a frame. The `toc` suite happens
 * to exercise the order where the init rAF wins. This page forces the other
 * one by delaying every rAF callback, which is the order that used to animate.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    await page.waitForTimeout(800); // the delayed rAF chain plus any transition

    const state = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel");
        return {
            open: !!panel?.classList.contains("toc-panel--open"),
            docked: document.body.classList.contains("toc-docked"),
            transitions: window.__tocTransitions.slice(),
            classStuck: document.body.classList.contains("toc-initial"),
        };
    });

    // Guard the guard: a panel that never opened would pass the transition
    // assertion for the wrong reason.
    check("panel auto-opened docked, with the mount winning the race",
        state.open && state.docked, `open=${state.open} docked=${state.docked}`);
    check("reveal is still instant when the init rAF commits it",
        state.transitions.length === 0, JSON.stringify(state.transitions));
    check("the no-transition class is not left stuck on the body", !state.classStuck);
}
