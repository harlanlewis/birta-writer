/**
 * `#` heading input rule — absolute level (real-browser truth: the rule fires
 * through ProseMirror's handleTextInput, which jsdom can't drive):
 *   - typing `## ` at the start of an H3 makes it an H2 — the typed hash
 *     count IS the level (the stock Milkdown rule ADDED it: H3 + `## ` → H5),
 *   - typing `#### ` at the start of a paragraph still promotes it to H4.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".ProseMirror h3", { timeout: 10000 });

    // A serialized line must match EXACTLY — `"## Heading"` is a substring
    // of the additive rule's `"##### Heading"`, so substring checks pass
    // spuriously. Anchor to whole lines.
    const hasLine = (doc, line) => doc != null && doc.split("\n").includes(line);

    // Updates are debounced (300ms) — poll for a serialized doc containing
    // `wanted` as a whole line (and log the latest content on timeout).
    const waitForUpdate = async (wanted) => {
        for (let i = 0; i < 30; i++) {
            const updates = await page.evaluate(() =>
                window.__posted.filter((m) => m.type === "update").map((m) => m.content));
            const last = updates[updates.length - 1];
            if (hasLine(last, wanted)) return last;
            await page.waitForTimeout(100);
        }
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        return updates[updates.length - 1] ?? null;
    };

    const typeAtBlockStart = async (selector, text) => {
        await page.click(selector);
        await page.keyboard.press("Home");
        await page.keyboard.type(text, { delay: 20 });
    };

    // ── 1. Retype an H3 with `## ` → H2, absolutely (not H5). ──
    await typeAtBlockStart(".ProseMirror h3", "## ");
    const afterRetype = await waitForUpdate("## Heading 3");
    check("`## ` at the start of an H3 makes it an H2 (absolute, not additive)",
        hasLine(afterRetype, "## Heading 3"),
        `doc=${JSON.stringify(afterRetype)}`);
    const h2Count = await page.$$eval(".ProseMirror h2", (els) => els.length);
    check("the block renders as an H2", h2Count === 1, `h2Count=${h2Count}`);

    // ── 2. A paragraph still promotes to the typed level. ──
    await typeAtBlockStart(".ProseMirror p", "#### ");
    const afterPromote = await waitForUpdate("#### A paragraph here.");
    check("`#### ` at the start of a paragraph makes it an H4",
        hasLine(afterPromote, "#### A paragraph here."),
        `doc=${JSON.stringify(afterPromote)}`);

    // ── 3. Retype DOWN too: `# ` on the H4 → H1 (the additive rule could
    // only ever raise the level). ──
    await typeAtBlockStart(".ProseMirror h4", "# ");
    const afterDown = await waitForUpdate("# A paragraph here.");
    check("`# ` at the start of an H4 makes it an H1",
        hasLine(afterDown, "# A paragraph here."),
        `doc=${JSON.stringify(afterDown)}`);
}
