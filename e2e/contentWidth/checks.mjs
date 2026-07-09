/**
 * Content-width segmented control (MAR-51) end-to-end checks against the real
 * bundle: the typography (A) menu carries a Full Width / Fixed Width segmented
 * control above "Font settings"; picking Fixed Width caps the document
 * (`--editor-max-width` px + no full-width body class) and Full Width restores
 * the pane-filling layout. Choices post a `setContentWidth` message.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const fontWrap = page.locator('[data-item-id="fontPreset"]');
    check("the typography (A) menu item renders", (await fontWrap.count()) > 0);

    // Open the hover menu (wireHoverMenu opens on mouseenter of the wrap).
    await fontWrap.dispatchEvent("mouseenter");
    await page.waitForTimeout(150);

    const segButtons = page.locator(".tb-font-menu .tb-seg-btn");
    const segCount = await segButtons.count();
    check("a two-button segmented control renders in the menu", segCount === 2, `count=${segCount}`);

    const labels = await segButtons.allTextContents();
    check(
        "the segments read Full Width / Fixed",
        labels.join("|") === "Full Width|Fixed",
        labels.join("|"),
    );

    // Labels must never wrap to a second line.
    const singleLine = await page.evaluate(() => {
        const btns = [...document.querySelectorAll(".tb-font-menu .tb-seg-btn")];
        return btns.every((b) => {
            const cs = getComputedStyle(b);
            return cs.whiteSpace === "nowrap" && b.offsetHeight <= 28;
        });
    });
    check("the segment labels stay on a single line (no wrap)", singleLine);

    // The segmented control sits above the "Font settings" row.
    const orderOk = await page.evaluate(() => {
        const menu = document.querySelector(".tb-font-menu");
        if (!menu) return false;
        const seg = menu.querySelector(".tb-seg-row");
        const settings = [...menu.querySelectorAll(".tb-fmt-item")].find(
            (el) => el.textContent.trim() === "Font settings",
        );
        if (!seg || !settings) return false;
        return seg.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    check("the width control sits above the Font settings row", !!orderOk);

    // Default: Full Width active.
    const fullBtn = segButtons.nth(0);
    const fixedBtn = segButtons.nth(1);
    check(
        "Full Width is active by default",
        (await fullBtn.getAttribute("class")).includes("tb-seg-btn--on"),
    );

    const maxWidth = () =>
        page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-max-width").trim());
    const hasAutoClass = () => page.evaluate(() => document.body.classList.contains("editor-width-auto"));
    const lastWidthMsg = () =>
        page.evaluate(() => {
            const m = window.__posted.filter((x) => x.type === "setContentWidth");
            return m.length ? m[m.length - 1] : null;
        });

    // ── Click Fixed ──
    await fixedBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(100);
    check("Fixed sets --editor-max-width to 100ch (from maxContentWidth)", (await maxWidth()) === "100ch", await maxWidth());
    check("Fixed removes the full-width body class", (await hasAutoClass()) === false);
    check(
        "Fixed marks the Fixed segment active",
        (await fixedBtn.getAttribute("class")).includes("tb-seg-btn--on"),
    );
    check(
        "Fixed posts setContentWidth mode=fixed",
        (await lastWidthMsg())?.mode === "fixed",
        JSON.stringify(await lastWidthMsg()),
    );

    // The frontmatter panel and the editor must cap to the SAME width even
    // though the panel uses the UI font and #editor the content font — the
    // panel resolves its ch cap against the content font so the edges align.
    // (The harness uses a monospace content font vs a proportional UI font, so
    // this would diverge without that alignment.)
    const widthMatch = await page.evaluate(() => {
        const editor = document.querySelector("#editor");
        const panel = document.querySelector("#frontmatter-panel");
        if (!editor || !panel) return { ok: false, reason: "missing element" };
        const ew = editor.getBoundingClientRect().width;
        const pw = panel.getBoundingClientRect().width;
        return { ok: Math.abs(ew - pw) <= 1, ew: Math.round(ew), pw: Math.round(pw) };
    });
    check(
        "the frontmatter panel caps to the same width as the editor",
        widthMatch.ok,
        `editor=${widthMatch.ew} panel=${widthMatch.pw}`,
    );

    // ...but the metadata VALUES stay in the UI font (Arial here), not the
    // content/editor font (Courier) the box borrows only for its ch width.
    const valueFont = await page.evaluate(() => {
        const val = document.querySelector("#frontmatter-panel .fm-val, #frontmatter-panel td:not(.fm-key)");
        return val ? getComputedStyle(val).fontFamily : null;
    });
    check(
        "frontmatter values render in the UI font, not the content font",
        !!valueFont && /arial|helvetica|sans-serif/i.test(valueFont) && !/courier/i.test(valueFont),
        String(valueFont),
    );

    // ── Click Full Width ──
    await fullBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(100);
    check("Full Width sets --editor-max-width to none", (await maxWidth()) === "none", await maxWidth());
    check("Full Width restores the full-width body class", (await hasAutoClass()) === true);
    check(
        "Full Width posts setContentWidth mode=full",
        (await lastWidthMsg())?.mode === "full",
        JSON.stringify(await lastWidthMsg()),
    );
}
