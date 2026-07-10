/**
 * Paragraph "P" gutter — real-browser truths (hover reveal is CSS :hover, which
 * jsdom can't compute):
 *   - the marker is invisible (and unclickable) until the paragraph is hovered,
 *   - hovering the paragraph shows a subtle P; hovering the marker itself brings
 *     it to the headings' full-contrast treatment,
 *   - clicking it opens the same P/H1–H6 menu, and picking H2 promotes the
 *     paragraph (serialized as `## …`),
 *   - list/quote paragraphs get no marker (top-level only).
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".heading-fold-marker--paragraph", { timeout: 10000 });
    await page.waitForTimeout(200);

    const pMarker = ".ProseMirror > p .heading-fold-marker--paragraph";
    const opacity = () => page.$eval(pMarker, (el) => getComputedStyle(el).opacity);

    // ── 1. Exactly one paragraph marker: the top-level paragraph only ──
    const markerCount = await page.$$eval(".heading-fold-marker--paragraph", (els) => els.length);
    check("only the top-level paragraph gets a P marker", markerCount === 1, `count=${markerCount}`);
    const inListOrQuote = await page.$$eval(
        "li .heading-fold-marker--paragraph, blockquote .heading-fold-marker--paragraph",
        (els) => els.length,
    );
    check("no P marker inside list or quote", inListOrQuote === 0);

    // ── 2. Idle: invisible and click-inert ──
    await page.mouse.move(700, 600); // park the pointer away from any paragraph
    await page.waitForTimeout(100);
    check("idle: P marker invisible", (await opacity()) === "0", `opacity=${await opacity()}`);

    // ── 3. Hovering the paragraph reveals a subtle P ──
    const paraBox = await page.$eval(".ProseMirror > p", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(paraBox.x, paraBox.y);
    await page.waitForTimeout(150);
    const subtle = parseFloat(await opacity());
    check("paragraph hover: P visible but subtle", subtle > 0 && subtle < 0.6, `opacity=${subtle}`);

    // ── 4. Hovering the marker itself: full contrast ──
    const markerBox = await page.$eval(pMarker, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(markerBox.x, markerBox.y);
    await page.waitForTimeout(150);
    check("marker hover: full contrast", (await opacity()) === "1", `opacity=${await opacity()}`);

    // ── 5. Click opens the shared retype menu with P checked ──
    await page.mouse.click(markerBox.x, markerBox.y);
    await page.waitForTimeout(100);
    const menu = await page.$(".heading-level-menu");
    check("clicking P opens the level menu", menu !== null);
    const activeLabel = await page.$eval(
        ".heading-level-menu .heading-level-item--active",
        (el) => el.textContent.trim(),
    );
    check("menu marks P as the current level", activeLabel === "P", `active=${activeLabel}`);

    // ── 6. Picking H2 promotes the paragraph ──
    const rows = await page.$$(".heading-level-menu .heading-level-item");
    await rows[2].dispatchEvent("mousedown"); // P,H1,H2 → index 2
    await page.waitForTimeout(100);
    check("menu closed after pick", (await page.$(".heading-level-menu")) === null);
    // Updates are debounced (300ms) — poll for the promoted line.
    let promoted = null;
    for (let i = 0; i < 30 && !promoted; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last?.includes("## First top-level paragraph here.")) promoted = last;
        else await page.waitForTimeout(100);
    }
    check("paragraph promoted to H2 in the serialized doc", promoted !== null);

    // The promoted block is now a heading — it gets the heading gutter (##),
    // and the paragraph marker count drops to zero.
    await page.waitForTimeout(150);
    const after = await page.$$eval(".heading-fold-marker--paragraph", (els) => els.length);
    check("promoted block no longer carries a P marker", after === 0, `count=${after}`);
}
