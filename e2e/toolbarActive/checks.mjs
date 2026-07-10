/**
 * Toolbar active-state matrix — real-browser verification that the top bar
 * reflects exactly where the caret is. jsdom can't hit-test clicks or focus a
 * contenteditable island, so the runtime-only truths live here:
 *   - which bar buttons carry .tb-btn--active for each caret context,
 *   - the Format control's label (P / H1 / "—") and its menu row FILLING
 *     (.tb-fmt-item--on) rather than a checkmark (.menu-check must be gone),
 *   - inline atoms (wikilink / inline math) and a selected image lighting their
 *     button off a NodeSelection,
 *   - focusing a callout title (a contenteditable island outside ProseMirror)
 *     BLANKING the bar instead of asserting the stale block ("P in a title" bug).
 *
 * The pure derivation is unit-tested (webview/__tests__/toolbarActiveState.test.ts);
 * this guards the DOM wiring the unit test can't reach.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector('[data-item-id="format"] .tb-fmt-label', { timeout: 10000 });
    await page.waitForTimeout(300); // let NodeViews (math/callout/image) mount

    // ── Helpers ──────────────────────────────────────────────────────────────
    // Which item-ids currently carry an active bar button (works even for buttons
    // parked in the ⋯ overflow menu — the class is still queryable there).
    const activeIds = () =>
        page.$$eval(".tb-btn--active", (els) =>
            els
                .map((e) => e.closest("[data-item-id]")?.getAttribute("data-item-id"))
                .filter(Boolean)
                .sort(),
        );
    const fmtLabel = () =>
        page.$eval('[data-item-id="format"] .tb-fmt-label', (e) => e.textContent.trim());
    const fmtDisabled = () =>
        page.$eval('[data-item-id="format"] .tb-fmt-wrap', (e) =>
            e.classList.contains("tb-fmt-wrap--disabled"),
        );
    // Filled (active) menu rows scoped to one picker, by their label text.
    const filled = (itemId, onClass, labelClass) =>
        page.$$eval(
            `[data-item-id="${itemId}"] .${onClass}`,
            (els, lc) => els.map((e) => (e.querySelector("." + lc) ?? e).textContent.trim()),
            labelClass,
        );

    // Place the caret by clicking the middle of the first DOM text run containing
    // `needle` (offset a couple chars in so we land inside marks/containers).
    async function clickText(needle) {
        const box = await page.evaluate((needle) => {
            const walk = document.createTreeWalker(
                document.querySelector(".ProseMirror"),
                NodeFilter.SHOW_TEXT,
            );
            let n;
            while ((n = walk.nextNode())) {
                const i = n.textContent.indexOf(needle);
                if (i >= 0) {
                    const r = document.createRange();
                    r.setStart(n, i + Math.min(2, needle.length));
                    r.setEnd(n, i + Math.min(3, needle.length));
                    const rect = r.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
            }
            return null;
        }, needle);
        if (!box) throw new Error(`text not found: ${needle}`);
        await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(80);
    }
    async function clickSelector(sel) {
        const el = await page.$(sel);
        if (!el) throw new Error(`selector not found: ${sel}`);
        await el.click();
        await page.waitForTimeout(80);
    }
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Node-select an inline atom the way a user does with the keyboard: anchor the
    // caret in the text just after it, then ArrowLeft onto it — ProseMirror turns
    // arrowing onto an atom into a NodeSelection. (Clicking inline math instead
    // opens its LaTeX popover; the view swallows mousedown, so a click can't select
    // it.) Loop until `itemId` lights so we don't depend on the exact caret offset.
    async function arrowSelectAtomAfter(anchorText, itemId) {
        await clickText(anchorText);
        for (let i = 0; i < 12; i++) {
            if ((await activeIds()).includes(itemId)) return;
            await page.keyboard.press("ArrowLeft");
            await page.waitForTimeout(30);
        }
    }

    // ── 1. Heading: label H1, menu row FILLED, and no checkmark column ──
    await clickText("Heading One");
    check("heading → format label H1", (await fmtLabel()) === "H1", `label=${await fmtLabel()}`);
    check("heading → H1 menu row is filled", (await filled("format", "tb-fmt-item--on", "x")).includes("H1"));
    const checks = await page.$$eval('[data-item-id="format"] .menu-check', (e) => e.length);
    check("Format menu has NO checkmark column (fill idiom)", checks === 0, `menu-check=${checks}`);
    check("heading → no bar buttons active", eq(await activeIds(), []));

    // ── 2. Plain paragraph ──
    await clickText("paragraph with");
    check("paragraph → format label P", (await fmtLabel()) === "P", `label=${await fmtLabel()}`);
    check("paragraph → P row filled", (await filled("format", "tb-fmt-item--on", "x")).includes("P"));
    check("paragraph → format applicable (enabled)", (await fmtDisabled()) === false);

    // ── 3. Real markdown link (a mark): Link button lights, per-char caret ──
    await clickText("regular link");
    check("inside real link → link active", (await activeIds()).includes("link"));
    check("inside real link → format still P (link is a mark on text)", (await fmtLabel()) === "P");

    // ── 4. Wikilink atom (node-selected by clicking it): Link button lights ──
    await clickSelector(".ProseMirror a.wiki-link");
    check("selected wikilink → link active", (await activeIds()).includes("link"), `active=${JSON.stringify(await activeIds())}`);
    check("selected wikilink → format N/A (—)", (await fmtLabel()) === "—");

    // ── 5. Inline-math atom (arrow onto it): Math button lights ──
    await arrowSelectAtomAfter("math and a", "math");
    check("selected inline math → math active", (await activeIds()).includes("math"), `active=${JSON.stringify(await activeIds())}`);
    check("selected inline math → format N/A (—)", (await fmtLabel()) === "—");

    // ── 6. Lists (bullet / task / ordered): trigger active + exact row filled ──
    await clickText("bullet item");
    check("bullet → listMenu active", (await activeIds()).includes("listMenu"));
    check("bullet → Bullet List row filled", (await filled("listMenu", "tb-list-item--on", "tb-list-item-label")).includes("Bullet List"));
    await clickText("task item");
    check("task → Task List row filled", (await filled("listMenu", "tb-list-item--on", "tb-list-item-label")).includes("Task List"));
    await clickText("ordered item");
    check("ordered → Ordered List row filled", (await filled("listMenu", "tb-list-item--on", "tb-list-item-label")).includes("Ordered List"));

    // ── 7. Quote family: plain blockquote vs the specific callout kind ──
    await clickText("plain quote");
    check("blockquote → quote active", (await activeIds()).includes("quote"));
    await clickText("callout body");
    check("callout body → quote active", (await activeIds()).includes("quote"));
    const calloutFilled = await filled("quote", "tb-callout-item--on", "x");
    check("callout body → the Tip row (a callout kind) is filled", calloutFilled.some((t) => /tip/i.test(t)), `filled=${JSON.stringify(calloutFilled)}`);

    // ── 8. Table cell: format greys to "—", no container active ──
    await clickText("cc");
    check("table cell → format label —", (await fmtLabel()) === "—", `label=${await fmtLabel()}`);
    check("table cell → format disabled", (await fmtDisabled()) === true);
    check("table cell → table active, no P/heading", (await activeIds()).includes("table"));

    // ── 9. Code block: Code button active + format N/A ──
    await clickText("zzz"); // syntax highlighting splits the line into token spans
    check("code block → codeBlock active", (await activeIds()).includes("codeBlock"));
    check("code block → format —", (await fmtLabel()) === "—");

    // ── 10. Selected image: Image button active + format N/A ──
    // The external src can't load headless, so click the image wrapper by
    // coordinates (its error placeholder still gives it a clickable box).
    const imgBox = await page.$eval(".ProseMirror .image-wrapper", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(imgBox.x, imgBox.y);
    await page.waitForTimeout(80);
    check("selected image → image active", (await activeIds()).includes("image"), `active=${JSON.stringify(await activeIds())}`);
    check("selected image → format —", (await fmtLabel()) === "—");

    // ── 11. Callout TITLE island: the bar detaches (the "P in a title" bug) ──
    // Put a real block state on the bar first, then focus the title island.
    await clickText("callout body");
    check("precondition: quote active before focusing title", (await activeIds()).includes("quote"));
    await page.$eval(".callout-title-text", (el) => el.focus());
    await page.waitForTimeout(80);
    check("callout title focused → format blanks to —", (await fmtLabel()) === "—", `label=${await fmtLabel()}`);
    check("callout title focused → format disabled", (await fmtDisabled()) === true);
    check("callout title focused → NO bar buttons active (detached)", eq(await activeIds(), []), `active=${JSON.stringify(await activeIds())}`);
}
