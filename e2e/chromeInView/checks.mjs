/**
 * Keep-it-visible: a block's own chrome stays reachable while the block scrolls.
 *
 * A popup can flip to the other side of its anchor when it does not fit
 * (ui/anchoredPlacement.ts's `computeAnchoredPosition`, unit-tested over plain
 * numbers). A block's OWN controls cannot: their anchor is the block, and their
 * resting place is its top edge — a table's column grips, the shared control
 * column at a block's top-right. A block taller than the viewport scrolls that
 * edge away while the block is still the whole of what the reader is looking at,
 * and the controls leave with it. You cannot select a column you cannot see.
 *
 * Three mechanisms implement the one rule, and all are invisible to jsdom,
 * where every rect is 0x0:
 *   - the table overlay measures and clamps (`pinIntoView` in reposition())
 *   - the control column is a sticky stack inside its strip (blockControls.css)
 *   - a code block's language pill is a sticky row inside a rail (codeBlock.css)
 *
 * Two halves are easy to get wrong and are checked for each. Chrome for a block
 * that has itself scrolled off must go off screen WITH it, never sit at the
 * viewport edge pointing at nothing. And "on screen" means reachable: the pill
 * sits inside the content column, where the sticky heading title paints, so
 * clearing only the topbar would leave it visible and unclickable.
 */

/** The band a block's chrome may occupy: below the fixed topbar, above the fold. */
const BAND = `(() => {
    const bar = document.querySelector(".editor-topbar");
    return { top: bar ? bar.getBoundingClientRect().height : 40, bottom: window.innerHeight };
})()`;

/** The image NodeView's wrapper — the `bc-host` that owns the control column. */
const IMG_HOST = ".milkdown .ProseMirror .image-wrapper";

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror table", { timeout: 10000 });
    await page.waitForTimeout(300);

    // Both blocks must actually overflow the viewport, or every check below
    // passes vacuously against chrome that never had to move.
    await page.waitForSelector(".milkdown .ProseMirror img:not(.ProseMirror-separator)", { timeout: 10000 });
    const sizes = await page.evaluate(`({
        table: document.querySelector(".mw-table").getBoundingClientRect().height,
        image: document.querySelector("${IMG_HOST}").getBoundingClientRect().height,
        viewport: window.innerHeight,
    })`);
    check("fixture table is taller than the viewport",
        sizes.table > sizes.viewport, `table=${Math.round(sizes.table)} viewport=${sizes.viewport}`);
    check("fixture image is taller than the viewport",
        sizes.image > sizes.viewport, `image=${Math.round(sizes.image)} viewport=${sizes.viewport}`);

    // ── Table column grips ──────────────────────────────────────────────────
    // The overlay builds on the first pointer over the table (MAR-317), so the
    // grips have to be summoned before they can be measured.
    const centre = await page.evaluate(() => {
        const r = document.querySelector(".mw-table").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: Math.max(60, r.top + 60) };
    });
    await page.mouse.move(centre.x, centre.y);
    await page.waitForTimeout(300);

    const colGripState = () => page.evaluate(`(() => {
        const band = ${BAND};
        const table = document.querySelector(".mw-table table").getBoundingClientRect();
        const grips = [...document.querySelectorAll(".mw-grip--col")].map((g) => g.getBoundingClientRect());
        const plus = [...document.querySelectorAll(".mw-insert--col .mw-insert-btn")].map((b) => b.getBoundingClientRect());
        const bar = document.querySelector(".heading-sticky-title:not([hidden])");
        return {
            band,
            barBottom: bar ? bar.getBoundingClientRect().bottom : null,
            table: { top: table.top, bottom: table.bottom },
            grips, plus, count: grips.length,
        };
    })()`);

    const resting = await colGripState();
    check("the table built its column grips", resting.count === 3, `grips=${resting.count}`);
    // Whole table in view: the grips sit at their resting place, just above the
    // table's top edge. Nothing to clamp, and nothing may drift.
    check("with the whole table in view the grips rest on its top edge",
        resting.grips.every((g) => Math.abs(g.bottom - resting.table.top) <= 3),
        JSON.stringify(resting.grips.map((g) => Math.round(g.bottom - resting.table.top))));

    // ── Scrolled so the table's top edge is under the fixed topbar ──────────
    const scrollTo = async (y) => {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(200); // rAF-coalesced reposition + settle
    };
    const tableMid = await page.evaluate(() => {
        const r = document.querySelector(".mw-table table").getBoundingClientRect();
        return window.scrollY + r.top + r.height / 2;
    });
    await scrollTo(tableMid);

    const scrolled = await colGripState();
    check("the table's top edge really did scroll out of the band",
        scrolled.table.top < scrolled.band.top,
        `tableTop=${Math.round(scrolled.table.top)} bandTop=${scrolled.band.top}`);
    check("column grips slide down to stay clear of the topbar",
        scrolled.grips.every((g) => g.top >= scrolled.band.top - 1),
        JSON.stringify(scrolled.grips.map((g) => Math.round(g.top))));
    // The grips sit ON the table, inside the content column, where the sticky
    // heading bar paints — clearing the topbar alone can still leave them
    // behind it. This state also pins the safe-area change event as a
    // reposition trigger: a single scroll event lands the overlay's rAF one
    // frame before the bar appears, and without the re-run the grips measure
    // a band the bar is not yet part of and stay under it.
    check("the sticky heading bar is actually showing over the table",
        scrolled.barBottom !== null, `barBottom=${scrolled.barBottom}`);
    check("…and the grips and their '+' buttons clear it too",
        [...scrolled.grips, ...scrolled.plus].every((g) => g.top >= scrolled.barBottom - 1),
        JSON.stringify([...scrolled.grips, ...scrolled.plus].map((g) => Math.round(g.top))));
    check("…and stay inside the viewport",
        scrolled.grips.every((g) => g.bottom <= scrolled.band.bottom),
        JSON.stringify(scrolled.grips.map((g) => Math.round(g.bottom))));
    check("…while still sitting over their own table",
        scrolled.grips.every((g) => g.bottom <= scrolled.table.bottom + 1),
        `tableBottom=${Math.round(scrolled.table.bottom)}`);
    check("the column '+' buttons travel with the grips",
        scrolled.plus.length === 4 && scrolled.plus.every((b) => b.top >= scrolled.band.top - 1 && b.bottom <= scrolled.band.bottom),
        JSON.stringify(scrolled.plus.map((b) => Math.round(b.top))));

    // ── Scrolled past the table entirely ────────────────────────────────────
    // The block wins over the viewport: chrome for a block nobody can see must
    // be gone too, not parked under the topbar pointing at nothing.
    const pastTable = await page.evaluate(() => {
        const r = document.querySelector(".mw-table table").getBoundingClientRect();
        return window.scrollY + r.bottom + 200;
    });
    await scrollTo(pastTable);
    const past = await colGripState();
    check("scrolled past the table, its grips leave with it",
        past.table.bottom < past.band.top && past.grips.every((g) => g.bottom <= past.table.bottom + 1),
        `tableBottom=${Math.round(past.table.bottom)} grips=${JSON.stringify(past.grips.map((g) => Math.round(g.bottom)))}`);

    // ── The shared control column (image, table, code block, embed) ─────────
    // One primitive serves all four, so proving it on the tall image proves it
    // wherever `createBlockControlsColumn` is used.
    const scrollToBlockOffset = (offset) =>
        page.evaluate(`(() => {
            const r = document.querySelector("${IMG_HOST}").getBoundingClientRect();
            return window.scrollY + r.top + (${offset});
        })()`).then(scrollTo);

    // Far enough down the viewport that nothing pins yet: the pin reserves the
    // topbar AND the sticky heading title, so a top edge inside that reserved
    // band would legitimately seat the stack below it rather than on it.
    await scrollToBlockOffset(-200);
    const imgPoint = await page.evaluate(`(() => {
        const r = document.querySelector("${IMG_HOST}").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 200 };
    })()`);
    await page.mouse.move(imgPoint.x, imgPoint.y);
    await page.waitForTimeout(300);

    const stackState = () => page.evaluate(`(() => {
        const band = ${BAND};
        const host = document.querySelector("${IMG_HOST}").getBoundingClientRect();
        const stack = document.querySelector("${IMG_HOST} .bc-stack").getBoundingClientRect();
        return { band, host: { top: host.top, bottom: host.bottom }, stack: { top: stack.top, bottom: stack.bottom, height: stack.height } };
    })()`);

    const stackResting = await stackState();
    check("the image's control column attached its buttons",
        stackResting.stack.height > 0, `height=${Math.round(stackResting.stack.height)}`);
    check("with the block's top in view the controls rest at its top edge",
        Math.abs(stackResting.stack.top - stackResting.host.top) <= 2,
        `stack=${Math.round(stackResting.stack.top)} host=${Math.round(stackResting.host.top)}`);

    const imgHeight = await page.evaluate(`document.querySelector("${IMG_HOST}").getBoundingClientRect().height`);
    await scrollToBlockOffset(imgHeight / 2);
    const stuck = await stackState();
    check("the image's top edge really did scroll out of the band",
        stuck.host.top < stuck.band.top,
        `hostTop=${Math.round(stuck.host.top)} bandTop=${stuck.band.top}`);
    check("the control column sticks below the topbar instead of leaving",
        stuck.stack.top >= stuck.band.top - 1 && stuck.stack.bottom <= stuck.band.bottom,
        `stack=${Math.round(stuck.stack.top)}..${Math.round(stuck.stack.bottom)} band=${stuck.band.top}..${stuck.band.bottom}`);

    await scrollToBlockOffset(imgHeight + 300);
    const gone = await stackState();
    check("scrolled past the image, its controls leave with it",
        gone.host.bottom < gone.band.top && gone.stack.bottom <= gone.host.bottom + 1,
        `hostBottom=${Math.round(gone.host.bottom)} stackBottom=${Math.round(gone.stack.bottom)}`);

    // ── The code block's in-canvas language pill ────────────────────────────
    // A third mechanism, because this row lives inside the block rather than
    // beside it. The fixture raises --code-block-max-height to what dragging
    // the resize handle past the viewport produces; a default code block caps
    // well under it and never reaches this state.
    const codeState = () => page.evaluate(`(() => {
        const band = ${BAND};
        const host = document.querySelector(".code-block-wrapper").getBoundingClientRect();
        const row = document.querySelector(".code-block-wrapper .code-float-row").getBoundingClientRect();
        return { band, host: { top: host.top, bottom: host.bottom, height: host.height }, row: { top: row.top, bottom: row.bottom } };
    })()`);

    // Far enough down the viewport that nothing is stuck yet: the pin reserves
    // the topbar AND the sticky heading, and a 100px offset is inside that.
    const codeTop = await page.evaluate(`(() => {
        const r = document.querySelector(".code-block-wrapper").getBoundingClientRect();
        return window.scrollY + r.top - 400;
    })()`);
    await scrollTo(codeTop);
    const codeRest = await codeState();
    check("fixture code block is taller than the viewport",
        codeRest.host.height > sizes.viewport, `code=${Math.round(codeRest.host.height)}`);
    check("with the block's top in view the language pill rests inside its canvas",
        Math.abs(codeRest.row.top - (codeRest.host.top + 6)) <= 2,
        `row=${Math.round(codeRest.row.top)} host=${Math.round(codeRest.host.top)}`);

    await page.evaluate(`window.scrollTo(0, ${codeTop} + ${codeRest.host.height} / 2)`);
    await page.waitForTimeout(200);
    const codeStuck = await codeState();
    check("the language pill sticks below the topbar instead of leaving",
        codeStuck.host.top < codeStuck.band.top
        && codeStuck.row.top >= codeStuck.band.top - 1
        && codeStuck.row.bottom <= codeStuck.band.bottom,
        `host=${Math.round(codeStuck.host.top)} row=${Math.round(codeStuck.row.top)} band=${codeStuck.band.top}`);

    // Clearing the topbar is not enough for this one. The pill sits INSIDE the
    // content column, and the sticky heading title paints across exactly that
    // width, so a pin that reserved only the topbar would move the pill from
    // off screen to behind the heading bar. The hit test is the assertion that
    // matters: a pill you can see the top edge of but cannot click is no better
    // than one that scrolled away.
    const occlusion = await page.evaluate(`(() => {
        const sticky = document.querySelector(".heading-sticky-title:not([hidden])");
        const row = document.querySelector(".code-block-wrapper .code-float-row").getBoundingClientRect();
        const hit = document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2);
        return {
            stickyShown: !!sticky,
            stickyBottom: sticky ? sticky.getBoundingClientRect().bottom : null,
            rowTop: row.top,
            reachable: !!hit && !!hit.closest(".code-float-row"),
            hit: hit ? (hit.className || hit.tagName) : null,
        };
    })()`);
    // Guard the guard: with no bar painted, the check below would pass on a
    // pill that is occluded the moment one appears.
    check("the sticky heading bar is actually showing over the code block",
        occlusion.stickyShown, `stickyShown=${occlusion.stickyShown}`);
    check("the pinned pill clears the sticky heading and stays clickable",
        occlusion.reachable && occlusion.rowTop >= occlusion.stickyBottom - 1,
        `rowTop=${Math.round(occlusion.rowTop)} stickyBottom=${Math.round(occlusion.stickyBottom)} hit=${occlusion.hit}`);

    // The row is click-through everywhere except over the pill itself: it now
    // sits inside a strip spanning the whole block, and a strip that swallowed
    // clicks would make the code under it uneditable.
    const clickThrough = await page.evaluate(`(() => {
        const wrap = document.querySelector(".code-block-wrapper");
        const rail = wrap.querySelector(".code-float-rail").getBoundingClientRect();
        const hit = document.elementFromPoint(rail.left + rail.width - 20, rail.top + rail.height / 2);
        return { tag: hit ? hit.tagName : null, inRail: hit ? !!hit.closest(".code-float-rail") : false };
    })()`);
    check("the pill's strip is click-through over the code",
        !clickThrough.inRail, `hit=${clickThrough.tag}`);

    // ── A block nested in a quote: its pinned controls clear the sticky bar ──
    // The strip of a TOP-LEVEL block sits outside the content column, which the
    // sticky heading title spans exactly — but a blockquote's padding insets a
    // nested block INTO that column, so its pinned stack sits where the bar
    // paints and must reserve the bar's height on top of the topbar.
    const QUOTED_HOST = ".milkdown .ProseMirror blockquote .image-wrapper";
    await page.waitForSelector(QUOTED_HOST, { timeout: 10000 });
    const quotedGeom = await page.evaluate(`(() => {
        const r = document.querySelector("${QUOTED_HOST}").getBoundingClientRect();
        return { top: window.scrollY + r.top, height: r.height };
    })()`);
    check("fixture quoted image is taller than the viewport",
        quotedGeom.height > sizes.viewport, `image=${Math.round(quotedGeom.height)} viewport=${sizes.viewport}`);
    await scrollTo(quotedGeom.top + quotedGeom.height / 2);
    const quotedPoint = await page.evaluate(`(() => {
        const r = document.querySelector("${QUOTED_HOST}").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: Math.max(r.top + 40, 200) };
    })()`);
    await page.mouse.move(quotedPoint.x, quotedPoint.y);
    await page.waitForTimeout(300);
    const quoted = await page.evaluate(`(() => {
        const band = ${BAND};
        const host = document.querySelector("${QUOTED_HOST}").getBoundingClientRect();
        const stack = document.querySelector("${QUOTED_HOST} .bc-stack").getBoundingClientRect();
        const bar = document.querySelector(".heading-sticky-title:not([hidden])");
        return {
            band,
            host: { top: host.top },
            stack: { top: stack.top, bottom: stack.bottom, height: stack.height },
            barBottom: bar ? bar.getBoundingClientRect().bottom : null,
        };
    })()`);
    check("the quoted image's top edge really did scroll out of the band",
        quoted.host.top < quoted.band.top,
        `hostTop=${Math.round(quoted.host.top)} bandTop=${quoted.band.top}`);
    check("the sticky heading bar is actually showing over the quoted image",
        quoted.barBottom !== null, `barBottom=${quoted.barBottom}`);
    check("the quoted image's pinned controls clear the sticky bar",
        quoted.stack.height > 0 && quoted.stack.top >= quoted.barBottom - 1,
        `stack=${Math.round(quoted.stack.top)} barBottom=${Math.round(quoted.barBottom)}`);

    // ── Stacking: content-dimming overlays sit under the persistent bar ──────
    // The drag veil and the landing flash mark CONTENT (what a drag will move,
    // where a drop went), so they paint under the sticky heading title — an
    // outline-scope drag of a tall section must not wash the section title out.
    // Probed against the real stylesheet with bare-class elements.
    const stacking = await page.evaluate(`(() => {
        const z = (cls) => {
            const el = document.createElement("div");
            el.className = cls;
            document.body.appendChild(el);
            const v = Number(getComputedStyle(el).zIndex);
            el.remove();
            return v;
        };
        const bar = document.querySelector(".heading-sticky-title");
        return {
            veil: z("block-drag-veil"),
            flash: z("block-drop-flash"),
            sticky: bar ? Number(getComputedStyle(bar).zIndex) : null,
        };
    })()`);
    check("the drag veil paints under the sticky heading title",
        stacking.sticky !== null && stacking.veil < stacking.sticky, JSON.stringify(stacking));
    check("the landing flash paints under the sticky heading title",
        stacking.sticky !== null && stacking.flash < stacking.sticky, JSON.stringify(stacking));
}
