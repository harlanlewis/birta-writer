/**
 * Code blocks stay highlighted, at first render and after an edit (MAR-219).
 *
 * The webview no longer bundles refractor's `common` entry (see the
 * `refractor-singleton` plugin in esbuild.mjs) — 35 grammars that used to be
 * registered eagerly, at boot, purely because @milkdown/plugin-prism imports
 * the bare specifier. Everything now comes from the lazy grammar chunk, which
 * is required to be a superset of common. If that superset ever slips, or the
 * chunk stops being loaded before the first paint, code blocks quietly lose
 * their token spans — nothing throws.
 *
 * The fixture mixes a language from common (html), one only we ship (zig), and
 * the grammar highlighter.ts defines locally (mermaid), and each is checked
 * both on mount (plugin-prism's `init`) and after typing (its `apply`). jsdom
 * can't see any of it: it needs the real bundle, the real plugin, and a real
 * transaction.
 */

/** Count prism token spans inside the Nth code block of the document. */
async function tokenCount(page, index) {
    return page.evaluate((i) => {
        const code = document.querySelectorAll(".code-block-wrapper")[i]?.querySelector("pre code");
        return code ? code.querySelectorAll("span.token").length : -1;
    }, index);
}

/** Click into the Nth code block and type a character at the caret. */
async function typeInBlock(page, index, text) {
    const code = page.locator(".code-block-wrapper").nth(index).locator("pre code");
    await code.click();
    await page.keyboard.type(text);
    await page.waitForTimeout(150);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // Grammars load lazily; editor.ts awaits them before create when the initial
    // document has a fence, so tokens are there on first paint.
    await page.waitForSelector(".milkdown .ProseMirror pre code span.token", { timeout: 10000 });

    // The mermaid block mounts as a rendered diagram — switch it to source so
    // it is an editable, decorated code block like the others.
    // (the toggle exists in every code block's header but is only shown for
    // previewable languages, so the visible one is mermaid's; it mounts in
    // preview mode, and clicking it drops back to the source view)
    const mermaidToggle = page.locator(".code-block-wrapper .code-view-toggle-btn:visible").first();
    await mermaidToggle.waitFor({ timeout: 10000 });
    await mermaidToggle.click();
    await page.waitForFunction(
        () => !document.querySelector(".code-pre--preview-hidden"), null, { timeout: 5000 });
    await page.waitForTimeout(200);

    const blocks = [
        // [index, label] — document order: html, zig, mermaid
        [0, "html (from refractor's common set, no longer eagerly registered)"],
        [1, "zig (lazy chunk only)"],
        [2, "mermaid (grammar defined in highlighter.ts)"],
    ];

    for (const [index, label] of blocks) {
        const before = await tokenCount(page, index);
        check(`${label} is highlighted on first render`, before > 0, `tokens=${before}`);

        await typeInBlock(page, index, "x");

        const after = await tokenCount(page, index);
        check(`${label} is still highlighted after an edit`, after > 0, `tokens=${after}`);
    }
}
