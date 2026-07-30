/**
 * Preview chrome must not leave a stale, invisible caret (MAR-200).
 *
 * A code block showing a rendered preview (mermaid, LaTeX) hides its source
 * and puts non-content DOM in its place. Clicking that DOM never moves
 * ProseMirror's selection — the mermaid pane swallows its own mousedown for
 * the pan drag, and the LaTeX pane is inert `contentEditable=false` markup —
 * so the editor keeps whatever caret it had, with nothing on screen to say so.
 * The damage is the next keystroke: Enter ran the keymap at that stale caret
 * and split a paragraph elsewhere in the document, silently.
 *
 * These checks assert the DOCUMENT, not the mechanism: paragraph count and
 * text after the keystroke are what a user would lose.
 */

/** Screen coords of the first occurrence of `word` inside the editor. */
async function proseCoords(page, word) {
    return page.evaluate((w) => {
        const walk = document.createTreeWalker(
            document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
            const i = n.textContent.indexOf(w);
            if (i >= 0) {
                const r = document.createRange();
                r.setStart(n, i); r.setEnd(n, i + w.length);
                const rect = r.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                return { x: rect.x + 2, y: rect.y + rect.height / 2 };
            }
        }
        return null;
    }, word);
}

/** What the user would lose: paragraph count + the whole editor's text. */
async function docState(page) {
    return page.evaluate(() => ({
        paras: document.querySelectorAll(".ProseMirror p").length,
        text: document.querySelector(".ProseMirror")?.textContent ?? "",
    }));
}

/**
 * A point inside the pane that is clear of its own buttons/chrome. Every code
 * block owns all three pane elements and shows at most one, so match on the
 * VISIBLE one rather than the first in document order.
 */
async function paneCoords(page, selector) {
    const box = await page.evaluate((sel) => {
        for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return null;
    }, selector);
    if (!box) return null;
    return { x: box.x + Math.min(60, box.w / 3), y: box.y + box.h / 2 };
}

export async function run({ page, check, baseUrl }) {
    for (const [label, selector, ready] of [
        ["mermaid", ".mermaid-preview", ".mermaid-preview svg"],
        ["latex", ".latex-preview", ".latex-preview .katex"],
    ]) {
        // A fresh load per pane: the failure mode is a document mutation, so a
        // leaked edit from the previous case would poison the next one.
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForSelector(ready, { timeout: 20000 });
        await page.waitForTimeout(300);

        const alpha = await proseCoords(page, "alpha prose");
        check(`${label}: prose paragraph found`, alpha != null);
        if (!alpha) continue;

        // Park a live caret in prose, then click the preview and type.
        await page.mouse.click(alpha.x, alpha.y);
        await page.waitForTimeout(80);
        const before = await docState(page);

        const pane = await paneCoords(page, selector);
        check(`${label}: visible preview pane found`, pane != null);
        if (!pane) continue;
        await page.mouse.click(pane.x, pane.y);
        await page.waitForTimeout(80);
        await page.keyboard.press("Enter");
        await page.keyboard.type("zz");
        await page.waitForTimeout(150);

        const after = await docState(page);
        check(`${label}: Enter after a preview click splits nothing`,
            after.paras === before.paras,
            `paras ${before.paras}→${after.paras}`);
        check(`${label}: typing after a preview click reaches no text`,
            !after.text.includes("zz"),
            JSON.stringify(after.text.slice(0, 200)));

        // …and the editor comes back the moment the user clicks content.
        await page.mouse.click(alpha.x, alpha.y);
        await page.waitForTimeout(80);
        await page.keyboard.type("Q");
        await page.waitForTimeout(150);
        const back = await docState(page);
        check(`${label}: clicking back into prose restores normal typing`,
            back.text.includes("Q"), JSON.stringify(back.text.slice(0, 120)));
    }
}
