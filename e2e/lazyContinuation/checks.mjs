/**
 * Turning a list item into a paragraph, in a real browser (MAR-289).
 *
 * The jsdom matrix (webview/__tests__/lazyContinuationMerge.test.ts) drives
 * the same gestures through `someProp("handleKeyDown", …)`, which bypasses
 * event dispatch entirely — the layer where Backspace's routing between the
 * list keymap, ProseMirror's base keymap and contenteditable's own deletion
 * is actually decided. This suite presses the real keys, lets the real save
 * pipeline run (serialize → minimal-diff merge → `update` message), and then
 * REOPENS the saved bytes.
 *
 * The reopen is the assertion that matters: a document whose bytes say
 * something other than what the screen showed is the whole bug. Before the
 * fix the merged file read `- two\nthree`, so on reopen `three` came back as
 * list content — the "it springs back into a list item" the report describes.
 */

/**
 * Put a collapsed caret at the START of the list item whose text is `text`.
 *
 * A plain click plus Home is not enough: the click's own ProseMirror handling
 * is asynchronous, so the caret can snap back to the click point, and a native
 * Home moves a DOM selection ProseMirror has not read into its state yet — so
 * the list keymap, which acts on `state.selection`, sees the caret mid-word
 * and declines. (Measured: the same press worked on a cold run and did
 * nothing on the next.) The placement is therefore made programmatically and
 * VERIFIED against the live DOM selection before the keystroke that depends
 * on it — the same technique, and the same hard-won reason, as `caretInto` in
 * e2e/agentContext.
 */
async function caretAtItemStart(page, text) {
    await page.click(`.ProseMirror li:has-text('${text}')`);
    const domCaret = (mode) =>
        page.evaluate(
            ({ text, mode }) => {
                const li = [...document.querySelectorAll(".ProseMirror li")]
                    .find((el) => el.textContent.trim() === text);
                if (!li) { return false; }
                const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) =>
                        n.parentElement?.closest("[contenteditable='false'], .ProseMirror-widget")
                            ? NodeFilter.FILTER_REJECT
                            : NodeFilter.FILTER_ACCEPT,
                });
                const node = walker.nextNode();
                if (!node) { return false; }
                const selection = getSelection();
                if (mode === "verify") {
                    return selection.isCollapsed &&
                        selection.anchorNode === node &&
                        selection.anchorOffset === 0;
                }
                const range = document.createRange();
                range.setStart(node, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                return true;
            },
            { text, mode },
        );
    for (let attempt = 0; attempt < 5; attempt++) {
        if (!(await domCaret("set"))) { break; }
        await page.waitForTimeout(100);
        if (await domCaret("verify")) {
            // Let ProseMirror read the selection change into its own state.
            await page.waitForTimeout(80);
            return;
        }
    }
    throw new Error(`caretAtItemStart: caret would not place at the start of "${text}"`);
}

export async function run({ page, check, baseUrl }) {
    /** The latest content the webview posted to the host — i.e. the file bytes. */
    const lastUpdate = () => page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length > 0 ? updates[updates.length - 1].content : null;
    });
    const waitForUpdate = async (predicate) => {
        for (let i = 0; i < 30; i++) {
            const doc = await lastUpdate();
            if (predicate(doc)) return doc;
            await page.waitForTimeout(100);
        }
        return lastUpdate();
    };

    /** Structure as the reader sees it: item texts, and top-level paragraphs. */
    const shape = () => page.evaluate(() => {
        const pm = document.querySelector(".milkdown .ProseMirror");
        const items = [...pm.querySelectorAll("li")].map((li) => li.textContent.trim());
        const loose = [...pm.children]
            .filter((el) => el.tagName === "P")
            .map((el) => el.textContent.trim());
        return { items, loose };
    });
    /** A keypress reaches the DOM a beat later than Playwright's promise. */
    const waitForShape = async (predicate) => {
        for (let i = 0; i < 30; i++) {
            const s = await shape();
            if (predicate(s)) return s;
            await page.waitForTimeout(100);
        }
        return shape();
    };
    const twoItems = (s) => s.items.length === 2;

    // The document rides in the QUERY, never the hash: a goto that differs
    // only in the hash is a same-document navigation, so the page would not
    // reload and every "reopen" check below would silently re-read the state
    // it had just edited — passing against the very bug it exists to catch.
    const boot = async (doc) => {
        await page.goto(`${baseUrl}/index.html${doc ? `?doc=${encodeURIComponent(doc)}` : ""}`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForSelector(".ProseMirror ul li", { timeout: 10000 });
    };

    // ── 1. The reported case: the LAST item of a list. ──
    await boot();
    const booted = await shape();
    check("boot renders a three-item list",
        booted.items.join("|") === "one|two|three",
        `items=${JSON.stringify(booted.items)}`);

    await caretAtItemStart(page, "three");
    await page.keyboard.press("Backspace");

    const onScreen = await waitForShape(twoItems);
    check("the last item becomes a paragraph on screen",
        onScreen.items.join("|") === "one|two" && onScreen.loose.includes("three"),
        `shape=${JSON.stringify(onScreen)}`);

    const savedLast = await waitForUpdate((doc) => doc != null && !/^- three$/m.test(doc));
    check("the saved bytes separate the paragraph from the list",
        savedLast != null && /- two\n[ \t]*\nthree/.test(savedLast),
        `saved=${JSON.stringify(savedLast)}`);

    // The invariant: reopening the saved bytes shows the same document.
    await boot(savedLast);
    const reopened = await waitForShape(twoItems);
    check("reopening the saved bytes keeps the paragraph out of the list",
        reopened.items.join("|") === "one|two" && reopened.loose.includes("three"),
        `saved=${JSON.stringify(savedLast)} shape=${JSON.stringify(reopened)}`);

    // ── 2. A MIDDLE item — the "collapses into the line above" symptom. ──
    await boot();
    await caretAtItemStart(page, "two");
    await page.keyboard.press("Backspace");

    const midOnScreen = await waitForShape(twoItems);
    check("a middle item becomes a paragraph on screen",
        midOnScreen.items.join("|") === "one|three" && midOnScreen.loose.includes("two"),
        `shape=${JSON.stringify(midOnScreen)}`);

    const savedMid = await waitForUpdate((doc) => doc != null && !/^- two$/m.test(doc));
    await boot(savedMid);
    const midReopened = await waitForShape(twoItems);
    check("reopening keeps a lifted middle item out of the list above it",
        midReopened.items.join("|") === "one|three" && midReopened.loose.includes("two"),
        `saved=${JSON.stringify(savedMid)} shape=${JSON.stringify(midReopened)}`);

    // ── 3. Shift+Tab, the other gesture that lifts an item. ──
    await boot();
    await caretAtItemStart(page, "three");
    await page.keyboard.press("Shift+Tab");

    const shiftTabOnScreen = await waitForShape(twoItems);
    check("Shift+Tab lifts the last item out of the list",
        shiftTabOnScreen.items.join("|") === "one|two" &&
        shiftTabOnScreen.loose.includes("three"),
        `shape=${JSON.stringify(shiftTabOnScreen)}`);

    const savedShiftTab = await waitForUpdate((doc) => doc != null && !/^- three$/m.test(doc));
    await boot(savedShiftTab);
    const shiftTabReopened = await waitForShape(twoItems);
    check("reopening a Shift+Tab lift keeps the paragraph out of the list",
        shiftTabReopened.items.join("|") === "one|two" &&
        shiftTabReopened.loose.includes("three"),
        `saved=${JSON.stringify(savedShiftTab)} shape=${JSON.stringify(shiftTabReopened)}`);
}
