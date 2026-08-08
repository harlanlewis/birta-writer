/**
 * Typed list markers, in a real browser with real keystrokes.
 *
 * The jsdom suite (webview/__tests__/listMarkerInput.test.ts) calls
 * `handleTextInput` directly, which is the layer BELOW the one these rules
 * actually live at: an input rule only ever runs if the composed keystroke
 * reaches ProseMirror's own beforeinput handling ahead of every other listener,
 * and jsdom has no such dispatch to get wrong (the MAR-277 argument — a
 * prop-level test cannot catch a handler race). This drives the keyboard.
 *
 * Covered here and nowhere else:
 *   - the motivating gesture end to end: Enter, Tab, `1. ` — an ordered list
 *     nested inside a bulleted one, from the keyboard alone;
 *   - the retype reaching DISK, via the serialized update the webview posts;
 *   - Backspace undoing the rule rather than lifting the item it just created.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".ProseMirror ul", { timeout: 10000 });

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
    const hasLine = (doc, line) => doc != null && doc.split("\n").includes(line);
    const counts = () => page.evaluate(() => ({
        ul: document.querySelectorAll(".ProseMirror ul").length,
        ol: document.querySelectorAll(".ProseMirror ol").length,
    }));
    /**
     * Click, then let ProseMirror read the click's text selection out of the
     * DOM. The read is deferred (a `selectionchange` the observer flushes on a
     * later tick), so a keystroke sent immediately after the click acts on the
     * editor's PREVIOUS selection — for a freshly-booted document, position 1.
     * Without this the whole suite silently exercises the first item instead of
     * the one it clicked, and still produces plausible-looking lists. The same
     * settle wait is why imageView's checks carry one.
     */
    const clickInto = async (selector) => {
        await page.click(selector);
        await page.waitForTimeout(150);
    };

    // ── 1. The motivating gesture: a nested ordered list, keyboard only. ──
    // Caret at the end of "steps", Enter for a fresh sibling item, Tab to
    // indent it into a sublist, then type the marker.
    await clickInto(".ProseMirror li:has-text('steps')");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("1. Rinse");

    const nested = await waitForUpdate((doc) => hasLine(doc, "  1. Rinse"));
    check("typing `1. ` in an indented item nests an ORDERED list under a bullet one",
        hasLine(nested, "- steps") && hasLine(nested, "  1. Rinse"),
        `doc=${JSON.stringify(nested)}`);

    const afterNest = await counts();
    check("the nested list renders as an <ol> inside the <ul>",
        afterNest.ol === 1 && afterNest.ul === 1,
        `ul=${afterNest.ul} ol=${afterNest.ol}`);

    // ── 2. A second numbered item continues the same list, not a new one. ──
    await page.keyboard.press("Enter");
    await page.keyboard.type("Repeat");
    const twoSteps = await waitForUpdate((doc) => hasLine(doc, "  2. Repeat"));
    check("Enter in the nested ordered list continues its numbering",
        hasLine(twoSteps, "  1. Rinse") && hasLine(twoSteps, "  2. Repeat"),
        `doc=${JSON.stringify(twoSteps)}`);
    const afterSecond = await counts();
    check("the two numbered items stay ONE ordered list",
        afterSecond.ol === 1, `ol=${afterSecond.ol}`);

    // ── 3. A marker on a top-level item splits its list — three blocks, which
    // is what the bytes say, and the user can see it. ──
    await clickInto(".ProseMirror li:has-text('notes') p");
    await page.keyboard.press("Home");
    await page.keyboard.type("1. ");
    const split = await waitForUpdate((doc) => hasLine(doc, "1. notes"));
    check("a marker typed on a top-level item retypes that item alone",
        hasLine(split, "- groceries") && hasLine(split, "1. notes") &&
        !hasLine(split, "1. groceries"),
        `doc=${JSON.stringify(split)}`);

    // ── 4. Backspace undoes the rule instead of lifting the new item. ──
    await page.keyboard.press("Backspace");
    const undone = await waitForUpdate((doc) => hasLine(doc, "- 1\\. notes"));
    check("Backspace right after the rule restores the typed characters",
        hasLine(undone, "- 1\\. notes"),
        `doc=${JSON.stringify(undone)}`);

    // ── 5. A task marker ticks a box from the keyboard, on the same line it
    // was typed on. ──
    await clickInto(".ProseMirror li:has-text('groceries') p");
    await page.keyboard.press("Home");
    await page.keyboard.type("[ ] ");
    const tasked = await waitForUpdate((doc) => hasLine(doc, "- [ ] groceries"));
    check("`[ ] ` makes the item a task", hasLine(tasked, "- [ ] groceries"),
        `doc=${JSON.stringify(tasked)}`);

    await page.keyboard.press("Home");
    await page.keyboard.type("[x] ");
    const ticked = await waitForUpdate((doc) => hasLine(doc, "- [x] groceries"));
    check("`[x] ` on an open task ticks it instead of leaving literal text",
        hasLine(ticked, "- [x] groceries"),
        `doc=${JSON.stringify(ticked)}`);
}
