/**
 * MAR-425 and MAR-426 — the proofread passes' scroll window, in a real browser.
 *
 * The proofread plugin builds its style decorations for the blocks near the
 * viewport (plugins/visibleRange.ts, the fold gutter's window), asks the host
 * about the same blocks and no others, and follows the scroll. No jsdom test
 * can observe that: the measurement needs real layout, and the point is what
 * happens as the page scrolls. What must hold, and it is the gutterWindow list
 * applied to two more decorations:
 *
 *   - a long document renders far fewer style hits and underlines than it has;
 *   - the first lint request is a fraction of the document, and a scroll tour
 *     that never opens the review still never asks about all of it;
 *   - scrolling brings hits and underlines to the blocks that arrive, hits
 *     within a frame or two and underlines within a round trip;
 *   - adding and removing them NEVER moves content: they are inline classes
 *     on text, so the document's height is scroll-invariant;
 *   - the passes cost the screen: the `style-scan` and `lint-request`
 *     counters' block counts are a fraction of the document's;
 *   - document-wide STATE stays document-wide: the proofreading gate turned
 *     off is off everywhere, including blocks scrolled to afterwards, and the
 *     review sidebar lists every finding in the document, not the window's,
 *     asking for the rest in slices when it is opened;
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
const spellCount = (page) => page.$$eval(".pf-spell-err", (els) => els.length);

/** Decorations of `selector` whose box is inside the viewport. */
const onScreen = (page, selector) => page.evaluate((sel) => {
    const vh = window.innerHeight;
    return [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > 0 && r.bottom < vh;
    }).length;
}, selector);
const onScreenHits = (page) => onScreen(page, ".pf-style-hit");
const onScreenSpell = (page) => onScreen(page, ".pf-spell-err");

/**
 * What the page has handed the stub host so far: every `lintBlocks` post,
 * summed, plus the largest single post. Read off the posts themselves rather
 * than the timeline, so the counter can be checked against it.
 */
const asked = (page) => page.evaluate(() => {
    const posts = window.__posted.filter((m) => m.type === "lintBlocks");
    const chars = (p) => p.blocks.reduce((n, b) => n + b.text.length, 0);
    return {
        posts: posts.length,
        blocks: posts.reduce((n, p) => n + p.blocks.length, 0),
        chars: posts.reduce((n, p) => n + chars(p), 0),
        largestPost: posts.reduce((n, p) => Math.max(n, p.blocks.length), 0),
        largestChars: posts.reduce((n, p) => Math.max(n, chars(p)), 0),
    };
});

/** The `lint-request` work counter, summed over the timeline, as the nightly gate sums it. */
const lintCounter = (page) => page.evaluate(() => {
    const marks = performance.getEntriesByName("mdw:lint-request", "mark");
    return marks.reduce((acc, m) => ({
        count: acc.count + 1,
        blocks: acc.blocks + (m.detail?.blocks ?? 0),
        chars: acc.chars + (m.detail?.chars ?? 0),
    }), { count: 0, blocks: 0, chars: 0 });
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
    check("no underline exists and no lint request has gone out at the first-paint mark",
        !!atPaint && atPaint.spell === 0 && atPaint.asked === 0, JSON.stringify(atPaint));

    // ── 1. Only a slice of the document carries hits and underlines ──
    await scrollTo(page, 0);
    const atTop = await hitCount(page);
    check("a long document renders style hits for only part of it",
        atTop > 0 && atTop < paragraphs, `hits=${atTop} paragraphs=${paragraphs}`);
    await page.waitForSelector(".pf-spell-err", { timeout: 5000 });
    const spellAtTop = await spellCount(page);
    check("a long document renders underlines for only part of it",
        spellAtTop > 0 && spellAtTop < textblocks, `underlines=${spellAtTop} textblocks=${textblocks}`);

    // ── 2. The passes cost the screen, not the document ──
    const scan = await peakScan(page);
    check("the style-scan work counter reaches the timeline with its counts",
        scan !== null && typeof scan.detail?.blocks === "number" && typeof scan.detail?.chars === "number",
        JSON.stringify(scan));
    check("the first pass ran the matcher on a fraction of the document's textblocks",
        scan !== null && scan.detail.blocks > 0 && scan.detail.blocks < textblocks / 2,
        `visited=${scan?.detail?.blocks} textblocks=${textblocks}`);
    // The first lint request: what was handed across the host boundary before
    // anything scrolled. This is the count the nightly heavy-fixture gate reads
    // over a mount-plus-burst, and it has to be the screen's, not the document's.
    const firstAsk = await asked(page);
    check("the first pass asked the host about a fraction of the document's textblocks",
        firstAsk.blocks > 0 && firstAsk.blocks < textblocks / 2,
        `asked=${firstAsk.blocks} textblocks=${textblocks} posts=${firstAsk.posts}`);
    const counterAtTop = await lintCounter(page);
    check("the lint-request work counter reaches the timeline and agrees with what was posted",
        counterAtTop.count > 0 && counterAtTop.blocks === firstAsk.blocks && counterAtTop.chars === firstAsk.chars,
        `counter=${JSON.stringify(counterAtTop)} posted=${JSON.stringify(firstAsk)}`);

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
    // Underlines are a question to the host, so they take the coalescing
    // delay plus a round trip rather than a frame; the stub answers on the
    // next task, so the settle is the delay.
    await page.waitForTimeout(SETTLE);
    const midSpell = await onScreenSpell(page);
    check("blocks scrolled into view get their underlines within a round trip",
        midSpell > 0, `on-screen underlines=${midSpell}`);
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
    const finalUnderlined = await page.evaluate(() =>
        [...document.querySelectorAll(".pf-spell-err")].some((el) => el.textContent === "basically"));
    check("the last paragraph's last word is underlined at the far end", finalUnderlined === true);
    const spellAtBottom = await spellCount(page);
    check("the far end's underlines are still a window's worth",
        spellAtBottom > 0 && spellAtBottom < textblocks, `underlines=${spellAtBottom} textblocks=${textblocks}`);
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
    // The scroll tour above visited the top, the middle and the far end, and
    // asked the host about each window it landed on. Nothing asked about the
    // blocks between them: a block never scrolled to is never asked about,
    // until something wants the whole document.
    const afterTour = await asked(page);
    check("a scroll tour asks about the windows it lands on and never the whole document",
        afterTour.blocks > firstAsk.blocks && afterTour.blocks < textblocks,
        `asked=${afterTour.blocks} textblocks=${textblocks} posts=${afterTour.posts}`);

    // The panel auto-opened (tocAutoHideThreshold: 3, hundreds of headings). Its
    // Proofreading tab is a document-wide review list, and the windowed sets
    // must not shrink it. Opening it is what asks the host about the rest, in
    // slices with one in flight, so wait until the page has asked about every
    // textblock (each block's text here is distinct, so a count is a coverage).
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    await switchTab(page, "Proofread");
    await page.waitForSelector(".review-list--proofread:not(.toc-view--hidden)", { timeout: 5000 });
    await page.waitForFunction((n) => {
        const posts = window.__posted.filter((m) => m.type === "lintBlocks");
        return posts.reduce((s, p) => s + p.blocks.length, 0) >= n;
    }, textblocks, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(SETTLE);
    const afterReview = await asked(page);
    check("opening the review asks the host about the rest of the document",
        afterReview.blocks >= textblocks,
        `asked=${afterReview.blocks} textblocks=${textblocks} posts=${afterReview.posts}`);
    // Sliced: more than one post carried the remainder, and no post carried
    // anything near the document. The budget is REVIEW_SLICE_CHARS in the
    // plugin; a window's worth of this fixture is well under it too.
    check("the remainder went out in more than one slice, none of them the document",
        afterReview.posts - afterTour.posts > 1 && afterReview.largestChars < 9000 && afterReview.largestPost < textblocks / 2,
        `slices=${afterReview.posts - afterTour.posts} largest=${afterReview.largestPost} blocks/${afterReview.largestChars} chars`);
    for (let i = 0; i < 8; i++) {
        const more = page.locator(".review-list--proofread .review-more", { hasText: /more/i });
        if ((await more.count()) === 0) { break; }
        await more.first().click();
        await page.waitForTimeout(100);
    }
    const listed = await page.$$eval(".review-list--proofread .review-item", (els) => els.length);
    const drawn = (await hitCount(page)) + (await spellCount(page));
    check("the sidebar lists every finding in the document while only a window's worth is drawn",
        listed > drawn && listed >= paragraphs + textblocks,
        `listed=${listed} drawn=${drawn} paragraphs=${paragraphs} textblocks=${textblocks}`);
    const drawnSpell = await spellCount(page);
    check("the drawn underlines are still the window's after the document-wide answer",
        drawnSpell > 0 && drawnSpell < textblocks, `underlines=${drawnSpell} textblocks=${textblocks}`);

    // ── 8. The proofreading gate is document-wide ──
    // Off: nothing anywhere, and a block scrolled to AFTER the toggle gets
    // nothing either (the window keeps moving; the gate wins). On: they return.
    await page.evaluate(() => window.postMessage({ type: "proofreadConfig", config: window.__proofreadConfig(false) }, "*"));
    await page.waitForTimeout(400);
    check("proofreading off ⇒ no style hit anywhere", (await hitCount(page)) === 0, `hits=${await hitCount(page)}`);
    check("proofreading off ⇒ no underline anywhere", (await spellCount(page)) === 0, `underlines=${await spellCount(page)}`);
    const askedAtOff = await asked(page);
    await scrollTo(page, 0);
    await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
    check("proofreading off ⇒ scrolling to new blocks draws nothing",
        (await hitCount(page)) === 0 && (await spellCount(page)) === 0,
        `hits=${await hitCount(page)} underlines=${await spellCount(page)}`);
    check("proofreading off ⇒ scrolling asks the host nothing",
        (await asked(page)).posts === askedAtOff.posts, `posts=${(await asked(page)).posts} before=${askedAtOff.posts}`);
    await page.evaluate(() => window.postMessage({ type: "proofreadConfig", config: window.__proofreadConfig(true) }, "*"));
    await page.waitForTimeout(400);
    const backOn = await onScreenHits(page);
    check("proofreading on again ⇒ the blocks on screen get their hits back", backOn > 0, `on-screen hits=${backOn}`);
    const drawnAfter = await hitCount(page);
    check("and the re-enabled pass is still windowed",
        drawnAfter > 0 && drawnAfter < paragraphs, `hits=${drawnAfter} paragraphs=${paragraphs}`);
    const spellBackOn = await onScreenSpell(page);
    check("proofreading on again ⇒ the blocks on screen get their underlines back, from what the host already answered",
        spellBackOn > 0, `on-screen underlines=${spellBackOn}`);
}
