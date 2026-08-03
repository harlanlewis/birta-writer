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

/** Center of the first VISIBLE match, after revealing the block's chrome. */
async function chromeCoords(page, selector) {
    const box = await page.evaluate((sel) => {
        for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            const vis = getComputedStyle(el).display !== "none" && r.width > 0 && r.height > 0;
            if (vis) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
    }, selector);
    return box;
}

/** Hover the mermaid block so its control column is interactive. */
async function revealChrome(page) {
    const box = await page.evaluate(() => {
        const w = document.querySelector(".code-block-wrapper");
        if (!w) return null;
        const r = w.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + 8 };
    });
    if (box) await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(60);
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

    // ── The rest of the block's chrome (MAR-267) ─────────────────────────
    // MAR-200 covered the pane. Every other affordance of the same block
    // swallows its own mousedown (preventDefault), so the caret stays live
    // somewhere the user isn't looking, and the next keystroke edits there.
    // Same assertion as above: the DOCUMENT, not the mechanism.
    // `did` is what the button was FOR: going inert must not cost the action,
    // so each case asserts the affordance still fired. Read in the page, off
    // the first code block (the mermaid one). Two have no observable of their
    // own here — copy's target is the clipboard, and a click on the resize
    // handle without a drag changes nothing — so they carry none.
    const AFFORDANCES = [
        ["copy button", ".copy-btn", false,
            () => !!document.querySelector(".copy-btn.copy-btn--done")],
        ["view-toggle button", ".code-view-toggle-btn", false,
            (w) => !w.querySelector("pre").classList.contains("code-pre--preview-hidden")],
        ["width button", ".code-width-toggle-btn", false, (w) => w.classList.contains("bw-full")],
        ["fullscreen button", ".code-block-fullscreen-btn", false,
            () => document.querySelectorAll(".mermaid-lightbox").length === 1],
        ["language pill", ".lang-picker-btn", false,
            () => getComputedStyle(document.querySelector(".lang-picker-dropdown")).display !== "none"],
        ["resize handle", ".code-block-resize-handle", false, null],
        // No entry for the float row itself: measured on an EXPANDED block it
        // is exactly the pill's box (both 84.4px, and the row's center
        // hit-tests to `.lang-picker-label`) — the row's only other child,
        // the fold ellipsis, is hidden unless the block is collapsed. So a
        // "row background" case here would be the pill case again, passing
        // for the pill's reason rather than its own.
        // Word wrap is chrome only a CODE-mode block shows, so this one
        // leaves preview first (via the toggle, itself a covered affordance).
        ["word-wrap button", ".code-wrap-toggle-btn", true,
            (w) => w.classList.contains("code-block-wrapper--word-wrap")],
    ];

    for (const [label, selector, needsCodeMode, did] of AFFORDANCES) {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForSelector(".mermaid-preview svg", { timeout: 20000 });
        await page.waitForTimeout(300);

        if (needsCodeMode) {
            await revealChrome(page);
            const toggle = await chromeCoords(page, ".code-view-toggle-btn");
            if (toggle) await page.mouse.click(toggle.x, toggle.y);
            await page.waitForTimeout(120);
        }

        const alpha = await proseCoords(page, "alpha prose");
        if (!alpha) { check(`${label}: prose paragraph found`, false); continue; }
        await page.mouse.click(alpha.x, alpha.y);
        await page.waitForTimeout(80);
        const before = await docState(page);

        await revealChrome(page);
        const target = await chromeCoords(page, selector);
        check(`${label}: affordance is visible`, target != null);
        if (!target) continue;
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(120);

        if (did) {
            const fired = await page.evaluate(
                (src) => new Function(`return (${src})`)()(
                    document.querySelector(".code-block-wrapper")),
                did.toString());
            check(`${label}: still does what it is for`, fired === true, `${fired}`);
        }

        await page.keyboard.press("Enter");
        await page.keyboard.type("zz");
        await page.waitForTimeout(150);

        const after = await docState(page);
        const typed = after.text.indexOf("zz");
        check(`${label}: a click on it leaves the document unedited`,
            after.paras === before.paras && typed < 0,
            `paras ${before.paras}→${after.paras}; zz at ${typed}` +
            (typed < 0 ? "" : ` — ${JSON.stringify(after.text.slice(Math.max(0, typed - 40), typed + 40))}`));
    }

    // ── An aborted chrome gesture must not blur the NEXT click ──────────
    // Going inert is armed on a chrome mousedown and fired on the mouseup
    // that ends it — but a mouseup is not guaranteed to arrive: press on
    // chrome, release outside the window, and the page never sees it. The arm
    // then outlives its gesture, and the next click anywhere fires it,
    // blurring the editor the user had just clicked INTO. The resize handle
    // is the probe: its mousedown opens nothing, so a synthetic one (with no
    // mouseup, standing in for the release off-window) leaves only the arm.
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".mermaid-preview svg", { timeout: 20000 });
    await page.waitForTimeout(300);

    await revealChrome(page);
    const armed = await page.evaluate(() => {
        const handle = document.querySelector(".code-block-resize-handle");
        if (!handle) return false;
        handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        return true;
    });
    check("aborted gesture: the resize handle was armed", armed);

    const back = await proseCoords(page, "alpha prose");
    check("aborted gesture: prose paragraph found", back != null);
    if (back) {
        await page.mouse.click(back.x, back.y);
        await page.waitForTimeout(120);
        await page.keyboard.type("QQ");
        await page.waitForTimeout(200);
        const typed = await page.evaluate(() =>
            (document.querySelector(".ProseMirror")?.textContent ?? "").includes("QQ"));
        check("aborted gesture: the next click into prose still types", typed);
    }

    // ── The severe case: typing behind an open fullscreen lightbox ───────
    // The diagram lightbox focuses nothing, so the editor keeps focus while
    // the user looks at an overlay — every keystroke edits the document they
    // cannot see.
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".mermaid-preview svg", { timeout: 20000 });
    await page.waitForTimeout(300);

    const alpha = await proseCoords(page, "alpha prose");
    check("lightbox: prose paragraph found", alpha != null);
    if (alpha) {
        await page.mouse.click(alpha.x, alpha.y);
        await page.waitForTimeout(80);
        const before = await docState(page);

        await revealChrome(page);
        const fs = await chromeCoords(page, ".code-block-fullscreen-btn");
        check("lightbox: fullscreen button found", fs != null);
        if (fs) {
            await page.mouse.click(fs.x, fs.y);
            await page.waitForTimeout(400);
            const open = await page.evaluate(() =>
                document.querySelectorAll(".mermaid-lightbox").length);
            check("lightbox: the diagram lightbox opened", open === 1, `count ${open}`);

            const editorFocused = await page.evaluate(() =>
                document.activeElement?.classList?.contains("ProseMirror") ?? false);
            check("lightbox: the editor is not still focused behind it", !editorFocused);

            await page.keyboard.press("Enter");
            await page.keyboard.type("zz");
            await page.waitForTimeout(150);
            const after = await docState(page);
            const typed = after.text.indexOf("zz");
            check("lightbox: keystrokes do not edit the document behind it",
                after.paras === before.paras && typed < 0,
                `paras ${before.paras}→${after.paras}; zz at ${typed}`);
        }
    }
}
