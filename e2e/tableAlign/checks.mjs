/**
 * Table column alignment (MAR-75) end-to-end: drives the REAL editorCommand
 * message wire (the context menu's path), asserts the serialized `:---:`
 * bytes in the posted updates, the rendered text-align on both header and
 * body cells, and the toggle-off back to the unmarked `---`.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror table", { timeout: 10000 });
    await page.waitForTimeout(200);

    const send = (command) =>
        page.evaluate((command) =>
            window.postMessage({ type: "editorCommand", command }, "*"), command);
    // Updates are debounced (300ms) — poll for the expected separator line.
    async function separatorBecomes(expected, timeoutMs = 3000) {
        const startAt = Date.now();
        for (;;) {
            const updates = await page.evaluate(() =>
                window.__posted.filter((m) => m.type === "update").map((m) => m.content));
            const last = updates[updates.length - 1];
            const sep = last?.split("\n").find((l) => /^\|[-:| ]+\|$/.test(l));
            if (sep === expected) return sep;
            if (Date.now() - startAt > timeoutMs) return sep ?? null;
            await page.waitForTimeout(100);
        }
    }
    async function caretInCell(text) {
        const box = await page.evaluate((needle) => {
            const walk = document.createTreeWalker(
                document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walk.nextNode())) {
                const i = n.textContent.indexOf(needle);
                if (i >= 0) {
                    const r = document.createRange();
                    r.setStart(n, i); r.setEnd(n, i + 1);
                    const rect = r.getBoundingClientRect();
                    return { x: rect.x + 2, y: rect.y + rect.height / 2 };
                }
            }
            return null;
        }, text);
        await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(80);
    }

    // ── 1. Center the first column from a body cell ──
    await caretInCell("cc");
    await send("tableAlignColumnCenter");
    check("center → separator |:---:|---|", (await separatorBecomes("|:---:|---|")) === "|:---:|---|");
    const aligns = await page.$$eval(".ProseMirror table tr", (rows) =>
        rows.map((r) => getComputedStyle(r.cells[0]).textAlign));
    check("header AND body cells render centered", aligns.every((a) => a === "center"), JSON.stringify(aligns));

    // ── 2. Switch to right (replace, not toggle) ──
    await caretInCell("aa");
    await send("tableAlignColumnRight");
    check("right → separator |---:|---|", (await separatorBecomes("|---:|---|")) === "|---:|---|");

    // ── 3. Re-pick right → clears back to the unmarked default ──
    await send("tableAlignColumnRight");
    check("re-pick clears → |---|---|", (await separatorBecomes("|---|---|")) === "|---|---|");

    // ── 4. Second column, explicit left marker ──
    await caretInCell("dd");
    await send("tableAlignColumnLeft");
    check("explicit left → |---|:---|", (await separatorBecomes("|---|:---|")) === "|---|:---|");

    // ── 5. Typography polish (MAR-52) reaches the rendered document ──
    // Computed values, not the stylesheet: a reset or a cascade change that
    // swallowed the declarations would show here.
    const numeric = await page.$eval(".ProseMirror table td", (td) => getComputedStyle(td).fontVariantNumeric);
    check("table cells render tabular lining figures",
        numeric === "lining-nums tabular-nums" || numeric === "tabular-nums lining-nums", numeric);
    const body = await page.$eval("#editor", (el) => {
        const cs = getComputedStyle(el);
        return { ligatures: cs.fontVariantLigatures, trim: cs.textSpacingTrim, kerning: cs.fontKerning };
    });
    check("body ligatures are common+contextual", body.ligatures === "common-ligatures contextual", body.ligatures);
    check("body CJK punctuation trims at line start", body.trim === "trim-start", body.trim);
    check("body kerning asserted", body.kerning === "normal", body.kerning);
}
