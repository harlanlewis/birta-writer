/**
 * Adjacent-list merging (real-browser truth: backspace routing, the caret
 * advisory's keyboard capture, and the serialized update stream):
 *   - deleting the paragraph between two same-marker lists auto-joins them
 *     into ONE list — the serialized doc never gains a `*` alternation,
 *   - a source-authored `-`→`*` marker split survives that edit untouched,
 *   - the caret advisory offers "Merge with list above" in the first item of
 *     the `*` list; Escape dismisses it, Tab confirms the merge.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".ProseMirror ul", { timeout: 10000 });

    const hasLine = (doc, line) => doc != null && doc.split("\n").includes(line);
    const lastUpdate = () => page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length > 0 ? updates[updates.length - 1].content : null;
    });
    // Updates are debounced — poll until the latest serialized doc satisfies
    // `predicate` (returning it), or time out with the latest doc for logging.
    const waitForUpdate = async (predicate) => {
        for (let i = 0; i < 30; i++) {
            const doc = await lastUpdate();
            if (predicate(doc)) return doc;
            await page.waitForTimeout(100);
        }
        return lastUpdate();
    };
    const listCount = () => page.$$eval(".ProseMirror ul", (els) => els.length);

    // ── Boot: three sibling bullet lists (separator splits the first pair;
    // the `*` marker splits the third from the second). ──
    check("boot renders three lists", (await listCount()) === 3,
        `ulCount=${await listCount()}`);

    // ── 1. Delete the separator paragraph the way a user would: triple-click
    // selects its line (Home/Shift+End are document-scoped on the mac keymap),
    // Backspace the text, Backspace the empty block. The two `-` lists become
    // adjacent — the auto-join must fold them into ONE list. (List items hold
    // `<p>` too, so target the separator by its text.) ──
    await page.click(".ProseMirror p:has-text('separator')", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    const afterJoin = await waitForUpdate((doc) =>
        hasLine(doc, "- bingo") && !hasLine(doc, "separator"));
    check("deleting the separator auto-joins the two `-` lists",
        hasLine(afterJoin, "- foo") && hasLine(afterJoin, "- bar") &&
        hasLine(afterJoin, "- bingo") && hasLine(afterJoin, "- wingo") &&
        !hasLine(afterJoin, "* bingo"),
        `doc=${JSON.stringify(afterJoin)}`);
    check("two lists remain after the join", (await listCount()) === 2,
        `ulCount=${await listCount()}`);
    check("the source-authored `*` split is untouched by the join",
        hasLine(afterJoin, "* alpha") && hasLine(afterJoin, "* beta"),
        `doc=${JSON.stringify(afterJoin)}`);

    // ── 2. The caret advisory: caret in the FIRST item of the `*` list. ──
    await page.click(".ProseMirror li:has-text('alpha')");
    await page.waitForTimeout(400); // 200ms debounce + margin
    let menuText = await page.$eval(".fm-suggest-menu", (el) => el.textContent)
        .catch(() => null);
    check("the advisory offers 'Merge with list above' at the `*` boundary",
        menuText !== null && menuText.includes("Merge with list above"),
        `menu=${JSON.stringify(menuText)}`);

    // ── 3. Escape dismisses without merging (and stays quiet in place). ──
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const menuAfterEscape = await page.$(".fm-suggest-menu");
    check("Escape dismisses the advisory", menuAfterEscape === null,
        `stillOpen=${menuAfterEscape !== null}`);
    check("Escape did not merge", (await listCount()) === 2,
        `ulCount=${await listCount()}`);

    // ── 4. Leaving the context lifts the suppression; Tab confirms. ──
    await page.click(".ProseMirror li:has-text('beta')");
    await page.waitForTimeout(250);
    await page.click(".ProseMirror li:has-text('alpha')");
    await page.waitForTimeout(400);
    menuText = await page.$eval(".fm-suggest-menu", (el) => el.textContent)
        .catch(() => null);
    check("the advisory returns after the caret leaves and comes back",
        menuText !== null && menuText.includes("Merge with list above"),
        `menu=${JSON.stringify(menuText)}`);

    await page.keyboard.press("Tab");
    const afterMerge = await waitForUpdate((doc) =>
        doc != null && !doc.includes("* alpha"));
    check("Tab merges the `*` list into the list above (all `-` markers)",
        hasLine(afterMerge, "- alpha") && hasLine(afterMerge, "- beta") &&
        !afterMerge.includes("* "),
        `doc=${JSON.stringify(afterMerge)}`);
    check("one list remains after the advisory merge", (await listCount()) === 1,
        `ulCount=${await listCount()}`);
}
