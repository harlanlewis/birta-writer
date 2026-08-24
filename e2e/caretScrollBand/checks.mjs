/**
 * The caret auto-scroll band (webview/plugins/caretScrollMargin.ts): a
 * keyboard-driven caret never settles underneath the fixed topbar and the
 * sticky heading title.
 *
 * jsdom cannot answer any of this. `webview/__tests__/caretScrollMargin.test.ts`
 * asserts the arithmetic of the band, which is a number; whether that number
 * reaches the viewport is layout, and layout is only here.
 *
 * THE INSTRUMENT (MAR-388), which is not optional here. The check this suite
 * replaces passed identically on a clean build and on one with the top inset
 * deleted whole, because it drove the caret to the top of the document, where
 * `scrollY` is 0 and the inset cannot participate. So a check added here is
 * verified by editing `computeInsets()`, rebuilding, and watching it go red,
 * never by watching it go green. Three edits were replayed against what is
 * below, each turning red only the group that names it: `top = 0`, the same
 * with only the `measureStickyHeadingHeight()` term dropped, and `bottom = 5`,
 * which is ProseMirror's own default and so the bottom band's deletion.
 *
 * The gestures are a user's throughout, and the engines agree:
 * `BIRTA_E2E_BROWSER=webkit node e2e/run.mjs caretScrollBand` drives the same
 * ones through the engine Birta Writer for Mac renders in.
 *
 * Two things about where the caret settles, both of which cost a wrong answer
 * first.
 *
 * The band is an edge offset, not a centre. When the caret is already inside
 * the band the viewport does not move at all, so a check that drives the caret
 * toward the band from a long way off and then asserts clearance is vacuous:
 * the caret stops wherever the last un-corrected step left it, up to a whole
 * line clear of the edge whatever the inset says. What discriminates is the
 * CONVERGENCE below: two lines occluded to different depths settle at the same
 * height, because both are lifted to the edge. With `top = 0` neither is
 * lifted at all and both stay where they were put.
 *
 * The caret is measured from the collapsed selection's own rect, not from the
 * block containing it. A paragraph's box carries the vertical rhythm's margins,
 * so its top sits above the text line's and the clearance would read as better
 * than it is.
 */

/** Two settle heights this close count as the same height. */
const CONVERGENCE_PX = 2;
/** Steps in the keyboard walk. Enough to cross two section headings. */
const WALK_STEPS = 22;

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => document.querySelectorAll(".ProseMirror > p").length > 100,
        { timeout: 10000 },
    );
    await page.waitForTimeout(400);

    /** The caret's own rect against the header stack, plus the published band. */
    const reading = () => page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel.anchorNode;
        if (!node) { return null; }
        const block = (node.nodeType === 1 ? node : node.parentElement).closest(".ProseMirror > *");
        // Named here rather than left to throw on a null further down: every
        // gesture below assumes the caret is in the document, and the reason it
        // is not belongs in the failure rather than a property access.
        if (!block) { throw new Error("the caret is not inside a top-level block"); }
        const caret = sel.getRangeAt(0).getBoundingClientRect();
        // A collapsed range reports a zero-height rect in some engines; the
        // block is the honest fallback, and `measured` says which was used so a
        // silent switch cannot be mistaken for a change in the band.
        const usable = caret.height > 1;
        const rect = usable ? caret : block.getBoundingClientRect();
        const sticky = document.querySelector(".heading-sticky-title");
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        const cs = getComputedStyle(document.documentElement);
        return {
            measured: usable ? "caret" : "block",
            text: block.textContent.slice(0, 18),
            tag: block.tagName,
            caretTop: Math.round(rect.top * 10) / 10,
            caretBottom: Math.round(rect.bottom * 10) / 10,
            // What the header stack actually covers right now: the topbar
            // alone when no section title is showing, the title's bottom edge
            // when one is.
            stackBottom: sticky && !sticky.hidden
                ? Math.round(sticky.getBoundingClientRect().bottom)
                : Math.round(bar.bottom),
            barBottom: Math.round(bar.bottom),
            stickyShowing: !!(sticky && !sticky.hidden),
            padTop: cs.scrollPaddingTop,
            padBottom: cs.scrollPaddingBottom,
            viewport: window.innerHeight,
            scrollY: Math.round(window.scrollY),
        };
    });

    /**
     * A reading taken once the scroll has stopped moving. A fixed delay races
     * it: the caret's DOM position updates before the viewport finishes
     * following, and a read landing in between reports a caret a whole line out,
     * which on the very step where a correction is due is the difference
     * between the pre-scroll position and the settled one.
     *
     * The caret's own height is watched alongside the scroll, because a scroll
     * of zero is indistinguishable from a scroll that has not begun.
     */
    const settled = async () => {
        let previous = null;
        let stable = 0;
        for (let i = 0; i < 25; i++) {
            const r = await reading();
            const key = r && `${r.scrollY}:${r.caretTop}`;
            if (key !== null && key === previous) {
                stable += 1;
                if (stable >= 2) { return r; }
            } else {
                stable = 0;
            }
            previous = key;
            await page.waitForTimeout(50);
        }
        return reading();
    };

    /**
     * Click a line near the middle of the viewport, so the caret is a user's
     * rather than a range the harness set.
     *
     * The point is chosen by hit-testing across the line rather than from its
     * left edge: the docked table of contents overlays the leading part of
     * every block, so a click there lands in the panel and the caret never
     * enters the document at all.
     */
    const clickMidViewport = async () => {
        const spot = await page.evaluate(() => {
            const hit = [...document.querySelectorAll(".milkdown .ProseMirror > p")]
                .find((b) => {
                    const r = b.getBoundingClientRect();
                    return r.top > window.innerHeight * 0.4 && r.bottom < window.innerHeight * 0.7;
                });
            if (!hit) { return null; }
            const r = hit.getBoundingClientRect();
            const y = Math.round(r.top + r.height / 2);
            for (let x = Math.round(r.left + 8); x < r.right; x += 12) {
                if (hit.contains(document.elementFromPoint(x, y))) { return { x, y }; }
            }
            return null;
        });
        if (!spot) { throw new Error("no clickable point on a mid-viewport line"); }
        await page.mouse.click(spot.x, spot.y);
        await page.waitForTimeout(200);
        const landed = await page.evaluate(() => {
            const node = window.getSelection()?.anchorNode;
            return !!node && !!(node.nodeType === 1 ? node : node.parentElement)?.closest(".ProseMirror > *");
        });
        if (!landed) { throw new Error("the click did not put the caret in the document"); }
    };

    /** Wheel the document until the caret's line sits at `target` px. */
    const wheelCaretTo = async (target) => {
        for (let i = 0; i < 6; i++) {
            const r = await settled();
            const delta = Math.round(r.caretTop - target);
            if (Math.abs(delta) <= 1) { break; }
            await page.mouse.wheel(0, delta);
            await page.waitForTimeout(120);
        }
        return settled();
    };

    // Start well inside a long document, so every scroll below has room to go
    // in both directions and nothing is clamped at an end.
    await page.evaluate(() => window.scrollTo({ top: 2000 }));
    await page.waitForTimeout(300);

    // ── 1. A line the header stack covers, typed on ──────────
    // The gesture: put the caret on a line, wheel the document until that line
    // is under the topbar and the section title, then type. Two depths, run the
    // same way, so the settle heights can be compared.
    const occluded = async (depth) => {
        await page.evaluate(() => window.scrollTo({ top: 2000 }));
        await page.waitForTimeout(200);
        await clickMidViewport();
        const before = await wheelCaretTo(depth);
        await page.keyboard.type("x");
        await page.waitForTimeout(250);
        return { before, after: await settled() };
    };

    const shallow = await occluded(70);
    const deep = await occluded(30);

    check(
        "the caret's own rect was measurable",
        [shallow, deep].every((r) => r.before.measured === "caret" && r.after.measured === "caret"),
        JSON.stringify([shallow.before.measured, shallow.after.measured, deep.before.measured, deep.after.measured]),
    );
    // Without this the suite could measure a caret that was never occluded and
    // report the same success as a working band.
    check(
        "the wheel really did leave both lines under the header stack",
        shallow.before.caretTop < shallow.before.stackBottom
            && deep.before.caretTop < deep.before.stackBottom,
        `shallow ${shallow.before.caretTop} / deep ${deep.before.caretTop} under ${shallow.before.stackBottom}`,
    );
    // The stack has to be more than the topbar, or "clears the stack" is only
    // ever a claim about the topbar and the sticky title's share goes unchecked.
    check(
        "the section title is showing, so the stack is taller than the topbar",
        shallow.before.stickyShowing && shallow.before.stackBottom > shallow.before.barBottom,
        `stack ${shallow.before.stackBottom} vs bar ${shallow.before.barBottom}`,
    );

    // Against the taller of the two stacks, not the one standing afterwards.
    // The sticky title's height tracks the active heading, so a scroll that
    // segues to a shallower section shrinks the stack under the answer and
    // hands the check slack it did not earn.
    const clears = (r) => r.after.caretTop >= Math.max(r.before.stackBottom, r.after.stackBottom);
    check(
        "typing on an occluded line lifts it clear of the whole header stack",
        clears(shallow) && clears(deep),
        `shallow ${shallow.after.caretTop} >= ${Math.max(shallow.before.stackBottom, shallow.after.stackBottom)}, `
        + `deep ${deep.after.caretTop} >= ${Math.max(deep.before.stackBottom, deep.after.stackBottom)} `
        + `(band ${shallow.after.padTop})`,
    );
    // The edge-offset signature, and the one assertion that does not depend on
    // knowing the inset's value: two different occlusion depths are lifted to
    // the SAME height, because both are lifted to the band's edge.
    check(
        "both depths settle at the same height, which is the band's edge",
        Math.abs(shallow.after.caretTop - deep.after.caretTop) <= CONVERGENCE_PX,
        `${shallow.before.caretTop} -> ${shallow.after.caretTop}, `
        + `${deep.before.caretTop} -> ${deep.after.caretTop} (band ${shallow.after.padTop})`,
    );

    // ── 2. The control: a line already clear must not move ───
    // An always-centre or always-reveal implementation would pass every check
    // above. This is what says the band is a threshold.
    await page.evaluate(() => window.scrollTo({ top: 2000 }));
    await page.waitForTimeout(200);
    await clickMidViewport();
    const clearBefore = await settled();
    await page.keyboard.type("x");
    await page.waitForTimeout(250);
    const clearAfter = await settled();
    check(
        "typing on a line already clear of the band leaves the viewport alone",
        clearAfter.scrollY === clearBefore.scrollY,
        `${clearBefore.scrollY} -> ${clearAfter.scrollY} at caret ${clearBefore.caretTop}`,
    );

    // ── 3. Keyboard navigation, the browser's own scroll path ─
    // Arrow keys move the caret natively and the browser reveals it against
    // `scroll-padding-top`, which the plugin publishes from the same
    // computeInsets(). This is the other half of the seam: the checks above go
    // through ProseMirror's scrollThreshold/scrollMargin props, and both halves
    // read one function. A walk is what a reader does, and it is the path the
    // removed check claimed to cover.
    await page.evaluate(() => window.scrollTo({ top: 2600 }));
    await page.waitForTimeout(250);
    await clickMidViewport();
    const walk = [];
    for (let i = 0; i < WALK_STEPS; i++) {
        await page.keyboard.press("ArrowUp");
        await page.waitForTimeout(80);
        walk.push(await settled());
    }
    check("the walk produced a reading per step", walk.length === WALK_STEPS, `${walk.length} steps`);
    // Instrument: a walk that never scrolled never asked the band anything.
    check(
        "the walk actually scrolled the document",
        walk[walk.length - 1].scrollY < walk[0].scrollY,
        `${walk[0].scrollY} -> ${walk[walk.length - 1].scrollY}`,
    );
    const buried = walk
        .map((r, i) => ({ ...r, step: i }))
        .filter((r) => r.caretTop < r.stackBottom);
    check(
        "no step of the walk parks the caret under the header stack",
        buried.length === 0,
        buried.length
            ? buried.map((r) => `#${r.step} ${r.tag} "${r.text.trim()}" top=${r.caretTop} < stack=${r.stackBottom}`).join(" | ")
            : `lowest ${Math.min(...walk.map((r) => r.caretTop))} against stack ${walk[0].stackBottom}`,
    );

    // ── 4. The bottom band ───────────────────────────────────
    // The same mechanism on the other side: context kept below the caret while
    // typing. Its deletion mutation is `bottom = 5`, ProseMirror's own default,
    // and the convergence check below is what catches it.
    const FOOT_DEPTHS = [850, 884];
    const nearBottom = async (target) => {
        await page.evaluate(() => window.scrollTo({ top: 2000 }));
        await page.waitForTimeout(200);
        await clickMidViewport();
        const before = await wheelCaretTo(target);
        await page.keyboard.type("x");
        await page.waitForTimeout(250);
        return { before, after: await settled() };
    };
    const low = await nearBottom(FOOT_DEPTHS[0]);
    const lower = await nearBottom(FOOT_DEPTHS[1]);
    // Stated against where the wheel was ASKED to leave the caret, not against
    // the band. A setup check written against the band reports "the case was
    // never reached" when the band is the thing under mutation, which reads as
    // an instrument fault rather than as the finding.
    check(
        "the wheel put both lines at the foot of the pane, at two depths",
        Math.abs(low.before.caretTop - FOOT_DEPTHS[0]) <= 3
            && Math.abs(lower.before.caretTop - FOOT_DEPTHS[1]) <= 3,
        `${low.before.caretTop} / ${lower.before.caretTop} against ${FOOT_DEPTHS.join(" / ")} `
        + `in a ${low.before.viewport}px pane`,
    );
    // What the published number reaching the viewport looks like. It passes
    // under `bottom = 5` on purpose: that mutation moves the number and the
    // behavior together, so the mechanism is intact and only the constant
    // changed. It fails when the props or the CSS var stop being wired at all.
    check(
        "typing near the foot of the pane keeps context below the caret",
        low.after.caretBottom <= low.after.viewport - parseFloat(low.after.padBottom)
            && lower.after.caretBottom <= lower.after.viewport - parseFloat(lower.after.padBottom),
        `${low.after.caretBottom} / ${lower.after.caretBottom} against `
        + `${low.after.viewport - parseFloat(low.after.padBottom)} (band ${low.after.padBottom})`,
    );
    check(
        "both depths settle at the same height at the foot too",
        Math.abs(low.after.caretBottom - lower.after.caretBottom) <= CONVERGENCE_PX,
        `${low.before.caretBottom} -> ${low.after.caretBottom}, `
        + `${lower.before.caretBottom} -> ${lower.after.caretBottom}`,
    );
}
