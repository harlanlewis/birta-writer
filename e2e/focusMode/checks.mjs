/**
 * Focus mode (MAR-72) against the real production bundle.
 *
 * The jsdom suite proves the module replays its snapshot. It cannot prove the
 * module is WIRED — that the command reaches it, that the surfaces it was
 * handed are the real toolbar, TOC and proofread plugin, and that the chrome
 * actually leaves the page. Those are this suite's job, and every check drives
 * the command the palette drives.
 *
 * Two claims carry the feature:
 *
 *   1. Focus is reversible with nothing left behind. Measured as a round trip
 *      from an arbitrary starting state, comparing what is on the page before
 *      and after, not against a state the check expects.
 *   2. Focus is not a settings change. `window.__posted` is the oracle: the
 *      toolbar's own hide path posts `setToolbarVisible` and the Checks menu
 *      posts `setProofreadOption`, so if focus went through either of them the
 *      user's persisted preferences would move. Counting those messages is what
 *      makes "session-only" checkable rather than asserted in a comment.
 */

/**
 * Everything the mode collapses, read off the page as a user would see it.
 *
 * Both surfaces hide by SLIDING out and flipping `visibility`, not by
 * collapsing their box: the toolbar translates up inside a topbar that keeps
 * its height, and the TOC panel translates sideways at full width. So a check
 * on width or height alone reads "still shown" for a surface that is off the
 * screen, which is how the first cut of this suite reported two failures
 * against a working feature. On screen and visible is the question.
 */
function chromeState(page) {
    return page.evaluate(() => {
        const onScreen = (el) => {
            if (!el) { return false; }
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") { return false; }
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0
                && b.right > 0 && b.bottom > 0
                && b.left < window.innerWidth && b.top < window.innerHeight;
        };
        return {
            toolbarShown: onScreen(document.querySelector(".toolbar")),
            tocShown: onScreen(document.querySelector(".toc-panel")),
            styleHits: document.querySelectorAll(".pf-style-hit").length,
            bodyFocus: document.body.classList.contains("focus-mode"),
        };
    });
}

/** Count posted messages by type. */
function postedCount(page, type) {
    return page.evaluate((t) => window.__posted.filter((m) => m.type === t).length, type);
}

/** Drive the same command the command palette drives, and let it settle. */
async function toggleFocus(page) {
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "toggleFocusMode" }, "*"),
    );
    // Both surfaces slide out over 0.2s and flip `visibility` only when the
    // slide ends, so a shorter wait would read the mid-transition state.
    await page.waitForTimeout(500);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // Proofreading settles after first paint by design, so the decorations are
    // not on the page at mount. Wait for them rather than for a fixed delay:
    // a zero read here would make every "went quiet" check below pass without
    // discriminating.
    await page.waitForFunction(
        () => document.querySelectorAll(".pf-style-hit").length > 0,
        { timeout: 10000 },
    ).catch(() => {});

    const before = await chromeState(page);
    check("the sample document trips the style check before focus",
        before.styleHits > 0, `${before.styleHits} .pf-style-hit`);
    check("the toolbar is on the page before focus", before.toolbarShown, JSON.stringify(before));
    check("focus mode is off at mount", before.bodyFocus === false, JSON.stringify(before));

    // Open the TOC so the round trip has a non-default surface to restore, and
    // so "focus hides the TOC" is measured against a TOC that was open.
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "toggleToc" }, "*"),
    );
    await page.waitForTimeout(500);
    const opened = await chromeState(page);
    check("the table of contents is open before focus", opened.tocShown, JSON.stringify(opened));

    // ── enter ────────────────────────────────────────────────────────────
    const tocWritesBaseline = await postedCount(page, "tocVisibility");
    await toggleFocus(page);
    const inFocus = await chromeState(page);

    check("focus hides the toolbar", inFocus.toolbarShown === false, JSON.stringify(inFocus));
    check("focus hides the table of contents", inFocus.tocShown === false, JSON.stringify(inFocus));
    check("focus silences proofreading", inFocus.styleHits === 0, `${inFocus.styleHits} .pf-style-hit`);
    check("focus marks the body, so CSS can reach chrome with no subscriber",
        inFocus.bodyFocus === true, JSON.stringify(inFocus));

    // The workbench is deliberately not focus mode's to touch. Zen Mode is
    // VS Code's own toggle with its own restore, and driving it from here is
    // how the two got out of step.
    const zenPosts = await postedCount(page, "toggleWorkbenchZen");
    check("focus does not touch the workbench chrome", zenPosts === 0, `${zenPosts} toggleWorkbenchZen`);

    // A settings echo arriving mid-focus must not undo the mode. The extension
    // broadcasts the whole toolbar config on ANY birta.toolbar.* write, with
    // `visible` riding along, so an unmasked echo would re-show the toolbar
    // the moment a layout was edited.
    await page.evaluate(() =>
        window.postMessage({ type: "toolbarConfig", config: { visible: true } }, "*"),
    );
    await page.waitForTimeout(500);
    const afterEcho = await chromeState(page);
    check("a toolbar settings echo during focus leaves the toolbar hidden",
        afterEcho.toolbarShown === false, JSON.stringify(afterEcho));

    // The claim that makes this a mode and not a settings edit. Both counts are
    // read at this point rather than at mount, because the TOC open above is a
    // legitimate reason for other traffic.
    // Each surface has a persisting toggle and a session-only apply beneath
    // it, and focus must use the second of each. `tocVisibility` is counted
    // from the baseline taken before the deliberate TOC open above, which is a
    // legitimate write; anything beyond it came from focus.
    const toolbarWrites = await postedCount(page, "setToolbarVisible");
    const proofreadWrites = await postedCount(page, "setProofreadOption");
    const tocWrites = await postedCount(page, "tocVisibility");
    check("focus persists nothing: no toolbar visibility written",
        toolbarWrites === 0, `${toolbarWrites} setToolbarVisible`);
    check("focus persists nothing: no proofread option written",
        proofreadWrites === 0, `${proofreadWrites} setProofreadOption`);
    check("focus persists nothing: no TOC visibility written beyond the deliberate open",
        tocWrites === tocWritesBaseline, `${tocWritesBaseline} -> ${tocWrites}`);

    // ── exit ─────────────────────────────────────────────────────────────
    await toggleFocus(page);
    const after = await chromeState(page);

    check("a round trip restores the toolbar to what it was",
        after.toolbarShown === opened.toolbarShown, `${opened.toolbarShown} -> ${after.toolbarShown}`);
    check("a round trip restores the table of contents to what it was",
        after.tocShown === opened.tocShown, `${opened.tocShown} -> ${after.tocShown}`);
    check("a round trip brings proofreading back",
        after.styleHits > 0, `${after.styleHits} .pf-style-hit`);
    check("a round trip clears the body marker", after.bodyFocus === false, JSON.stringify(after));

    // ── the round trip left no persisted trace ───────────────────────────
    const toolbarWritesEnd = await postedCount(page, "setToolbarVisible");
    const proofreadWritesEnd = await postedCount(page, "setProofreadOption");
    const tocWritesEnd = await postedCount(page, "tocVisibility");
    check("a whole round trip writes no preference at all",
        toolbarWritesEnd === 0 && proofreadWritesEnd === 0 && tocWritesEnd === tocWritesBaseline,
        `toolbar=${toolbarWritesEnd} proofread=${proofreadWritesEnd} toc=${tocWritesBaseline}->${tocWritesEnd}`);
}
