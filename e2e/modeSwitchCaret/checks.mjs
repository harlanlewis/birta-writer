/**
 * The caret round trip across a mode switch (MAR-23), against the real bundle.
 *
 * jsdom can't answer either half of this: leaving the editor asks whether the
 * caret is on SCREEN (layout), and arriving asks whether typing continues where
 * the user landed (a live ProseMirror view with DOM focus). Both are checked
 * here through the same messages the extension sends and receives.
 *
 * The fixture's document lines are listed in index.html; the frontmatter takes
 * the first three, so every document line below is a body line plus 3.
 */

/** The position the webview last handed to the raw editor. */
const lastSwitch = (page) =>
    page.evaluate(() => {
        const posted = window.__posted.filter((m) => m.type === "switchToTextEditor");
        return posted[posted.length - 1] ?? null;
    });

/** Ask the webview to leave for the raw editor, exactly as Cmd+Shift+M does. */
async function requestSwitch(page) {
    await page.evaluate(() => window.postMessage({ type: "requestSwitchToTextEditor" }, "*"));
    await page.waitForTimeout(120);
    return lastSwitch(page);
}

/**
 * Put the caret `offset` characters into the block matched by `selector`.
 *
 * The click gives the editor focus; the offset is then set on the DOM selection
 * directly, which ProseMirror reads back through its selectionchange observer.
 * Arrow-key stepping was tried first and proved unreliable: keystrokes sent
 * while the post-mount decoration work is still settling get dropped, and the
 * caret lands a few characters short — a harness artefact that would read as a
 * mapping bug. Walking text nodes also copes with the spans that syntax
 * highlighting and inline marks introduce.
 */
async function caretInto(page, selector, offset, { nth = 0 } = {}) {
    await page.locator(selector).nth(nth).click();
    const placed = await page.evaluate(
        ({ selector, nth, offset }) => {
            const el = document.querySelectorAll(selector)[nth];
            if (!el) { return -1; }
            // Chrome the editor renders inside a block (a fold chevron, any
            // widget decoration) carries text of its own that is not document
            // content, so offsets must be counted over editable text only.
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) =>
                    n.parentElement?.closest("[contenteditable='false'], .ProseMirror-widget")
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT,
            });
            let remaining = offset;
            let node = walker.nextNode();
            while (node && remaining > node.length) {
                remaining -= node.length;
                node = walker.nextNode();
            }
            if (!node) { return -1; }
            const range = document.createRange();
            range.setStart(node, remaining);
            range.collapse(true);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return remaining;
        },
        { selector, nth, offset },
    );
    if (placed < 0) { throw new Error(`caretInto: no text node at ${selector}[${nth}]+${offset}`); }
    await page.waitForTimeout(80);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    // ── 1. Leaving: the caret's own line and column travel to the raw editor ──
    await caretInto(page, ".ProseMirror > p", 10, { nth: 0 });
    let target = await requestSwitch(page);
    check(
        "a caret in a paragraph carries its document line",
        target?.line === 7,
        JSON.stringify(target),
    );
    check(
        "a caret in a paragraph carries its column",
        target?.column === 10,
        JSON.stringify(target),
    );

    // ── 2. A heading's source-only "# " marker is counted in the column ──
    await caretInto(page, ".ProseMirror h1", 3);
    target = await requestSwitch(page);
    check(
        "a caret in a heading carries the marker-adjusted position",
        target?.line === 5 && target?.column === 5,
        JSON.stringify(target),
    );

    // ── 3. A list item resolves to its OWN line, not the list's first ──
    await caretInto(page, ".ProseMirror li p", 2, { nth: 1 });
    target = await requestSwitch(page);
    check(
        "a caret in the second list item carries that item's line",
        target?.line === 10,
        JSON.stringify(target),
    );
    check(
        "a list item's column includes its bullet",
        target?.column === 4,
        JSON.stringify(target),
    );

    // ── 4. Inside a fence, the code's own newlines advance the line ──
    // Six characters into the fence's SECOND code line.
    await caretInto(page, ".ProseMirror pre code", "const a = 1;\n".length + 5);
    target = await requestSwitch(page);
    check(
        "a caret on a fence's second code line carries that line",
        target?.line === 14,
        JSON.stringify(target),
    );
    check(
        "a code column maps one-to-one (no marker)",
        target?.column === 5,
        JSON.stringify(target),
    );

    // ── 5. A block after a LOOSE list still resolves to its own line ──
    // The list is one document node but three map entries, so the nominal
    // entry-per-block pairing puts this paragraph on the list's last item.
    await caretInto(page, ".ProseMirror > p", 6, { nth: 2 });
    target = await requestSwitch(page);
    check(
        "a caret after a loose list is not dragged back onto the list",
        target?.line === 23 && target?.column === 6,
        JSON.stringify(target),
    );

    // ── 6. Scrolled away from the caret, the VIEWPORT wins (and has no column) ──
    // "Take me to what I'm looking at" is the honest reading once the caret is
    // off screen — carrying a column from an invisible caret would be a lie.
    await caretInto(page, ".ProseMirror h1", 1);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
    await page.waitForTimeout(200);
    const scrolled = await page.evaluate(() => window.scrollY);
    check("the fixture is tall enough to scroll the caret off screen", scrolled > 200, `scrollY=${scrolled}`);
    target = await requestSwitch(page);
    check(
        "with the caret off screen the viewport line is carried instead",
        target !== null && target.line > 14,
        JSON.stringify(target),
    );
    check(
        "a viewport-derived position carries no column",
        target?.column === undefined,
        JSON.stringify(target),
    );

    // ── 7. Arriving: typing continues where the raw editor left the caret ──
    // The original defect: the view scrolled but the caret never moved, so the
    // first keystroke after a switch landed at the top of the document.
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.postMessage({ type: "scrollToLine", line: 7, column: 10 }, "*"));
    await page.waitForTimeout(250);
    await page.keyboard.type("X");
    await page.waitForTimeout(400);
    let content = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? "";
    });
    check(
        "typing after arriving lands at the handed-over caret",
        content.includes("First paraXgraph"),
        JSON.stringify(content.split("\n").slice(0, 4)),
    );

    // ── 8. Arriving with no column (a search hit) still moves the caret ──
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.postMessage({ type: "scrollToLine", line: 17 }, "*"));
    await page.waitForTimeout(250);
    await page.keyboard.type("Z");
    await page.waitForTimeout(400);
    content = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? "";
    });
    check(
        "a line-only navigation puts the caret at the start of that line",
        content.includes("ZLast paragraph."),
        JSON.stringify(content.split("\n").filter((l) => l.includes("paragraph.")).slice(0, 2)),
    );

    // ── 9. The round trip: what leaves comes back to the same place ──
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);
    await caretInto(page, ".ProseMirror > p", 6, { nth: 0 });
    target = await requestSwitch(page);
    await page.evaluate(
        (t) => window.postMessage({ type: "scrollToLine", line: t.line, column: t.column }, "*"),
        target,
    );
    await page.waitForTimeout(250);
    await page.keyboard.type("Q");
    await page.waitForTimeout(400);
    content = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? "";
    });
    check(
        "a caret survives doc → raw → doc unchanged",
        content.includes("First Qparagraph"),
        JSON.stringify(content.split("\n").slice(0, 4)),
    );
}
