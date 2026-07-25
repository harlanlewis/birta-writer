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
}
