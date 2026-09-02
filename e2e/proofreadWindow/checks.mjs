/**
 * MAR-425 — the style pass's scroll window, in a real browser.
 *
 * The proofread plugin builds its style decorations for the blocks near the
 * viewport (plugins/visibleRange.ts, the fold gutter's window) and follows the
 * scroll. No jsdom test can observe that: the measurement needs real layout,
 * and the point is what happens as the page scrolls. What must hold, and it is
 * the gutterWindow list applied to a second decoration:
 *
 *   - a long document renders far fewer style hits than it has;
 *   - scrolling brings hits to the blocks that arrive, within a frame or two;
 *   - adding and removing hits NEVER moves content: they are inline classes
 *     on text, so the document's height is scroll-invariant;
 *   - the pass costs the screen: the `style-scan` counter's block count is a
 *     fraction of the document's;
 *   - document-wide STATE stays document-wide: the proofreading gate turned
 *     off is off everywhere, including blocks scrolled to afterwards, and the
 *     review sidebar lists every finding in the document, not the window's;
 *   - the sticky heading title behaves as it does today.
 */

const SETTLE = 250;

/** Scroll, then wait out the rAF-coalesced window measurement and the rebuild. */
async function scrollTo(page, y) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await page.waitForTimeout(SETTLE);
    await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await page.waitForTimeout(SETTLE);
}

const hitCount = (page) => page.$$eval(".pf-style-hit", (els) => els.length);

/** Style hits whose box is inside the viewport. */
const onScreenHits = (page) => page.evaluate(() => {
    const vh = window.innerHeight;
    return [...document.querySelectorAll(".pf-style-hit")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > 0 && r.bottom < vh;
    }).length;
});

/**
 * The largest `style-scan` work counter on the timeline so far, or null. Read
 * before the sidebar's Proofreading tab is opened, that is the first pass: the
 * other marks are the sidebar's tab-visibility probe, which stops at the first
 * hit, and the scroll rebuilds, which regex only what the cache has not seen
 * and can legitimately read zero.
 */
const peakScan = (page) => page.evaluate(() => {
    const marks = performance.getEntriesByName("mdw:style-scan", "mark");
    if (marks.length === 0) { return null; }
    const peak = marks.reduce((a, b) => ((b.detail?.blocks ?? 0) > (a.detail?.blocks ?? 0) ? b : a));
    return { count: marks.length, detail: peak.detail };
});

async function switchTab(page, name) {
    const select = page.locator(".toc-tabs--select .toc-tabs-select");
    if (await select.count()) {
        await select.dispatchEvent("mousedown");
        await page.locator(".toc-tabs-menu__item", { hasText: name }).first().dispatchEvent("mousedown");
    } else {
        await page.locator(".toc-tab", { hasText: name }).first().click();
    }
    await page.waitForTimeout(120);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".pf-style-hit", { timeout: 15000 });
    await page.waitForTimeout(1200); // the post-paint idle first pass

    const paragraphs = await page.$$eval(".milkdown .ProseMirror > p", (els) => els.length);
    const textblocks = await page.$$eval(".milkdown .ProseMirror > :is(p, h1, h2, h3)", (els) => els.length);
    check("the fixture is long enough to exercise a window", paragraphs > 250, `paragraphs=${paragraphs}`);

    // ── 0. Nothing is drawn before the first-paint mark ──
    // The first pass is deferred past paint (AGENTS.md, Launch performance);
    // a window measured early would pull the decorations' DOM in front of it.
    const atPaint = await page.evaluate(() => window.__atPaint);
    check("no style decoration exists at the first-paint mark",
        !!atPaint && atPaint.hits === 0, JSON.stringify(atPaint));

    // ── 1. Only a slice of the document carries hits ──
    await scrollTo(page, 0);
    const atTop = await hitCount(page);
    check("a long document renders style hits for only part of it",
        atTop > 0 && atTop < paragraphs, `hits=${atTop} paragraphs=${paragraphs}`);

    // ── 2. The pass costs the screen, not the document ──
    const scan = await peakScan(page);
    check("the style-scan work counter reaches the timeline with its counts",
        scan !== null && typeof scan.detail?.blocks === "number" && typeof scan.detail?.chars === "number",
        JSON.stringify(scan));
    check("the first pass ran the matcher on a fraction of the document's textblocks",
        scan !== null && scan.detail.blocks > 0 && scan.detail.blocks < textblocks / 2,
        `visited=${scan?.detail?.blocks} textblocks=${textblocks}`);

    // ── 3. Height is scroll-invariant: windowing must not move content ──
    const heightAtTop = await page.evaluate(() => document.documentElement.scrollHeight);

    // ── 4. Scrolling brings hits to what arrives, within a frame or two ──
    const midY = await page.evaluate(() => Math.round(document.documentElement.scrollHeight / 2));
    // The blocks at the far middle are outside a window measured at the top
    // (two screens of margin against half the document), so what is found
    // there after the scroll was built BY the scroll.
    const midBeforeScroll = await page.evaluate((y) => {
        const vh = window.innerHeight;
        return [...document.querySelectorAll(".pf-style-hit")].filter((el) => {
            const top = el.getBoundingClientRect().top + window.scrollY;
            return top > y && top < y + vh;
        }).length;
    }, midY);
    check("the middle of the document carries no hits before it is scrolled to",
        midBeforeScroll === 0, `hits at mid=${midBeforeScroll}`);
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), midY);
    // The scroll event, the observer's frame, the rebuild: three frames at most.
    await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))),
    );
    const midQuick = await onScreenHits(page);
    check("blocks scrolled into view carry their hits within three frames",
        midQuick > 0, `on-screen hits=${midQuick}`);
    await page.waitForTimeout(SETTLE);
    const heightAtMid = await page.evaluate(() => document.documentElement.scrollHeight);
    check("the document height is unchanged by the window moving",
        heightAtMid === heightAtTop, `${heightAtTop} → ${heightAtMid}`);

    // ── 5. The far end, then back to the top: nothing is permanently lost ──
    await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
    const bottom = await onScreenHits(page);
    check("the document's far end gets its hits once reached", bottom > 0, `on-screen hits=${bottom}`);
    const finalMarked = await page.evaluate(() =>
        [...document.querySelectorAll(".pf-style-hit")].some((el) => el.textContent === "basically"));
    check("the last paragraph's filler is decorated at the far end", finalMarked === true);
    await scrollTo(page, 0);
    const backAtTop = await hitCount(page);
    check("returning to the top restores its hits", backAtTop > 0 && backAtTop < paragraphs, `hits=${backAtTop}`);
    const heightBack = await page.evaluate(() => document.documentElement.scrollHeight);
    check("height is still unchanged after the round trip", heightBack === heightAtTop, `${heightAtTop} → ${heightBack}`);

    // ── 6. The sticky heading title behaves as it does today ──
    await scrollTo(page, midY);
    const sticky = await page.evaluate(() => {
        const el = document.querySelector(".heading-sticky-title");
        return el && !el.hidden ? { present: true, text: el.textContent.trim().slice(0, 40) } : { present: false };
    });
    check("the sticky heading title is showing mid-document", sticky.present === true, JSON.stringify(sticky));

    // ── 7. The review sidebar lists the document, not the window ──
    // The panel auto-opened (tocAutoHideThreshold: 3, 150 headings). Its
    // Proofreading tab is a document-wide review list, and the windowed set
    // must not shrink it: expand every capped group, then count.
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    await switchTab(page, "Proofread");
    await page.waitForSelector(".review-list--proofread:not(.toc-view--hidden)", { timeout: 5000 });
    for (let i = 0; i < 6; i++) {
        const more = page.locator(".review-list--proofread .review-more", { hasText: /more/i });
        if ((await more.count()) === 0) { break; }
        await more.first().click();
        await page.waitForTimeout(100);
    }
    const listed = await page.$$eval(".review-list--proofread .review-item", (els) => els.length);
    const drawn = await hitCount(page);
    check("the sidebar lists every finding in the document while only a window's worth is drawn",
        listed > drawn && listed >= paragraphs,
        `listed=${listed} drawn=${drawn} paragraphs=${paragraphs}`);

    // ── 8. The proofreading gate is document-wide ──
    // Off: nothing anywhere, and a block scrolled to AFTER the toggle gets
    // nothing either (the window keeps moving; the gate wins). On: they return.
    await page.evaluate(() => window.postMessage({ type: "proofreadConfig", config: window.__proofreadConfig(false) }, "*"));
    await page.waitForTimeout(400);
    check("proofreading off ⇒ no style hit anywhere", (await hitCount(page)) === 0, `hits=${await hitCount(page)}`);
    await scrollTo(page, 0);
    await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
    check("proofreading off ⇒ scrolling to new blocks draws nothing",
        (await hitCount(page)) === 0, `hits=${await hitCount(page)}`);
    await page.evaluate(() => window.postMessage({ type: "proofreadConfig", config: window.__proofreadConfig(true) }, "*"));
    await page.waitForTimeout(400);
    const backOn = await onScreenHits(page);
    check("proofreading on again ⇒ the blocks on screen get their hits back", backOn > 0, `on-screen hits=${backOn}`);
    const drawnAfter = await hitCount(page);
    check("and the re-enabled pass is still windowed",
        drawnAfter > 0 && drawnAfter < paragraphs, `hits=${drawnAfter} paragraphs=${paragraphs}`);
}
