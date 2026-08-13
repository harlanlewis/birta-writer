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
}
