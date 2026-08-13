/**
 * Undo returns the document to the bytes it was loaded with (MAR-364).
 *
 * The extension can only clear the unsaved-changes flag on a document whose
 * buffer is byte-identical to its file (src/phantomDirty.ts), so "Cmd+Z lands
 * back on the saved bytes" is the property that makes the tab go clean again.
 * It is also fidelity in its own right: an undo that ships a re-canonicalized
 * line has quietly rewritten a construct the user restored.
 *
 * A link label is the shape that found it — a caret INSIDE the label splits an
 * inline mark, which is where a serializer is most likely to spell the line
 * differently on the way back.
 */

/** Put the caret inside the link label, `offset` characters in. */
async function caretInLinkLabel(page, offset) {
    await page.evaluate((at) => {
        const label = document.querySelector(".milkdown .ProseMirror a").firstChild;
        const range = document.createRange();
        range.setStart(label, at);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.querySelector(".milkdown .ProseMirror").focus();
    }, offset);
}

/** Every `update` the webview has shipped since the last reset. */
const shipped = (page) =>
    page.evaluate(() => window.__posted.filter((m) => m.type === "update").map((m) => m.content));

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(400);

    const initial = await page.evaluate(() => window.__initContent);

    await caretInLinkLabel(page, 4);
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.keyboard.type("Z");
    await page.waitForTimeout(600);

    const typed = await shipped(page);
    check("typing inside a link label ships the edit", typed.length > 0, JSON.stringify(typed));
    check(
        "the shipped edit is the typed character and nothing else",
        typed.at(-1) === initial.replace("[cont", "[contZ"),
        JSON.stringify(typed.at(-1)),
    );

    await page.evaluate(() => { window.__posted.length = 0; });
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(600);

    const undone = await shipped(page);
    check("undo ships a document update", undone.length > 0, JSON.stringify(undone));
    // Byte equality, not "renders the same": anything less leaves the document
    // differing from its file, which is a dirty tab the user cannot clear.
    check(
        "undo ships the initial bytes exactly",
        undone.at(-1) === initial,
        JSON.stringify(undone.at(-1)),
    );
}
