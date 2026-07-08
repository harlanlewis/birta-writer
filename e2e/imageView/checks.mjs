/**
 * Image NodeView end-to-end checks: alt caption, always-visible title row,
 * path editing (apply on blur / Escape cancels), file-name chip, selection
 * theming, and serialization of every edit into the posted markdown.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".image-wrapper img.image-node", { timeout: 10000 });
    await page.waitForTimeout(400);

    const wrappers = page.locator(".image-wrapper");
    const first = wrappers.nth(0); // ![two cats](img/cats.jpeg "Sleepy tabbies")
    const second = wrappers.nth(1); // ![](img/other.jpeg)
    const updates = () =>
        page.evaluate(() => window.__posted.filter((m) => m.type === "update").map((m) => m.content));

    // ── 1. Caption visibility ────────────────────────────────
    const cap1 = first.locator(".image-caption");
    const cap2 = second.locator(".image-caption");
    check("caption with alt is visible without selection", await cap1.isVisible());
    check("caption value shows the alt text", (await cap1.inputValue()) === "two cats");
    check("empty-alt caption is hidden without selection", !(await cap2.isVisible()));

    await second.locator("img").click();
    await page.waitForTimeout(100);
    check("empty-alt caption is revealed on selection", await cap2.isVisible());
    check("toolbar appears on selection", await second.locator(".image-toolbar").isVisible());
    check(
        "toolbar has no ALT button",
        (await second.locator(".image-toolbar").textContent()).indexOf("ALT") === -1,
    );

    // ── 2. Caption editing: apply on blur ────────────────────
    await cap2.click();
    await cap2.fill("added alt");
    await page.locator(".ProseMirror p").last().click(); // click away → blur
    await page.waitForTimeout(600);
    let posted = await updates();
    check(
        "caption blur committed alt into markdown",
        posted.length > 0 && posted[posted.length - 1].includes("![added alt]("),
        JSON.stringify(posted[posted.length - 1] ?? "(no update)").slice(0, 120),
    );

    // ── 3. Caption Escape reverts ────────────────────────────
    await first.locator("img").click();
    await cap1.click();
    await cap1.fill("should be discarded");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check("Escape restores the original caption text", (await cap1.inputValue()) === "two cats");
    posted = await updates();
    check(
        "Escape did not commit the abandoned caption",
        !posted.some((u) => u.includes("should be discarded")),
    );

    // ── 4. Caption Enter commits ─────────────────────────────
    await cap1.click();
    await cap1.fill("two tabby cats");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "Enter committed the edited caption",
        posted.some((u) => u.includes("![two tabby cats](")),
    );

    // ── 5. Selection theming + phantom-selection suppression ─
    await first.locator("img").click();
    await page.waitForTimeout(150);
    const borderColor = await first.evaluate((el) => getComputedStyle(el).borderColor);
    check("selected border uses the theme focusBorder", borderColor === "rgb(0, 127, 212)", borderColor);
    for (const [name, loc] of [["caption", cap1], ["title row", first.locator(".img-tb-title")]]) {
        const sel = await loc.evaluate((el) => getComputedStyle(el, "::selection").backgroundColor);
        check(
            `${name} suppresses selection paint while the node is selected`,
            sel === "rgba(0, 0, 0, 0)" || sel === "transparent",
            sel,
        );
    }

    // ── 6. Title row: prefill, apply on blur, tooltip + markdown ──
    const pencil = first.locator('.image-toolbar button[aria-label="Edit Image Path"]');
    const titleRow = first.locator(".img-tb-title");
    check("title row is visible in the toolbar before any editing", await titleRow.isVisible());
    check("title row prefills from the markdown title", (await titleRow.inputValue()) === "Sleepy tabbies");
    await pencil.dispatchEvent("mousedown");
    const pathInput = first.locator(".img-path-input");
    await pathInput.waitFor({ state: "visible", timeout: 3000 });
    check("path editor opens with the relative path", (await pathInput.inputValue()) === "img/cats.jpeg");
    check("title row stays visible during path editing", await titleRow.isVisible());
    const editButtons = await first
        .locator(".image-toolbar button")
        .evaluateAll((els) => els.filter((el) => el.style.display !== "none").length);
    check("path edit mode shows no confirm/cancel buttons", editButtons === 0, `${editButtons} visible buttons`);

    await pathInput.fill("img/other.jpeg");
    await page.locator(".ProseMirror p").last().click(); // blur → apply
    await page.waitForTimeout(800);
    const src1 = await first.locator("img").getAttribute("src");
    check("path applied on blur (img src switched)", src1 === `${baseUrl}/img/other.jpeg`, src1);
    check("path editor closed after blur", (await first.locator(".img-path-input").count()) === 0);

    await first.locator("img").click();
    await titleRow.waitFor({ state: "visible", timeout: 3000 });
    await titleRow.fill("Edited via panel");
    await page.locator(".ProseMirror p").last().click(); // blur → apply
    await page.waitForTimeout(800);
    const imgTitle = await first.locator("img").getAttribute("title");
    check("title applied to the image tooltip", imgTitle === "Edited via panel", JSON.stringify(imgTitle));
    posted = await updates();
    check(
        "title serialized into the markdown",
        posted.some((u) => u.includes('img/other.jpeg "Edited via panel"')),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 140),
    );

    // ── 7. Title round-trip edges: clearing, quotes ──────────
    await first.locator("img").click();
    await titleRow.fill("");
    await page.locator(".ProseMirror p").last().click();
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "clearing the title drops it from the markdown (no empty quotes)",
        posted.some((u) => u.includes("img/other.jpeg)\n")) &&
            !posted[posted.length - 1].includes('""'),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 140),
    );
    await first.locator("img").click();
    await titleRow.fill('a "quoted" title');
    await page.locator(".ProseMirror p").last().click();
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "a title containing quotes serializes escaped",
        posted.some((u) => u.includes('img/other.jpeg "a \\"quoted\\" title"')),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 140),
    );

    // ── 8. Path edit: Escape cancels ─────────────────────────
    await first.locator("img").click();
    await pencil.dispatchEvent("mousedown");
    await pathInput.waitFor({ state: "visible", timeout: 3000 });
    await pathInput.fill("img/cats.jpeg");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const srcAfterEsc = await first.locator("img").getAttribute("src");
    check("Escape cancels the path edit", srcAfterEsc === `${baseUrl}/img/other.jpeg`, srcAfterEsc);
    check("path editor closed after Escape", (await first.locator(".img-path-input").count()) === 0);

    // ── 9. File-name chip ────────────────────────────────────
    await first.locator("img").click();
    const chip = first.locator(".img-tb-path");
    check("chip shows the file name", (await chip.locator(".img-tb-path-name").textContent()) === "other.jpeg");
    check("chip carries a pencil glyph", (await chip.locator(".img-tb-path-pencil svg").count()) === 1);
    check(
        "controls row has exactly the chip, zoom, and delete buttons",
        (await first.locator(".image-toolbar-row > button").count()) === 3,
    );
    await chip.dispatchEvent("mousedown");
    check("clicking the file-name chip opens the path editor", await first.locator(".img-path-input").isVisible());
    check("chip-opened editor prefills the path", (await first.locator(".img-path-input").inputValue()) === "img/other.jpeg");
    await page.keyboard.press("Escape");

    // ── 10. Typing in the doc still works (regression) ───────
    await page.locator(".ProseMirror p").last().click();
    await page.waitForTimeout(150); // let ProseMirror settle the click's text selection
    await page.keyboard.type(" appended");
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "normal typing in the document still serializes",
        posted.some((u) => u.includes("tail text appended")),
    );
}
