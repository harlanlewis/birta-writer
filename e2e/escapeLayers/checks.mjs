/**
 * Escape layering (ui/escapeLayers.ts + blockKeys' Escape wiring) — the real
 * capture/bubble ordering between ProseMirror's keymap, the overlays' own
 * handlers, and the document-level fallbacks, which jsdom tests only
 * approximate:
 *   - find bar open + focus in the document: one Escape closes the bar and
 *     does NOT select the block; the next Escape block-selects (the
 *     user-reported inversion this suite guards),
 *   - a toolbar hover menu opened above the bar closes first — stack order,
 *   - with nothing open, Escape still runs the caret→block→caret grammar.
 *
 * A block-range selection is asserted via the .block-range-tint veil the
 * headingFold plugin view paints for it (no tint = no block selection).
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector('[data-item-id="listMenu"] .tb-fmt-btn', { timeout: 10000 });

    const barVisible = () =>
        page.$eval(".find-bar", (el) => el.classList.contains("find-bar--visible"));
    // The veil singleton stays in the DOM with display:none when hidden
    // (rangeIndicator.ts), so "block selected" means a VISIBLE tint.
    const tintVisible = () =>
        page.$$eval(".block-range-tint", (els) =>
            els.some((el) => el.style.display !== "none"));
    const settle = () =>
        page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Put the caret in a paragraph (the screenshot scenario starts here).
    const paragraph = await page.$(".ProseMirror p");
    await paragraph.click();
    await settle();

    // ── 1. Find bar vs. Escape (the reported bug) ──
    // Open the bar the way the extension host does (contributed command).
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "openFind" }, "*"));
    await page.waitForSelector(".find-bar--visible", { timeout: 5000 });
    check("find bar opens via the contributed command", await barVisible());

    // Focus returns to the document; the bar stays open (VS Code behavior).
    await paragraph.click();
    await settle();
    check("bar stays open when focus returns to the document", await barVisible());

    await page.keyboard.press("Escape");
    await settle();
    check("first Escape closes the bar", !(await barVisible()));
    check("first Escape does not select the block", !(await tintVisible()));

    await page.keyboard.press("Escape");
    await settle();
    check("second Escape block-selects the caret's block", await tintVisible());

    await page.keyboard.press("Escape");
    await settle();
    check("third Escape collapses back to a caret", !(await tintVisible()));

    // ── 2. Stack order: hover menu above the find bar ──
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "openFind" }, "*"));
    await page.waitForSelector(".find-bar--visible", { timeout: 5000 });
    await paragraph.click(); // focus back in the document
    await settle();

    const listMenu = '[data-item-id="listMenu"] .tb-list-menu';
    const menuDisplay = () => page.$eval(listMenu, (el) => getComputedStyle(el).display);
    // Guard: the dropdown must be on the bar, or the hover can't happen.
    const overflowed = await page.$eval(
        '[data-item-id="listMenu"] .tb-fmt-wrap',
        (el) => !!el.closest(".tb-more-menu"),
    );
    check("Lists dropdown renders on the bar (not overflowed)", !overflowed);

    await page.hover('[data-item-id="listMenu"] .tb-fmt-btn');
    // Wait on the menu's actual visibility, not a hardcoded delay: toolbar
    // menus open on a hover-INTENT delay (openDelayMs, 140ms default —
    // components/toolbar/hoverMenu.ts), and the original 30ms wait predated
    // that fix (13a9d6e) and sampled the menu before it could open, running
    // the whole Escape stack off-by-one (MAR-147).
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel);
            return el && getComputedStyle(el).display === "flex";
        },
        listMenu,
        { timeout: 2000 },
    ).catch(() => {});
    check("hover menu opens above the open find bar", (await menuDisplay()) === "flex");

    await page.keyboard.press("Escape");
    await settle();
    check("Escape closes the hover menu first", (await menuDisplay()) === "none");
    check("…and the find bar (below it) stays open", await barVisible());
    check("…and no block got selected", !(await tintVisible()));

    // Move the pointer off the toolbar so mouseenter can't reopen the menu,
    // then finish the stack: bar next, block selection last.
    await page.mouse.move(500, 600, { steps: 3 });
    await page.keyboard.press("Escape");
    await settle();
    check("next Escape closes the find bar", !(await barVisible()));
    check("…still without selecting the block", !(await tintVisible()));

    await page.keyboard.press("Escape");
    await settle();
    check("final Escape reaches the block grammar", await tintVisible());

    // ── 3. Keyboard item pick must not leak the menu's Escape layer ──
    // The regression: item handlers dismissed the dropdown with a direct
    // style hide instead of the shared close, leaving the layer entry
    // registered — the NEXT editor-focused Escape was silently swallowed.
    await page.keyboard.press("Escape"); // collapse the tint back to a caret
    await settle();
    check("caret restored before the pick scenario", !(await tintVisible()));

    const listBtnSel = '[data-item-id="listMenu"] .tb-fmt-btn';
    await page.evaluate((sel) => document.querySelector(sel).focus(), listBtnSel);
    await page.keyboard.press("Enter"); // opens the menu, focuses the first row
    await settle();
    check("Lists menu opens via keyboard", (await menuDisplay()) === "flex");
    check(
        "first row holds focus",
        await page.evaluate(() => document.activeElement?.classList.contains("tb-list-item") ?? false),
    );

    await page.keyboard.press("Enter"); // pick: must route through the shared close
    await settle();
    check("menu closes after the keyboard pick", (await menuDisplay()) === "none");
    check(
        "trigger aria-expanded resets after the pick",
        (await page.$eval(listBtnSel, (el) => el.getAttribute("aria-expanded"))) === "false",
    );

    // Focus back in the document: the very next Escape must reach the block
    // grammar — a leaked layer entry would swallow it (the reproduced bug).
    await page.evaluate(() => document.querySelector(".ProseMirror").focus());
    await settle();
    await page.keyboard.press("Escape");
    await settle();
    check("first Escape after the pick block-selects (no dead Escape)", await tintVisible());
}
