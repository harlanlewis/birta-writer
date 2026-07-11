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
    // The fixture's code block pulls the lazy grammar chunk and re-highlights
    // asynchronously; those late DOM mutations clear Chromium's hover chain
    // out from under a synthetic mouse position, so let startup fully settle
    // before any hover-dependent check.
    await page.waitForTimeout(700);

    const pMarker = ".ProseMirror > p .heading-fold-marker--paragraph";
    const opacity = () => page.$eval(pMarker, (el) => getComputedStyle(el).opacity);


    // ── 1. Exactly one paragraph marker: the top-level TEXT paragraph only.
    // The fixture also carries an image-only line and a raw-html line — both
    // parse as top-level paragraphs but must NOT get the P marker (MAR-79). ──
    const markerCount = await page.$$eval(".heading-fold-marker--paragraph", (els) => els.length);
    check("only the top-level text paragraph gets a P marker (not image/html blocks)", markerCount === 1, `count=${markerCount}`);
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
    // Async renders after the move (the code block's lazy grammar chunk)
    // clear Chromium's hover chain until the next real input — jiggle to
    // re-establish it. A human's continuous motion does this for free.
    await page.mouse.move(paraBox.x + 1, paraBox.y);
    await page.waitForTimeout(50);
    const subtle = parseFloat(await opacity());
    check("paragraph hover: P at the heading markers' resting contrast", subtle > 0.4 && subtle < 0.7, `opacity=${subtle}`);

    // ── 4. Mousing from the text TO the marker keeps it alive (gap bridge) ──
    // The regression: leaving the paragraph's text box dropped :hover and the
    // marker vanished before it could be clicked. Travel in small steps.
    const markerBox = await page.$eval(pMarker, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const paraLeft = await page.$eval(".ProseMirror > p", (el) => el.getBoundingClientRect().x);
    await page.mouse.move(paraLeft + 4, markerBox.y); // at the text's left edge
    await page.waitForTimeout(80);
    await page.mouse.move(markerBox.x, markerBox.y, { steps: 20 }); // travel the gap
    await page.waitForTimeout(150);
    const arrived = parseFloat(await opacity());
    check("traveling text → marker keeps it visible (full contrast on arrival)", arrived === 1, `opacity=${arrived}`);

    // ── 4b. Generous hit target, glyph unmoved ──
    // The button's border box (hover background + click target) is padded well
    // beyond the glyph, while negative margins keep the glyph's rendered
    // position where the bare text sat: 2px inside the gutter's right edge.
    const markerGeometry = (sel) =>
        page.$eval(sel, (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const glyph = range.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            const gutter = el.parentElement.getBoundingClientRect();
            return {
                padX: box.width - glyph.width,
                padY: box.height - glyph.height,
                glyphInsetFromGutterRight: gutter.right - glyph.right,
            };
        });
    const pGeom = await markerGeometry(pMarker);
    check("P marker box is padded beyond the glyph", pGeom.padX >= 10 && pGeom.padY >= 8,
        `padX=${pGeom.padX.toFixed(1)} padY=${pGeom.padY.toFixed(1)}`);
    check("P glyph stays 2px inside the gutter's right edge",
        Math.abs(pGeom.glyphInsetFromGutterRight - 2) <= 1.5,
        `inset=${pGeom.glyphInsetFromGutterRight.toFixed(1)}`);

    // The marker is hovered right now (step 4 landed on it) — the tooltip is
    // visible and must name the block menu, not the old "text style".
    const tipText = await page.$eval(".custom-tooltip", (el) => el.textContent);
    check("P marker tooltip reads 'Block options'", tipText === "Block options",
        `tooltip=${tipText}`);

    // ── 4c. Heading hash marker: same enlargement, chevron untouched ──
    const hMarker = ".ProseMirror h2 .heading-fold-marker:not(.heading-fold-marker--paragraph)";
    const hGeom = await markerGeometry(hMarker);
    check("## marker box is padded beyond the glyph", hGeom.padX >= 10 && hGeom.padY >= 8,
        `padX=${hGeom.padX.toFixed(1)} padY=${hGeom.padY.toFixed(1)}`);
    check("## glyph stays 2px inside the gutter's right edge",
        Math.abs(hGeom.glyphInsetFromGutterRight - 2) <= 1.5,
        `inset=${hGeom.glyphInsetFromGutterRight.toFixed(1)}`);
    const chevronGap = await page.$eval(hMarker, (el) => {
        const chevron = el.parentElement.querySelector(".heading-fold-toggle");
        if (!chevron) return null;
        return el.getBoundingClientRect().left - chevron.getBoundingClientRect().right;
    });
    check("## marker's enlarged box does not overlap the fold chevron",
        chevronGap !== null && chevronGap >= -0.5, `gap=${chevronGap?.toFixed(1)}`);

    // ── 4d. Every top-level block type carries its glyph marker ──
    // Fixture order: text P, list -, quote >, image ![], html <>, code ```.
    const glyphs = await page.$$eval(".heading-fold-marker--block", (els) =>
        els.map((el) => el.textContent));
    check("block glyph markers cover list/quote/image/html/code",
        JSON.stringify(glyphs) === JSON.stringify(["P", "-", ">", "![]", "<>", "```"]),
        `glyphs=${JSON.stringify(glyphs)}`);

    // Each glyph marker must sit in the LEFT GUTTER of its own block — the
    // in-NodeView anchoring (code block) is the fragile part. Hover the block
    // first so the marker is revealed where geometry is measured.
    for (const [sel, name] of [
        [".ProseMirror > ul", "list"],
        [".ProseMirror > blockquote", "quote"],
        [".ProseMirror > .code-block-wrapper, .ProseMirror > pre", "code"],
    ]) {
        const geom = await page.$eval(sel, (host) => {
            const m = host.querySelector(".heading-fold-marker--block");
            if (!m) return null;
            const hostRect = host.getBoundingClientRect();
            const rect = m.getBoundingClientRect();
            return {
                leftOfBlock: rect.right <= hostRect.left + 2,
                withinBlockY: rect.top >= hostRect.top - 4 && rect.bottom <= hostRect.bottom + 4,
            };
        }).catch(() => null);
        check(`${name} marker sits in its block's left gutter`,
            geom !== null && geom.leftOfBlock && geom.withinBlockY,
            JSON.stringify(geom));
    }

    // Hover the list: its marker reveals at resting contrast.
    const listBox = await page.$eval(".ProseMirror > ul", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(listBox.x, listBox.y);
    await page.waitForTimeout(150);
    await page.mouse.move(listBox.x + 1, listBox.y); // hover-chain jiggle (see check 3)
    await page.waitForTimeout(50);
    const listMarkerOpacity = await page.$eval(
        ".ProseMirror > ul .heading-fold-marker--block",
        (el) => parseFloat(getComputedStyle(el).opacity),
    );
    check("hovering a list reveals its - marker", listMarkerOpacity > 0.4,
        `opacity=${listMarkerOpacity}`);

    // ── 5. Click opens the shared retype menu with P checked ──
    await page.mouse.click(markerBox.x, markerBox.y);
    await page.waitForTimeout(100);
    const menu = await page.$(".block-menu");
    check("clicking P opens the level menu", menu !== null);
    const activeLabel = await page.$eval(
        ".block-menu .block-menu-item--active",
        (el) => el.textContent.trim(),
    );
    check("menu marks P as the current level", activeLabel === "P", `active=${activeLabel}`);

    // ── 6. Picking H2 promotes the paragraph ──
    const rows = await page.$$(".block-menu .block-menu-item");
    await rows[2].dispatchEvent("mousedown"); // P,H1,H2 → index 2
    await page.waitForTimeout(100);
    check("menu closed after pick", (await page.$(".block-menu")) === null);
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
