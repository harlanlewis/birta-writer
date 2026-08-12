/**
 * MAR-360: add a paragraph, delete it again, and the file's bytes must be
 * exactly what they were.
 *
 * Why this lives here and not only in the jsdom suite: the unit test chooses
 * when each sync lands, so it proves the mechanism but not that the REAL
 * scheduler produces the poisoning sync. It does — the leading edge fires on
 * the first keystroke of the new paragraph, and the trailing/max-wait syncs
 * land during the backspacing, one of them while the emptied paragraph node
 * still exists. That intermediate serialization is the one that used to write
 * two blank lines the merge could never take back out (a blank-line-only
 * difference is deliberately invisible to it, MAR-313/MAR-290), so the
 * residue survived every later clean save.
 *
 * The observable is the `update` payload: those are the file-ready bytes the
 * extension writes, after the minimal-diff merge.
 */

/** The content of the most recent `update` post, or null if none. */
async function latestUpdate(page) {
    return await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length ? updates[updates.length - 1].content : null;
    });
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const original = await page.evaluate(() => window.__content);

    // Put the caret at the end of the "## Footnotes" heading, then Enter into
    // a fresh paragraph beneath it — the gesture as reported.
    const heading = await page.$(".milkdown .ProseMirror h2");
    check("the harness document has the heading to type under", heading !== null);
    await page.evaluate(() => {
        const h = document.querySelector(".milkdown .ProseMirror h2");
        const range = document.createRange();
        range.selectNodeContents(h);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });

    await page.keyboard.press("Enter");
    await page.keyboard.type("temporary paragraph", { delay: 30 });

    // Let the trailing sync land so the added paragraph genuinely reaches a
    // posted update — otherwise the delete below would be undoing something
    // the file never saw, and the check would pass vacuously.
    await page.waitForFunction(
        () => window.__posted.some((m) => m.type === "update" && m.content.includes("temporary paragraph")),
        undefined,
        { timeout: 5000 },
    );
    const added = await latestUpdate(page);
    check("the added paragraph reaches the file", added.includes("temporary paragraph"),
        JSON.stringify(added));

    // Now delete it. Backspace the text away, then PAUSE past the scheduler's
    // idle window before removing the line itself — a user who deletes a
    // paragraph's text, looks at the blank line, and then removes it. That
    // pause is load-bearing for this check: it is what lets a sync land while
    // the emptied-but-present paragraph node exists, which is the only state
    // that ever wrote the residue. Backspacing straight through without it
    // passes on the unfixed engine, so a version of this check that skipped
    // the pause proved nothing.
    for (let i = 0; i < "temporary paragraph".length; i++) {
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(30);
    }
    await page.waitForTimeout(700);
    const whileEmpty = await latestUpdate(page);
    check("a sync lands while the emptied paragraph still exists",
        whileEmpty !== null && !whileEmpty.includes("temporary"),
        JSON.stringify(whileEmpty));

    // One more removes the now-empty paragraph node itself.
    await page.keyboard.press("Backspace");

    // Settle past the trailing window so the final sync has certainly landed.
    await page.waitForTimeout(800);

    const final = await latestUpdate(page);
    check("the added text is gone again", !final.includes("temporary"), JSON.stringify(final));
    check("add-then-delete leaves the file byte-identical",
        final === original,
        `expected ${JSON.stringify(original)}, got ${JSON.stringify(final)}`);

    // The specific damage: blank lines accreted under the heading.
    check("no blank-line residue under the heading",
        !final.includes("## Footnotes\n\n\n"),
        JSON.stringify(final));
}
