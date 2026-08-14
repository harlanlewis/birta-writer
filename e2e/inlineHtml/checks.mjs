/**
 * Inline HTML survives the code-split sanitizer (MAR-219).
 *
 * DOMPurify moved behind a dynamic `import()` to keep ~27 KB out of the launch
 * bundle, which turns the html NodeView's fill into an async step. If that
 * chunk ever fails to load — a bad relative path, a CSP that blocks the import
 * — inline HTML renders as a permanently empty span and nothing throws, so
 * unit tests would stay green. Only the real bundle can show it, and only
 * after a wait: a synchronous assert would pass on the pre-lazy code and prove
 * nothing.
 *
 * Also pins the two invariants the laziness must not weaken: the comment chip
 * (which needs no sanitizer) is still filled, and sanitization still strips
 * event handlers.
 *
 * And the containment contract (MAR-366): a document's CSS cannot reach the
 * editor around it, and nothing rendered can take focus.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });

    // The comment branch never touches DOMPurify — it is filled during mount.
    const commentText = await page.evaluate(() =>
        document.querySelector(".html-inline.html-comment")?.textContent ?? null);
    check("an HTML comment renders as a chip without the sanitizer",
        commentText === "<!-- editorial aside -->", JSON.stringify(commentText));

    // The sanitized branch lands once the chunk resolves. Each raw tag is its
    // own html node, so the closing-tag nodes sanitize to an empty string —
    // it's the opening tags that must materialize.
    await page.waitForFunction(() => {
        const spans = [...document.querySelectorAll(".html-inline:not(.html-comment)")];
        return spans.some((s) => s.innerHTML.includes("<sub>"));
    }, null, { timeout: 10000 });

    const rendered = await page.evaluate(() =>
        [...document.querySelectorAll(".html-inline:not(.html-comment)")].map((s) => s.innerHTML));
    check("inline tags render as real HTML after the lazy sanitizer loads",
        rendered.some((h) => h.includes("<sub>")) && rendered.some((h) => h.includes("<sup>")),
        JSON.stringify(rendered));

    // Sanitization is still doing its job on the way through.
    const img = await page.evaluate(() => {
        const el = document.querySelector(".html-inline img");
        return el ? { onerror: el.getAttribute("onerror"), xss: window.__xss ?? false } : null;
    });
    check("event-handler attributes are stripped by the sanitizer",
        img !== null && img.onerror === null && img.xss === false, JSON.stringify(img));

    // MAR-366. These three need a layout engine, so jsdom cannot answer them:
    // whether a rule APPLIES, whether a box ESCAPES, and what the real tab
    // order is. The unit suite asserts the sanitizer's output; this asserts
    // what the browser then does with it.
    await page.waitForFunction(() =>
        document.querySelector(".html-inline #escapee") !== null, null, { timeout: 10000 });

    const topbar = await page.evaluate(() => {
        const el = document.querySelector(".editor-topbar");
        return { display: getComputedStyle(el).display, styleTags: document.querySelectorAll(".html-inline style").length };
    });
    check("a document's <style> neither applies nor survives in the DOM",
        topbar.display !== "none" && topbar.styleTags === 0, JSON.stringify(topbar));

    const escapee = await page.evaluate(() => {
        const el = document.querySelector(".html-inline #escapee");
        const rect = el.getBoundingClientRect();
        return {
            position: getComputedStyle(el).position,
            coversViewport: rect.width >= innerWidth && rect.height >= innerHeight,
        };
    });
    check("a fixed-position style attribute cannot escape its atom",
        escapee.position !== "fixed" && !escapee.coversViewport, JSON.stringify(escapee));

    // The IDL property, not the attribute: it reports the browser's own
    // sequential focus order, which is the thing being claimed.
    const buttonTabIndex = await page.evaluate(() =>
        document.querySelector(".html-inline button")?.tabIndex ?? null);
    check("a rendered control is outside the tab order",
        buttonTabIndex === -1, JSON.stringify(buttonTabIndex));

    // Block chrome. The unit tests can assert the NodeView's half of this and
    // nothing else: the box is gated on `p.html-block`, a class a plugin
    // maintains, and a border is a computed style. Both need the real bundle.
    const box = await page.evaluate(() => {
        const el = document.querySelector("p.html-block > .html-inline--block");
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { display: cs.display, border: cs.borderTopWidth, tag: el.firstElementChild?.tagName };
    });
    check("an atom that is the whole of its block wears a box",
        box !== null && box.display === "block" && box.border === "1px", JSON.stringify(box));

    const inlineBox = await page.evaluate(() => {
        const el = [...document.querySelectorAll(".html-inline")]
            .find((n) => !n.classList.contains("html-inline--block"));
        return el ? getComputedStyle(el).display : null;
    });
    check("a tag inside prose keeps display: contents and no box",
        inlineBox === "contents", JSON.stringify(inlineBox));

    // The column mounts empty and fills on first reveal, so a real hover is
    // the only way to see its buttons.
    // Wait for the END of the 0.12s reveal transition, not for the buttons to
    // exist: they attach on the first pointerenter, when the fade has only
    // just started and the strip still computes to opacity 0.
    await page.hover("p.html-block > .html-inline--block");
    const column = await page.waitForFunction(() => {
        const col = document.querySelector(".html-inline--block .bc-col");
        if (!col || getComputedStyle(col).opacity !== "1") return null;
        return {
            copy: col.querySelector(".html-copy-btn") !== null,
            edit: col.querySelector(".html-edit-btn") !== null,
        };
    }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null);
    check("hovering the block reveals a copy and an edit-source control",
        column !== null && column.copy && column.edit, JSON.stringify(column));

    // The column's buttons must stay REACHABLE, which is the stated reason the
    // edit-source button exists at all. The rendered face's tabindex sweep runs
    // over the same subtree these live in, so this is the assertion that keeps
    // the two from colliding.
    const reach = await page.evaluate(() => {
        const col = document.querySelector(".html-inline--block .bc-col");
        return [...col.querySelectorAll("button")].map((b) => b.tabIndex);
    });
    check("the column's own controls stay in the tab order",
        reach.length > 0 && reach.every((t) => t === 0), JSON.stringify(reach));

    // The panel brings its own surface, so the resting box stands down.
    await page.click(".html-inline--block");
    await page.waitForSelector(".html-inline--editing textarea.html-src", { timeout: 5000 });
    const editing = await page.evaluate(() => {
        const el = document.querySelector(".html-inline--editing");
        return { border: getComputedStyle(el).borderTopWidth, hasPanel: el.querySelector(".html-src-panel") !== null };
    });
    check("the box stands down while the source panel is open",
        editing.border === "0px" && editing.hasPanel, JSON.stringify(editing));
}
