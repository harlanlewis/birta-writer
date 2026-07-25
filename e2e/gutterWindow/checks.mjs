/**
 * MAR-215 — the gutter chrome's scroll window, in a real browser.
 *
 * The decoration pass only materializes block gutters near the viewport, which
 * no jsdom test can observe: the measurement needs real layout, and the whole
 * point is what happens as the page scrolls. What must hold:
 *
 *   - a long document renders far fewer gutter markers than it has blocks;
 *   - scrolling brings chrome to the blocks that arrive, and leaves it behind
 *     on the blocks already visited (nothing is permanently stripped);
 *   - adding and removing chrome NEVER moves content — the host class is
 *     `position: relative` and the gutter is absolutely positioned, so the
 *     document's height and a block's position must be scroll-invariant;
 *   - fold state is document-wide, not windowed: a collapsed callout at the
 *     far end of the document is still collapsed while off screen (an expanded
 *     one would change the scroll height under the reader);
 *   - the sticky heading title keeps its fold chevron, even though its heading
 *     is above the viewport by definition and so outside the window.
 */

const SETTLE = 250;

async function scrollTo(page, y) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await page.waitForTimeout(SETTLE);
    // Two frames for the rAF-coalesced window measurement plus the rebuild.
    await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await page.waitForTimeout(SETTLE);
}

const markerCount = (page) =>
    page.$$eval(".heading-fold-marker", (els) => els.length);

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".heading-fold-marker", { timeout: 15000 });
    await page.waitForTimeout(1200); // the post-paint idle affordance build

    const blocks = await page.$$eval(".milkdown .ProseMirror > *", (els) => els.length);
    check("the fixture is long enough to exercise a window", blocks > 300, `blocks=${blocks}`);

    // ── 1. Only a slice of the document carries chrome ──
    await scrollTo(page, 0);
    const atTop = await markerCount(page);
    check(
        "a long document renders chrome for only part of it",
        atTop > 0 && atTop < blocks,
        `markers=${atTop} blocks=${blocks}`,
    );

    // ── 2. Height is scroll-invariant: windowing must not move content ──
    const heightAtTop = await page.evaluate(() => document.documentElement.scrollHeight);

    // ── 3. Scrolling brings chrome to what arrives ──
    const midY = await page.evaluate(
        () => Math.round(document.documentElement.scrollHeight / 2),
    );
    await scrollTo(page, midY);
    const midMarkers = await page.evaluate(() => {
        const seen = [...document.querySelectorAll(".heading-fold-marker")];
        const vh = window.innerHeight;
        return seen.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top > 0 && r.bottom < vh;
        }).length;
    });
    check("blocks scrolled into view carry their gutter chrome", midMarkers > 0, `on-screen markers=${midMarkers}`);

    const heightAtMid = await page.evaluate(() => document.documentElement.scrollHeight);
    check(
        "the document height is unchanged by the window moving",
        heightAtMid === heightAtTop,
        `${heightAtTop} → ${heightAtMid}`,
    );

    // ── 4. The far end, then back to the top: nothing is permanently lost ──
    await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
    const bottomMarkers = await page.evaluate(() => {
        const vh = window.innerHeight;
        return [...document.querySelectorAll(".heading-fold-marker")].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top > 0 && r.bottom < vh;
        }).length;
    });
    check("the document's far end gets chrome once reached", bottomMarkers > 0, `on-screen markers=${bottomMarkers}`);

    // ── 5. Fold state is document-wide, not windowed ──
    // Both callouts (one at each end) were seeded collapsed by their `-`
    // marker; the one off screen must still be hiding its body.
    const collapsedFarFromView = await page.$$eval(
        ".callout.collapsed, .block-gutter-host.collapsed",
        (els) => els.length,
    );
    check(
        "a collapsed callout stays collapsed while off screen",
        collapsedFarFromView >= 2,
        `collapsed hosts=${collapsedFarFromView}`,
    );
    const hiddenBodyVisible = await page.evaluate(() =>
        [...document.querySelectorAll(".callout")].some((c) =>
            c.textContent.includes("top hidden body") && c.getBoundingClientRect().height > 120));
    check("the off-screen fold has not silently expanded", hiddenBodyVisible === false);

    await scrollTo(page, 0);
    const backAtTop = await markerCount(page);
    check("returning to the top restores its chrome", backAtTop > 0, `markers=${backAtTop}`);
    const heightBack = await page.evaluate(() => document.documentElement.scrollHeight);
    check("height is still unchanged after the round trip", heightBack === heightAtTop, `${heightAtTop} → ${heightBack}`);

    // ── 6. The sticky heading keeps its chevron above the viewport ──
    await scrollTo(page, midY);
    const sticky = await page.evaluate(() => {
        const el = document.querySelector(".heading-sticky-title");
        if (!el || el.hidden) { return { present: false }; }
        return {
            present: true,
            hasToggle: !!el.querySelector(".heading-sticky-toggle"),
            text: el.textContent.trim().slice(0, 40),
        };
    });
    check("the sticky heading title is showing", sticky.present === true, JSON.stringify(sticky));
    check(
        "the sticky title keeps its fold chevron though its heading is outside the window",
        sticky.hasToggle === true,
        JSON.stringify(sticky),
    );

    // ── 7. The caret's own block keeps a marker after scrolling away ──
    // The keyboard block menu anchors to a RENDERED marker at the caret
    // (components/blockMenu/openAtCaret.ts), so a caret left behind by the
    // scroll window must still have one — that is what the plugin's caret pin
    // is for, and it is not observable without real scrolling.
    const caretTarget = await page.evaluate(() => {
        const paragraphs = [...document.querySelectorAll(".milkdown .ProseMirror > p")];
        const vh = window.innerHeight;
        const target = paragraphs.find((p) => {
            const r = p.getBoundingClientRect();
            // Well clear of the topbar AND the sticky heading title, which
            // float over the top of the viewport and would swallow the click.
            return r.top > 260 && r.bottom < vh - 20 && p.textContent.trim().length > 0;
        });
        if (!target) { return null; }
        const r = target.getBoundingClientRect();
        // Identified by TEXT, not by a stamped attribute: ProseMirror's DOM
        // observer reverts attributes it did not write.
        return {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            text: target.textContent.trim(),
        };
    });
    check("a paragraph is available to take the caret", caretTarget !== null, JSON.stringify(caretTarget));
    // A real mouse click: a synthetic el.click() does not move the caret
    // inside a contenteditable, so the pin would never be exercised.
    await page.mouse.click(caretTarget.x, caretTarget.y);
    await page.waitForTimeout(200);
    const caretLanded = await page.evaluate((text) => {
        const sel = document.getSelection();
        const node = sel && sel.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const para = el && el.closest("p");
        return !!para && para.textContent.trim() === text;
    }, caretTarget.text);
    check("the caret landed in the probe paragraph", caretLanded === true);

    await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
    const caretStillMarked = await page.evaluate((text) => {
        const para = [...document.querySelectorAll(".milkdown .ProseMirror > p")]
            .find((p) => p.textContent.trim() === text);
        if (!para) { return "paragraph gone"; }
        const r = para.getBoundingClientRect();
        const onScreen = r.bottom > 0 && r.top < window.innerHeight;
        return { onScreen, marked: !!para.querySelector(".heading-fold-marker") };
    }, caretTarget.text);
    check(
        "the caret's block keeps its marker after the window scrolls away from it",
        caretStillMarked && caretStillMarked.marked === true && caretStillMarked.onScreen === false,
        JSON.stringify(caretStillMarked),
    );
}
