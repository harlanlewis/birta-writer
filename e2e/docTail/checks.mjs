/**
 * The document tail: the overscroll band under the last block, and the hint an
 * empty line carries.
 *
 * Both are layout, so jsdom cannot answer either. The overscroll is stated as a
 * viewport fraction, and what a `vh` padding actually does to the scroll range
 * depends on how `min-height` and `box-sizing` compose with it — the short
 * document is in here precisely because that composition is what decides
 * whether a one-line file grows a scrollbar it has no content for.
 *
 * The hint is a widget inside the decorated paragraph, so the things worth
 * pinning are the ones only a rendered widget can get wrong: that it costs the
 * paragraph no height, that its key inherits the document's inline-code chip
 * rather than a look of its own, and that it is gated on the editor actually
 * having focus. The plugin's own rule (which paragraph earns it) is a unit
 * test — webview/__tests__/emptyLineHint.test.ts.
 */
export async function run({ page, check, baseUrl }) {
    const boot = async (query = "") => {
        await page.goto(`${baseUrl}/index.html${query}`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /Tail/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
    };

    // ── 1. The overscroll band ───────────────────────────────
    await boot();

    const band = await page.evaluate(() => {
        const editor = document.querySelector("#editor");
        return {
            paddingBottom: parseFloat(getComputedStyle(editor).paddingBottom),
            viewport: window.innerHeight,
        };
    });
    check("the tail band is half the viewport",
        Math.abs(band.paddingBottom - band.viewport * 0.5) <= 1,
        `${band.paddingBottom} vs ${band.viewport * 0.5}`);

    // What the band is FOR: the last line can be scrolled up to the top of the
    // window. Measured as scroll range past the last block rather than as
    // padding, because padding under a `min-height` need not become scroll.
    const room = await page.evaluate(() => {
        const blocks = document.querySelectorAll(".ProseMirror > *");
        const last = blocks[blocks.length - 1].getBoundingClientRect();
        const contentBottom = last.bottom + window.scrollY;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        return { past: maxScroll + window.innerHeight - contentBottom, viewport: window.innerHeight };
    });
    check("the last block can be scrolled up into the middle of the window",
        room.past >= room.viewport * 0.45, `${room.past.toFixed(0)}px past, viewport ${room.viewport}`);

    // ── 2. A document shorter than the viewport keeps its lack of scrollbar ──
    await boot("?doc=short");
    const shortDoc = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
    }));
    check("a document shorter than the window gains no scroll range",
        shortDoc.scrollHeight <= shortDoc.viewport + 1,
        `${shortDoc.scrollHeight} vs ${shortDoc.viewport}`);

    // The band is empty space, not dead space: it is still #editor's padding,
    // so the click-outside-the-content handler owns it (webview/index.ts). A
    // short document is the one where all of it is on screen at once.
    const target = await page.evaluate(() => {
        const blocks = document.querySelectorAll(".ProseMirror > *");
        const last = blocks[blocks.length - 1].getBoundingClientRect();
        return { x: last.x + last.width / 2, y: last.bottom + 200 };
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(150);
    const caret = await page.evaluate(() => {
        const sel = window.getSelection();
        const blocks = document.querySelectorAll(".ProseMirror > *");
        const last = blocks[blocks.length - 1];
        return {
            inLastBlock: last.contains(sel.anchorNode),
            atTextEnd: sel.anchorOffset === (sel.anchorNode?.nodeValue?.length ?? -1),
        };
    });
    check("clicking deep in the band puts the caret at the end of the document",
        caret.inLastBlock && caret.atTextEnd, JSON.stringify(caret));

    // ── 3. The empty-line hint ───────────────────────────────
    await boot();

    /** The hinted paragraph's own facts, plus its widget's. */
    const hint = () => page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .md-empty-hint");
        if (!el) return null;
        const widget = el.querySelector(".md-empty-hint-text");
        const style = widget && getComputedStyle(widget);
        const key = widget?.querySelector("code");
        return {
            count: document.querySelectorAll(".ProseMirror .md-empty-hint").length,
            text: widget?.textContent ?? null,
            key: key?.textContent ?? null,
            // The key's chip is the document's own inline-code ground, which is
            // the whole point of it being a `code` element.
            keyGround: key && getComputedStyle(key).backgroundColor,
            keyFont: key && getComputedStyle(key).fontFamily,
            keyStyle: key && getComputedStyle(key).fontStyle,
            height: el.getBoundingClientRect().height,
            display: style?.display,
            position: style?.position,
            fontStyle: style?.fontStyle,
            opacity: style ? parseFloat(style.opacity) : null,
        };
    });

    // Enter at the end of the last paragraph — the gesture the hint exists for.
    // The caret goes there by DOM range rather than by End, which Chromium
    // hands to the scroller while anything remains to scroll — and the band
    // this suite is about guarantees something does.
    await page.evaluate(() => {
        const ps = document.querySelectorAll(".milkdown .ProseMirror > p");
        const walker = document.createTreeWalker(ps[ps.length - 1], NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        document.querySelector(".ProseMirror").focus();
        const range = document.createRange();
        range.setStart(node, node.nodeValue.length);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);

    const shown = await hint();
    check("a new empty line carries exactly one hint", shown?.count === 1, JSON.stringify(shown));
    check("the hint names the slash menu",
        shown?.text === "press / to show commands", shown?.text);
    check("the hint is painted", shown?.display !== "none", shown?.display);
    check("the hint is italic and low contrast",
        shown?.fontStyle === "italic" && shown?.opacity < 0.5,
        `${shown?.fontStyle} at ${shown?.opacity}`);
    // The key is a real code element, so it takes the document's inline-code
    // chip: a ground of its own and the editor's mono face, upright inside an
    // italic sentence. A span with a class of its own could drift from what a
    // backtick in the prose above it looks like; this cannot.
    check("the key is the slash", shown?.key === "/", shown?.key);
    check("the key wears the document's inline code chip",
        shown?.keyGround !== "rgba(0, 0, 0, 0)" && /mono/i.test(shown?.keyFont ?? ""),
        `${shown?.keyGround} ${shown?.keyFont}`);
    check("the key stays upright inside the italic sentence",
        shown?.keyStyle === "normal", shown?.keyStyle);
    check("the hint is out of flow, so it cannot move the caret",
        shown?.position === "absolute", shown?.position);

    // ── 4. One character removes it, and the paragraph does not resize ──
    await page.keyboard.type("a");
    await page.waitForTimeout(100);
    const typedHeight = await page.evaluate(
        () => document.querySelector(".ProseMirror > p:last-of-type").getBoundingClientRect().height);
    check("typing a character removes the hint", (await hint()) === null);
    check("the hinted line is exactly as tall as the same line with text in it",
        Math.abs(typedHeight - shown.height) <= 0.5, `${shown.height} vs ${typedHeight}`);

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);
    check("emptying the line brings the hint back", (await hint())?.count === 1);

    // The slash is a character like any other: the menu it opens takes over.
    await page.keyboard.type("/");
    await page.waitForTimeout(200);
    check("the slash that opens the menu removes the hint", (await hint()) === null);
    check("the slash menu is open", await page.isVisible("#md-slash-menu"));

    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);

    // ── 5. Focus gating ──────────────────────────────────────
    check("the hint is back before the focus check", (await hint())?.count === 1);
    await page.evaluate(() => document.querySelector(".ProseMirror").blur());
    await page.waitForTimeout(100);
    const blurred = await hint();
    check("a document nobody is typing in shows no hint",
        blurred?.display === "none", blurred?.display);
    check("the decoration itself survives the blur — only the paint is gated",
        blurred?.count === 1, JSON.stringify(blurred));
}
