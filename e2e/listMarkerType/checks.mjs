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
        ul: document.querySelectorAll(".ProseMirror > ul").length,
        // Scoped to lists nested in the bullet list: the fixture also carries
        // standalone ordered lists (the Numbering checks at the end need a task
        // list and a mixed one), and a document-wide count would conflate them
        // with the sublist these checks are about.
        ol: document.querySelectorAll(".ProseMirror > ul ol").length,
        // Document-wide, for the checks that genuinely mean "every list".
        olAll: document.querySelectorAll(".ProseMirror ol").length,
    }));
    /**
     * Collapse the caret to the start or end of a block's text — `selector`, or
     * the block the caret is already in when it is null. ProseMirror reads the
     * DOM selection back on `selectionchange`, so this is an ordinary caret
     * placement, just a deterministic one.
     *
     * The settle wait after it is load-bearing: that read is deferred to a later
     * tick, so a keystroke sent immediately acts on the editor's PREVIOUS
     * selection — for a freshly-booted document, position 1. Without it the
     * whole suite silently exercises the first item instead of the one it named,
     * and still produces plausible-looking lists.
     *
     * Home and End cannot do this job. Chromium hands them to the scroller
     * first and only falls back to moving the caret when the page cannot scroll
     * any further that way, so with `#editor`'s scrollable tail band under
     * the document they move the caret exactly when the page happens to already
     * be parked at that end. That reads as an intermittent test.
     */
    const placeCaret = async (selector, side) => {
        // Resolved to a handle first: these selectors use Playwright's
        // :has-text(), which querySelector cannot parse.
        const host = selector ? await page.locator(selector).first().elementHandle() : null;
        const ok = await page.evaluate(({ host, side }) => {
            const target = host
                ?? window.getSelection().anchorNode?.parentElement?.closest("p, li, h1, h2, h3");
            if (!target) return false;
            const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
            let first = null, last = null;
            while (walker.nextNode()) {
                first ??= walker.currentNode;
                last = walker.currentNode;
            }
            const node = side === "end" ? last : first;
            if (!node) return false;
            document.querySelector(".ProseMirror").focus();
            const range = document.createRange();
            range.setStart(node, side === "end" ? node.nodeValue.length : 0);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
        }, { host, side });
        await page.waitForTimeout(150);
        return ok;
    };

    // ── 1. The motivating gesture: a nested ordered list, keyboard only. ──
    // Caret at the end of "steps", Enter for a fresh sibling item, Tab to
    // indent it into a sublist, then type the marker.
    await placeCaret(".ProseMirror li:has-text('steps')", "end");
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
    await placeCaret(".ProseMirror li:has-text('notes') p", "start");
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
    await placeCaret(".ProseMirror li:has-text('groceries') p", "start");
    await page.keyboard.type("[ ] ");
    const tasked = await waitForUpdate((doc) => hasLine(doc, "- [ ] groceries"));
    check("`[ ] ` makes the item a task", hasLine(tasked, "- [ ] groceries"),
        `doc=${JSON.stringify(tasked)}`);

    await placeCaret(null, "start");
    await page.keyboard.type("[x] ");
    const ticked = await waitForUpdate((doc) => hasLine(doc, "- [x] groceries"));
    check("`[x] ` on an open task ticks it instead of leaving literal text",
        hasLine(ticked, "- [x] groceries"),
        `doc=${JSON.stringify(ticked)}`);

    // ── 6. `a. ` and `i. ` draw a lettered or roman list, and write digits. ──
    // CommonMark has no lettered marker (utils/orderedMarkers.ts), so the two
    // halves of this are inseparable: the markers on screen must change and the
    // bytes must not.
    await placeCaret(".ProseMirror li:has-text('notes') p", "end");
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
    const olsBeforeJoin = (await counts()).olAll;
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
        joined.ols === olsBeforeJoin && !joined.strayParagraph,
        `before=${olsBeforeJoin} ${JSON.stringify(joined)}`,
    );
    check(
        "…and restyles the list it joined, instead of silently doing nothing",
        joined.style === "upper-roman",
        JSON.stringify(joined),
    );

    // ── 7b. A styled marker at the HEAD OF AN ITEM in an already-ordered list
    // restyles that list. The styled rule handles this before the transform is
    // reached; `retypeListItemAt` declines only when the SPELLING is unchanged
    // (it splits on a marker change since MAR-337), and a numbering STYLE is
    // not a spelling, so without this branch there is no typed way to letter a
    // numbered list. ──
    await placeCaret(".ProseMirror li:has-text('beta') p", "start");
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
    await placeCaret(".ProseMirror li:has-text('groceries') p", "end");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("Smith");
    await placeCaret(null, "start");
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

    // ── 9. Numbering is not offered where it cannot show: a task item draws a
    // checkbox instead of its marker, so an all-task ordered list has nothing a
    // numbering could change. A mixed list keeps the rows. ──
    const menuHeaders = async (itemText) => {
        const host = await page.$$eval(".ProseMirror li", (els, t) => {
            const el = els.find((e) => e.textContent.includes(t)) ?? els[0];
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + Math.min(14, r.height / 2) };
        }, itemText);
        // Hover first: the gutter marker is revealed, not resident, so its
        // geometry only exists once the row is hovered.
        await page.mouse.move(host.x, host.y);
        await page.waitForTimeout(140);
        const m = await page.$$eval(".ProseMirror li .heading-fold-marker", (els, t) => {
            const el = els.find((e) => e.closest("li")?.textContent.includes(t)) ?? els[0];
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, itemText);
        await page.mouse.click(m.x, m.y);
        await page.waitForTimeout(180);
        const headers = await page.evaluate(() => {
            const el = document.querySelector(".block-menu");
            return el
                ? [...el.querySelectorAll(".block-menu-header")].map((h) => h.textContent)
                : null;
        });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
        return headers;
    };
    const taskOnly = await menuHeaders("task one");
    check(
        "an all-task ordered list does not offer Numbering (no dead control)",
        taskOnly !== null && !taskOnly.includes("Numbering"),
        JSON.stringify(taskOnly),
    );
    const mixedList = await menuHeaders("plain one");
    check(
        "a mixed ordered list does offer it, because its plain items draw markers",
        mixedList !== null && mixedList.includes("Numbering"),
        JSON.stringify(mixedList),
    );
}
