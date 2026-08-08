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
 *   - Backspace undoing the rule rather than lifting the item it just created;
 *   - `a. ` / `i. ` producing a list DRAWN in that style whose bytes stay `1.`,
 *     which is the whole fidelity claim and only observable with a real
 *     `list-style-type` resolved by a real style engine.
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

    // ── 6. `a. ` and `i. ` draw a lettered or roman list, and write digits. ──
    // CommonMark has no lettered marker (utils/orderedMarkers.ts), so the two
    // halves of this are inseparable: the markers on screen must change and the
    // bytes must not.
    await clickInto(".ProseMirror li:has-text('notes') p");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    // Shift+Tab lifts the new item out to the top level so the list it starts
    // is not a nested one, whose style the by-depth cascade would also set.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("a. alpha");
    const alphaDoc = await waitForUpdate((doc) => hasLine(doc, "1. alpha"));
    check(
        "`a. ` writes an ordinary digit marker to the file",
        hasLine(alphaDoc, "1. alpha"),
        `doc=${JSON.stringify(alphaDoc)}`,
    );
    check(
        "`a. ` never writes a lettered marker",
        alphaDoc != null && !alphaDoc.includes("a. alpha"),
        `doc=${JSON.stringify(alphaDoc)}`,
    );
    const alphaOl = await page.evaluate(() => {
        const ols = [...document.querySelectorAll(".ProseMirror ol")];
        const ol = ols.find((el) => el.textContent.includes("alpha"));
        return ol ? { style: getComputedStyle(ol).listStyleType, inline: ol.getAttribute("style") } : null;
    });
    check(
        "…and the list is DRAWN with letters",
        alphaOl?.style === "lower-alpha",
        JSON.stringify(alphaOl),
    );
    check(
        "the style rides an inline declaration, so it beats the by-depth cascade",
        (alphaOl?.inline ?? "").includes("list-style-type"),
        JSON.stringify(alphaOl),
    );
    check(
        "the numbering persists to the webview state bag, keyed on the first item",
        await page.evaluate(() => window.__state?.listNumbering?.["list:alpha"] === "lower-alpha"),
        JSON.stringify(await page.evaluate(() => window.__state?.listNumbering)),
    );

    // Enter continues the styled list rather than starting a plain one.
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    const twoDoc = await waitForUpdate((doc) => hasLine(doc, "2. beta"));
    check(
        "Enter continues the list, still as digits on disk",
        hasLine(twoDoc, "1. alpha") && hasLine(twoDoc, "2. beta"),
        `doc=${JSON.stringify(twoDoc)}`,
    );
    check(
        "…and the continued list keeps its lettering",
        await page.evaluate(() => {
            const ols = [...document.querySelectorAll(".ProseMirror ol")];
            const ol = ols.find((el) => el.textContent.includes("beta"));
            return ol && getComputedStyle(ol).listStyleType === "lower-alpha";
        }),
    );

    // ── 7. A marker typed on the line DIRECTLY BELOW an ordered list restyles
    // that list, because adjacency auto-joins and the alternative is a marker
    // that visibly does nothing. ──
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("I. ");
    await page.waitForTimeout(250);
    const joined = await page.evaluate(() => {
        const ols = [...document.querySelectorAll(".ProseMirror ol")];
        const ol = ols.find((el) => el.textContent.includes("alpha"));
        return {
            ols: ols.length,
            style: ol ? getComputedStyle(ol).listStyleType : null,
            strayParagraph: [...document.querySelectorAll(".ProseMirror > p")]
                .some((el) => el.textContent.includes("I.")),
        };
    });
    check(
        "a marker below a list joins it rather than leaving a second list",
        joined.ols === 2 && !joined.strayParagraph,
        JSON.stringify(joined),
    );
    check(
        "…and restyles the list it joined, instead of silently doing nothing",
        joined.style === "upper-roman",
        JSON.stringify(joined),
    );

    // ── 7b. A styled marker at the HEAD OF AN ITEM in an already-ordered list
    // restyles that list. retypeListItemAt declines when the kind is unchanged,
    // so without this branch there is no typed way to letter a numbered list. ──
    await clickInto(".ProseMirror li:has-text('beta') p");
    await page.keyboard.press("Home");
    await page.keyboard.type("a. ");
    await page.waitForTimeout(250);
    const restyled = await page.evaluate(() => {
        const ols = [...document.querySelectorAll(".ProseMirror ol")];
        const ol = ols.find((el) => el.textContent.includes("beta"));
        return {
            style: ol ? getComputedStyle(ol).listStyleType : null,
            // The marker must be CONSUMED, not left as literal text.
            literal: ol ? ol.textContent.includes("a. beta") : null,
        };
    });
    check(
        "a marker at an ordered item's head restyles its list",
        restyled.style === "lower-alpha",
        JSON.stringify(restyled),
    );
    check(
        "…and the typed marker is consumed rather than left as text",
        restyled.literal === false,
        JSON.stringify(restyled),
    );
    const restyledDoc = await waitForUpdate((doc) => doc != null && !doc.includes("a\\. beta"));
    check(
        "…and the file still holds ordinary digit markers",
        restyledDoc != null && !restyledDoc.includes("a. beta") && hasLine(restyledDoc, "2. beta"),
        `doc=${JSON.stringify(restyledDoc)}`,
    );

    // ── 8. A misfire in plain prose is answerable with one Backspace, the digit
    // rule's own mitigation — the accepted cost of `A. Smith` converting. ──
    await clickInto(".ProseMirror li:has-text('groceries') p");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("Smith");
    await page.keyboard.press("Home");
    await page.keyboard.type("A. ");
    await page.waitForTimeout(250);
    const misfired = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror ol")]
            .some((el) => getComputedStyle(el).listStyleType === "upper-alpha"));
    check("`A. ` does convert (the misfire this mitigation exists for)", misfired);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    const restored = await page.evaluate(() => ({
        prose: [...document.querySelectorAll(".ProseMirror p")]
            .some((el) => el.textContent === "A. Smith"),
        upperAlpha: [...document.querySelectorAll(".ProseMirror ol")]
            .some((el) => getComputedStyle(el).listStyleType === "upper-alpha"),
    }));
    check(
        "Backspace puts the characters back as prose and leaves no styled list",
        restored.prose && !restored.upperAlpha,
        JSON.stringify(restored),
    );
}
