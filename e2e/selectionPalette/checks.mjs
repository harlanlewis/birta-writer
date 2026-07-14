/**
 * Floating selection palette end-to-end checks against the real bundle:
 *   - inline math is grouped with the marks (right after inline code);
 *   - the turn-into (P/H1–H6) dropdown shows for a whole-block selection but
 *     hides for a substring;
 *   - a mark already on the selection lights its button (active state);
 *   - the palette re-anchors when the editor content reflows (ResizeObserver);
 *   - opening the block (handle) menu dismisses the palette.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const toolbar = page.locator(".sel-toolbar");
    // The turn-into dropdown and the table-alignment dropdown share the wrap
    // class; the turn-into one is the only one carrying the P/H-level label.
    const fmtWrap = page.locator(".sel-toolbar .sel-tb-fmt-wrap:has(.sel-tb-fmt-label)");

    // Center-point of the first occurrence of `word` in the editor, via a Range
    // rect — robust to font/measure differences.
    const wordPoint = (word) =>
        page.evaluate((w) => {
            const pm = document.querySelector(".milkdown .ProseMirror");
            const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const idx = node.textContent.indexOf(w);
                if (idx >= 0) {
                    const r = document.createRange();
                    r.setStart(node, idx);
                    r.setEnd(node, idx + w.length);
                    const rect = r.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
            }
            return null;
        }, word);

    const selectWord = async (word) => {
        await page.waitForTimeout(700); // clear the browser multi-click window
        const p = await wordPoint(word);
        if (!p) throw new Error(`word not found: ${word}`);
        await page.mouse.dblclick(p.x, p.y);
        await page.waitForTimeout(150);
        return page.evaluate(() => window.getSelection().toString().trim());
    };

    const selectWholeParagraph = async () => {
        await page.waitForTimeout(700);
        const p = await wordPoint("plain");
        await page.mouse.click(p.x, p.y, { clickCount: 3 });
        await page.waitForTimeout(150);
    };

    // ── 1. Inline math is grouped with the marks (after inline code) ──
    // The bar is built at setup, so its DOM order is assertable without a
    // selection. aria-labels carry a trailing shortcut for some buttons, so
    // match on the leading name.
    const mathNeighbors = await page.evaluate(() => {
        const bar = document.querySelector(".sel-toolbar");
        const label = (el) => el?.getAttribute("aria-label") ?? "";
        const math = [...bar.querySelectorAll(".sel-tb-btn")].find((b) =>
            label(b).startsWith("Inline Math"));
        return {
            prev: label(math?.previousElementSibling),
            next: label(math?.nextElementSibling),
        };
    });
    check(
        "inline math sits between inline code and highlight",
        mathNeighbors.prev.startsWith("Inline Code") && mathNeighbors.next.startsWith("Highlight"),
        JSON.stringify(mathNeighbors),
    );

    // ── 2. Substring selection → format (turn-into) dropdown hidden ──
    const w = await selectWord("plain");
    check("a substring word is selected", w === "plain", JSON.stringify(w));
    check("the palette is visible for the substring", await toolbar.isVisible());
    check(
        "the turn-into dropdown is HIDDEN for a substring selection",
        !(await fmtWrap.isVisible()),
    );

    // Inverted chip: the palette ground is the editor FOREGROUND (harness
    // --vscode-editor-foreground = #d4d4d4), reversing contrast like the tooltip.
    const paletteBg = await page.evaluate(
        () => getComputedStyle(document.querySelector(".sel-toolbar")).backgroundColor,
    );
    check(
        "the palette uses the inverted (editor-foreground) ground",
        paletteBg === "rgb(212, 212, 212)",
        paletteBg,
    );

    // ── 3. Whole-block selection → format dropdown shown ──
    await selectWholeParagraph();
    check("the palette is visible for the whole block", await toolbar.isVisible());
    check(
        "the turn-into dropdown is SHOWN for a whole-block selection",
        await fmtWrap.isVisible(),
    );

    // ── 4. Active state: selecting the bold word lights the Bold button ──
    const b = await selectWord("bold");
    check("the bold word is selected", b === "bold", JSON.stringify(b));
    const boldActive = await page.evaluate(() => {
        const bar = document.querySelector(".sel-toolbar");
        const bold = [...bar.querySelectorAll(".sel-tb-btn")].find((el) =>
            (el.getAttribute("aria-label") ?? "").startsWith("Bold"));
        const italic = [...bar.querySelectorAll(".sel-tb-btn")].find((el) =>
            (el.getAttribute("aria-label") ?? "").startsWith("Italic"));
        return {
            bold: bold?.classList.contains("sel-tb-btn--active"),
            italic: italic?.classList.contains("sel-tb-btn--active"),
        };
    });
    check("the Bold button is lit for bold text", boldActive.bold === true);
    check("the Italic button is NOT lit for bold text", boldActive.italic === false);

    // ── 5. Reflow: the palette re-anchors when the editor content resizes ──
    const before = await toolbar.boundingBox();
    await page.evaluate(() => {
        // Shrink the editor content box — the ToC docking/resizing does this in
        // the real app; a ResizeObserver on the content should re-anchor the bar.
        const pm = document.querySelector(".milkdown .ProseMirror");
        pm.style.maxWidth = "320px";
        pm.style.marginLeft = "200px";
    });
    await page.waitForTimeout(200);
    const after = await toolbar.boundingBox();
    check(
        "the palette re-anchors after the editor content reflows",
        Boolean(before && after) && Math.abs(after.x - before.x) > 1,
        JSON.stringify({ beforeX: before?.x, afterX: after?.x }),
    );

    // ── 6. Opening the block (handle) menu dismisses the palette ──
    await selectWord("bold"); // palette up again
    check("the palette is visible before opening the block menu", await toolbar.isVisible());
    await page.locator(".heading-fold-marker").first().click({ force: true });
    await page.waitForSelector(".block-menu", { state: "visible", timeout: 3000 }).catch(() => {});
    const menuOpen = await page.locator(".block-menu").isVisible();
    check("clicking the gutter marker opens the block menu", menuOpen);
    await page.waitForTimeout(100); // let the menu's search input focus (focusin → hide)
    check(
        "opening the block menu dismisses the floating palette",
        !(await toolbar.isVisible()),
    );
}
