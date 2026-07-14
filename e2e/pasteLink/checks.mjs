/**
 * Paste-URL-onto-selection end-to-end checks against the real bundle: pasting a
 * URL over a selected word wraps that word in a link (rather than replacing it),
 * opens the link edit palette prefilled with the pasted URL, and covers the
 * bare-domain case and the negative case (non-URL text still replaces).
 * Outbound edits land in window.__posted as `update` messages.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const updates = () =>
        page.evaluate(() => window.__posted.filter((m) => m.type === "update").map((m) => m.content));
    const paletteVisible = () => page.locator(".lp-root").isVisible();

    const para = page.locator(".ProseMirror p").first();
    await para.click();
    // See e2e/linkEditor/checks.mjs: wait past the browser's multi-click window
    // so each dblclick selects exactly one word (never coalesces into a triple
    // click that would select the whole block). Re-fetch the box each time — a
    // prior edit can shift the paragraph's geometry. Returns the selected text.
    const selectWord = async (dx) => {
        await page.waitForTimeout(700);
        const box = await para.boundingBox();
        await page.mouse.dblclick(box.x + dx, box.y + box.height / 2);
        await page.waitForTimeout(150);
        return page.evaluate(() => window.getSelection().toString().trim());
    };

    // Dispatch a synthetic paste carrying `text` as text/plain onto the editor —
    // ProseMirror's paste handler routes it to our handlePaste prop. The event
    // bubbles/goes through capture so the editor's interaction tracker marks the
    // document dirty (otherwise no `update` would post).
    const pasteText = (text) =>
        page.evaluate((t) => {
            const el = document.querySelector(".milkdown .ProseMirror");
            const dt = new DataTransfer();
            dt.setData("text/plain", t);
            el.dispatchEvent(new ClipboardEvent("paste", {
                clipboardData: dt, bubbles: true, cancelable: true,
            }));
        }, text);

    // ── 1. Scheme URL over a selection → link + palette prefilled ──
    const sel = await selectWord(40); // "quick"
    check("a word is selected", sel.length > 0, JSON.stringify(sel));

    await pasteText("https://example.com");
    await page.waitForSelector(".lp-root", { state: "visible", timeout: 3000 }).catch(() => {});
    check("pasting a URL opens the link palette", await paletteVisible());
    const urlVal = await page.locator(".lp-root .lp-url-input").inputValue().catch(() => "");
    check("the palette is prefilled with the pasted URL", urlVal === "https://example.com", JSON.stringify(urlVal));

    await page.keyboard.press("Escape");
    await page.waitForTimeout(1300); // past the autosave debounce
    let posted = await updates();
    check(
        "the selection is wrapped in a link (text preserved, not replaced)",
        posted.some((u) => u.includes("[quick](https://example.com)")),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 120),
    );

    // ── 2. Bare web domain (no scheme) over a selection → link ──
    const sel2 = await selectWord(85); // "brown"
    check("a second word is selected", sel2.length > 0, JSON.stringify(sel2));
    await pasteText("example.org");
    await page.waitForSelector(".lp-root", { state: "visible", timeout: 3000 }).catch(() => {});
    check("pasting a bare domain opens the link palette", await paletteVisible());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1300);
    posted = await updates();
    check(
        "a bare domain links the selection verbatim (no scheme prepended)",
        posted.some((u) => u.includes("[brown](example.org)")),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 120),
    );

    // ── 3. Negative: non-URL text still replaces the selection ──
    const sel3 = await selectWord(120); // "fox"
    check("a third word is selected", sel3.length > 0, JSON.stringify(sel3));
    const beforeNeg = (await updates()).length;
    await pasteText("plain-word");
    await page.waitForTimeout(300);
    check("pasting plain text does NOT open the link palette", !(await paletteVisible()));
    await page.waitForTimeout(1300);
    posted = await updates();
    const last = posted[posted.length - 1] ?? "";
    check(
        "plain text replaced the selection (the word is gone, no link added)",
        (await updates()).length > beforeNeg &&
            last.includes("plain-word") &&
            !last.includes("(plain-word)"),
        JSON.stringify(last).slice(0, 140),
    );
}
