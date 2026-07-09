/**
 * Link editor end-to-end checks against the real bundle: the toolbar link
 * button opens the single link editor (the hover popup) anchored at the
 * selected text, keeps that text visibly highlighted while open (pending-range
 * decoration), applies on Enter, cancels on Escape, and carries no
 * confirm/cancel buttons. Outbound edits land in window.__posted as `update`
 * messages.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const updates = () =>
        page.evaluate(() => window.__posted.filter((m) => m.type === "update").map((m) => m.content));
    const editorVisible = () => page.locator(".lp-root").isVisible();
    const openEditor = () => page.waitForSelector(".lp-root", { state: "visible", timeout: 3000 });

    const linkItem = page.locator('[data-item-id="link"] button');
    const linkBtnFallback = page.locator(".editor-topbar button").first();
    const clickLinkButton = async () => {
        if (await linkItem.count()) {
            await linkItem.dispatchEvent("mousedown");
        } else {
            await linkBtnFallback.dispatchEvent("mousedown");
        }
    };

    // Select the word "quick" in the paragraph by double-clicking it.
    const para = page.locator(".ProseMirror p").first();
    await para.click();
    const box = await para.boundingBox();
    await page.mouse.dblclick(box.x + 40, box.y + box.height / 2);
    await page.waitForTimeout(150);
    const selText = await page.evaluate(() => window.getSelection().toString());
    check("a word is selected in the document", selText.trim().length > 0, JSON.stringify(selText));

    // ── 1. Open the editor via the toolbar link button ──
    await clickLinkButton();
    const popup = await openEditor();
    check("clicking the link button opens the link editor", !!popup);

    // ── 2. No ✓/✕ confirm-cancel buttons (house apply-on-blur pattern) ──
    const hasConfirmCancel = await page.evaluate(() => {
        const p = document.querySelector(".lp-root");
        return [...p.querySelectorAll("button")].some((b) =>
            /confirm|cancel|\bok\b/i.test(b.className),
        );
    });
    check("the link editor has no ✓/✕ confirm-cancel buttons", !hasConfirmCancel);

    // ── 3. Anchored near the target text, not at the toolbar top ──
    // (Measured against the pending-range highlight: the document selection
    // collapses to nothing once focus moves into the popup input.)
    const geom = await page.evaluate(() => {
        const p = document.querySelector(".lp-root").getBoundingClientRect();
        const tb = document.querySelector(".editor-topbar").getBoundingClientRect();
        const hl = document.querySelector(".ProseMirror .pending-range").getBoundingClientRect();
        return { pTop: p.top, tbBottom: tb.bottom, hlBottom: hl.bottom };
    });
    check(
        "the editor sits near the target text, well under the toolbar",
        geom.pTop > geom.tbBottom + 20 && Math.abs(geom.pTop - geom.hlBottom) < 80,
        `editorTop=${Math.round(geom.pTop)} toolbarBottom=${Math.round(geom.tbBottom)} textBottom=${Math.round(geom.hlBottom)}`,
    );

    // ── 4. The target text stays highlighted (pending-range decoration) ──
    const pendingCount = await page.locator(".ProseMirror .pending-range").count();
    check("the link target text is highlighted while the editor is open", pendingCount >= 1, `${pendingCount} spans`);
    const pendingBg = await page.locator(".ProseMirror .pending-range").first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    check("the highlight paints the theme selection color", pendingBg !== "rgba(0, 0, 0, 0)" && pendingBg !== "transparent", pendingBg);

    // ── 5. Escape cancels: no update, highlight cleared ──
    const beforeEsc = (await updates()).length;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("Escape closes the editor", !(await editorVisible()));
    check("Escape clears the pending-range highlight", (await page.locator(".ProseMirror .pending-range").count()) === 0);
    check("Escape posted no document update", (await updates()).length === beforeEsc);

    // ── 6. Reopen, type a URL, Enter applies → link serialized ──
    await page.mouse.dblclick(box.x + 40, box.y + box.height / 2);
    await page.waitForTimeout(150);
    await clickLinkButton();
    await openEditor();
    const url = page.locator(".lp-root .lp-url-input");
    await url.click();
    await url.fill("https://example.com");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1300); // past the autosave debounce
    let posted = await updates();
    check(
        "Enter applies the link into the markdown",
        posted.some((u) => u.includes("(https://example.com)")),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 120),
    );
    check("editor closed after Enter", !(await editorVisible()));
    check("pending-range cleared after apply", (await page.locator(".ProseMirror .pending-range").count()) === 0);

    // ── 7. Blur-out with no change is a no-op (does not dirty the doc) ──
    await page.mouse.dblclick(box.x + 200, box.y + box.height / 2); // select another word
    await page.waitForTimeout(150);
    await clickLinkButton();
    await openEditor();
    const nUpdatesBeforeBlur = (await updates()).length;
    // Click into the document (outside the popup) → outside-click applies, but
    // nothing changed so it must be a no-op.
    await page.locator(".ProseMirror p").first().click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);
    check("blur-out closes the editor", !(await editorVisible()));
    check(
        "blur-out with no change posts no update",
        (await updates()).length === nUpdatesBeforeBlur,
        `${nUpdatesBeforeBlur} → ${(await updates()).length}`,
    );
}
