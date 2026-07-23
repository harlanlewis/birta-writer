/**
 * ```calc ledger (MAR-196) — real-browser truths jsdom can't reach:
 *   - a mouse drag INSIDE the ledger survives and selects source + value
 *     (regression: ProseMirror used to wipe the selection on every mousemove
 *     until the NodeView's ignoreMutation ignored ledger selections),
 *   - the selected text carries the real-text `= value` lead-in (so a copy
 *     reads `source` / `= value`, not bare numbers),
 *   - value rows show `= value`; a `=>`-suffixed source row does NOT double it,
 *   - a formula-shaped line with no value shows the quiet error dash while
 *     plain prose shows nothing,
 *   - clicking back into prose still gives the editor a normal caret,
 *   - with birta.calc.blocks.enabled off (?blocksOff=1) the fence is an
 *     ordinary code block: no ledger, no auto-preview, no preview toggle.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".calc-row", { timeout: 10000 });
    await page.waitForTimeout(300);

    const rows = await page.$$eval(".calc-row", (els) =>
        els.map((el) => ({
            src: el.querySelector(".calc-row-src")?.textContent ?? "",
            result: el.querySelector(".calc-row-result")?.textContent ?? null,
            error: !!el.querySelector(".calc-row-result--error"),
        })),
    );

    const total = rows.find((r) => r.src.startsWith("total"));
    check("value rows carry the real-text `= ` lead-in", total?.result === "= 6500",
        JSON.stringify(total));
    const km = rows.find((r) => r.src.includes("km in mi"));
    check("a `=>`-suffixed source row does not double the lead-in",
        km?.result === "1.864114", JSON.stringify(km));
    const oops = rows.find((r) => r.src.startsWith("oops"));
    check("a formula-shaped failure shows the quiet error dash",
        oops?.error === true && oops?.result === "—", JSON.stringify(oops));
    const prose = rows.find((r) => r.src.startsWith("plain words"));
    check("plain prose shows no cue at all",
        prose != null && prose.result === null && !prose.error, JSON.stringify(prose));

    // ── The selection regression: drag across the total row ──
    const rowIndex = rows.findIndex((r) => r.src.startsWith("total")) + 1;
    const srcBox = await (await page.$(`.calc-row:nth-child(${rowIndex}) .calc-row-src`)).boundingBox();
    const resBox = await (await page.$(`.calc-row:nth-child(${rowIndex}) .calc-row-result`)).boundingBox();
    await page.mouse.move(srcBox.x + 2, srcBox.y + srcBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resBox.x + resBox.width - 2, resBox.y + resBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const dragText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    check("a mouse drag in the ledger survives (ignoreMutation)",
        dragText.includes("total = rent + budget") && dragText.includes("6500"),
        JSON.stringify(dragText));

    await page.mouse.dblclick(srcBox.x + 10, srcBox.y + srcBox.height / 2);
    await page.waitForTimeout(120);
    const dblText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    check("double-click selects a ledger word", dblText.trim().length > 0, JSON.stringify(dblText));

    // ── The editor still owns selection everywhere else ──
    const prosePos = await page.evaluate(() => {
        const walk = document.createTreeWalker(
            document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
            const i = n.textContent.indexOf("after prose");
            if (i >= 0) {
                const r = document.createRange();
                r.setStart(n, i); r.setEnd(n, i + 3);
                const rect = r.getBoundingClientRect();
                return { x: rect.x + 2, y: rect.y + rect.height / 2 };
            }
        }
        return null;
    });
    check("prose paragraph found", prosePos != null);
    if (prosePos) {
        await page.mouse.click(prosePos.x, prosePos.y);
        await page.waitForTimeout(100);
        const caretInProse = await page.evaluate(() => {
            const sel = window.getSelection();
            return !!sel && sel.isCollapsed
                && !!sel.anchorNode
                && (sel.anchorNode.textContent ?? "").includes("after prose");
        });
        check("clicking prose restores a normal editor caret", caretInProse);
    }

    // ── Disabled gate: the fence is an ordinary code block ──
    await page.goto(`${baseUrl}/index.html?blocksOff=1`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".code-block-wrapper", { timeout: 10000 });
    await page.waitForTimeout(400);
    check("blocks off: no ledger rows",
        (await page.$$(".calc-row")).length === 0);
    const preHidden = await page.$eval(".code-block-wrapper pre",
        (el) => el.classList.contains("code-pre--preview-hidden"));
    check("blocks off: source stays visible (no auto-preview)", preHidden === false);
    const toggleDisplay = await page.$eval(".code-view-toggle-btn",
        (el) => getComputedStyle(el).display);
    check("blocks off: no preview toggle", toggleDisplay === "none");
}
