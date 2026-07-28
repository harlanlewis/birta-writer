/**
 * The Apple Notes editing set, verified against the REAL bundle — behaviors
 * jsdom can't fully pin:
 *   - inline calc end-to-end: advisory menu for both `=` forms (trailing
 *     `2+2 =` and leading `=5+7`), Tab-confirm, and the auto-insert guards
 *     (a comma-grouped number must never auto-insert a fragment answer —
 *     the input rule used to detect against the pre-stripped run),
 *   - the section-link picker's LAZY chunk actually loads in the served
 *     bundle (a broken chunk path would pass every jsdom test),
 *   - `#` in the link editor's URL field suggests the document's headings
 *     (jsdom can't reach this — it needs the composed editor's getEditorView),
 *   - checklist sink + Uncheck All serialize the right markdown through the
 *     real sync pipeline (asserted on posted `update` content),
 *   - with the network master switch off, network-using embeds (YouTube) stay
 *     completely dark while the no-network GitHub info card still renders —
 *     the switch gates requests, not rendering (the render ladder's Rung 0,
 *     MAR-186).
 */

/** The latest posted update's content once one matches, else "". */
async function latestDoc(page, matcher, tries = 30) {
    for (let i = 0; i < tries; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last && matcher(last)) return last;
        await page.waitForTimeout(100);
    }
    return "";
}

const paragraphTexts = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror p")].map((p) => p.textContent).join("|"));

export async function run({ page, check, baseUrl }) {
    await page.goto(baseUrl);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(600); // idle passes settle

    // ── Embeds gated per provider (network:false) ──
    // Network-using providers stay dark; the offline GitHub card renders.
    const networkCards = await page.evaluate(() =>
        document.querySelectorAll('.embed-card:not([data-embed-kind="github"])').length);
    const rawLinkVisible = await page.evaluate(() => {
        const a = [...document.querySelectorAll(".ProseMirror a")]
            .find((el) => el.textContent.includes("youtu.be"));
        return !!a && getComputedStyle(a).display !== "none";
    });
    check("no network-using embed card with network off", networkCards === 0, `${networkCards} cards`);
    check("bare YouTube link stays a visible plain link", rawLinkVisible);
    // The GitHub info card is built from URL parts alone (zero requests), so
    // the network switch does not gate it. The card rides a lazy chunk, so
    // wait for it rather than sampling once.
    const githubCard = await page
        .waitForSelector('.embed-card--info[data-embed-kind="github"]', { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    check("GitHub info card renders offline (Rung 0)", githubCard, "no offline .embed-card--info");
    if (githubCard) {
        const cardText = await page.evaluate(() =>
            document.querySelector('.embed-card--info[data-embed-kind="github"]').textContent);
        check("GitHub card shows owner/repo from the URL alone",
            cardText.includes("harlanlewis/birta-writer"), cardText);
        const githubIframes = await page.evaluate(() =>
            document.querySelectorAll(".embed-card--info iframe").length);
        check("the info card never builds an iframe", githubIframes === 0);
    }
    // Metadata rides the same gate: with the network off, the store must post
    // no resolveEmbedMeta at all (GitHub has no metadata source; the network
    // providers never reached the cached embeds array).
    const metaAsks = await page.evaluate(() =>
        (window.__posted ?? []).filter((m) => m.type === "resolveEmbedMeta").length);
    check("no embed metadata request leaves with network off", metaAsks === 0, `${metaAsks} asks`);

    // ── Calc: trailing form, Tab confirm ──
    const para = page.locator(".ProseMirror p", { hasText: "some text" }).first();
    await para.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" 2+2 =", { delay: 25 });
    let menu = await page.waitForSelector(".fm-suggest-menu", { timeout: 3000 }).catch(() => null);
    let menuText = menu ? await menu.textContent() : "";
    check("calc menu appears for '2+2 ='", !!menu, "no .fm-suggest-menu");
    check("calc menu offers 4 with the Always-insert action row",
        menuText.includes("4") && menuText.includes("Always insert result"), menuText);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    check("Tab confirms '2+2 = 4' into the doc", (await paragraphTexts(page)).includes("2+2 = 4"));

    // ── Calc: leading form ──
    await page.keyboard.press("Enter");
    await page.keyboard.type("=5+7", { delay: 25 });
    menu = await page.waitForSelector(".fm-suggest-menu", { timeout: 3000 }).catch(() => null);
    check("'=5+7' offers 12 (leading form)", !!menu && (await menu.textContent()).includes("12"));
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    check("Tab produces 12=5+7", (await paragraphTexts(page)).includes("12=5+7"));

    // ── Calc: auto-insert guards at runtime ──
    await page.evaluate(() => { window.__i18n.calcAutoInsert = true; });
    await page.keyboard.press("Enter");
    await page.keyboard.type("1,000 + 2=", { delay: 25 });
    await page.waitForTimeout(300);
    check("auto-insert refuses the comma fragment (no wrong '= 2')",
        !(await paragraphTexts(page)).includes("1,000 + 2= 2"));
    await page.keyboard.press("Enter");
    await page.keyboard.type("12*3=", { delay: 25 });
    await page.waitForTimeout(300);
    check("auto-insert answers a clean expression (12*3= 36)",
        (await paragraphTexts(page)).includes("12*3= 36"));
    await page.evaluate(() => { window.__i18n.calcAutoInsert = false; });

    // ── Section-link picker (lazy chunk) ──
    await page.keyboard.press("Enter");
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "insertSectionLink" }, "*"));
    menu = await page.waitForSelector(".fm-suggest-menu", { timeout: 5000 }).catch(() => null);
    menuText = menu ? await menu.textContent() : "";
    check("section-link picker opens (lazy chunk loaded)", !!menu, "no menu after insertSectionLink");
    check("picker lists the document headings",
        menuText.includes("Alpha") && menuText.includes("Beta"), menuText);
    await page.keyboard.press("Escape");

    // ── #heading anchors in the link editor ──
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "insertLink" }, "*"));
    await page.waitForTimeout(400);
    const urlInput = await page.$(".lp-url-input");
    check("insertLink opens the link editor", !!urlInput, "no .lp-url-input");
    if (urlInput) {
        await urlInput.click();
        await page.keyboard.type("#", { delay: 25 });
        await page.waitForTimeout(400);
        const anchorRows = await page.evaluate(() =>
            [...document.querySelectorAll(".fm-suggest-menu .fm-suggest-item")].map((li) => li.textContent));
        check("typing # suggests the document's heading anchors",
            anchorRows.some((r) => r.includes("#alpha")) && anchorRows.some((r) => r.includes("#beta")),
            JSON.stringify(anchorRows));
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
    }

    // ── Checklist sink on checkbox click ──
    const taskA = page.locator('.ProseMirror li[data-item-type="task"]', { hasText: "a" }).first();
    const box = await taskA.boundingBox();
    await page.mouse.click(box.x + 8, box.y + 10); // the checkbox column
    const sunk = await latestDoc(page, (d) => /\[ \] b[\s\S]*\[x\] a/.test(d));
    check("checking 'a' sinks it below unchecked 'b' (serialized)", sunk !== "",
        sunk ? "" : "no update matched the sunk order");

    // ── Uncheck All Tasks ──
    await taskA.click();
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "uncheckAllTasks" }, "*"));
    const cleared = await latestDoc(page, (d) => !d.includes("[x]") && d.includes("[ ]"));
    check("Uncheck All clears every [x] (serialized)", cleared !== "",
        cleared ? "" : "no update matched the cleared state");
}
