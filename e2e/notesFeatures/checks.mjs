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
 *   - embeds stay completely dark with the network master switch off.
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

    // ── Embeds gated off (network:false) ──
    const embedBits = await page.evaluate(() =>
        document.querySelectorAll(".embed-host, .embed-card").length);
    const rawLinkVisible = await page.evaluate(() => {
        const a = [...document.querySelectorAll(".ProseMirror a")]
            .find((el) => el.textContent.includes("youtu.be"));
        return !!a && getComputedStyle(a).display !== "none";
    });
    check("no embed card/host with network off", embedBits === 0, `${embedBits} embed nodes`);
    check("bare YouTube link stays a visible plain link", rawLinkVisible);

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
