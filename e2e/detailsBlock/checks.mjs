/**
 * `<details>` disclosures (plugins/details.ts, components/details): the tags
 * and the Markdown between them draw as ONE block, a closed one loads folded,
 * the toggle opens it without touching the document, and where the fold
 * layer refuses a fold (inside a list item) there is no toggle to press.
 *
 * Run under both engines; the Mac panel is WebKit.
 *   node e2e/run.mjs detailsBlock
 *   BIRTA_E2E_BROWSER=webkit node e2e/run.mjs detailsBlock
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror .details-block", { timeout: 10000 });
    await page.waitForTimeout(400);

    const shape = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll(".ProseMirror .details-block")];
        return {
            count: blocks.length,
            // An inert `<details>` html atom would mean a tag was left behind.
            stray: document.querySelectorAll(".ProseMirror details").length,
            summaries: blocks.map((b) => b.querySelector(".details-summary-text")?.textContent),
            list: blocks[0]?.querySelectorAll(".details-body li").length ?? 0,
        };
    });
    check("four disclosures render as four blocks, no stray tag atoms",
        shape.count === 4 && shape.stray === 0, JSON.stringify(shape));
    check("each summary is its own text",
        JSON.stringify(shape.summaries) === JSON.stringify(["Timestamps", "Open one", "Indented", "In a list"]),
        JSON.stringify(shape.summaries));
    check("the body is Markdown: the list items render as list items", shape.list === 2, String(shape.list));

    // The indented-body shape: Markdown inside, not a code block with its chrome.
    const indented = await page.evaluate(() => {
        const block = document.querySelectorAll(".ProseMirror .details-block")[2];
        return {
            items: block?.querySelectorAll(".details-body li").length ?? -1,
            code: block?.querySelectorAll("pre, .code-block-wrapper, [data-type='code_block']").length ?? -1,
        };
    });
    check("an indented body renders as Markdown with no code block in it",
        indented.items === 1 && indented.code === 0, JSON.stringify(indented));

    const state = () => page.evaluate(() => [...document.querySelectorAll(".ProseMirror .details-block")].map((b) => ({
        collapsed: b.classList.contains("collapsed"),
        bodyHeight: Math.round(b.querySelector(".details-body")?.getBoundingClientRect().height ?? -1),
        toggle: !!b.querySelector(".details-toggle") && !b.querySelector(".details-toggle").hidden,
        toggleShown: (() => {
            const t = b.querySelector(".details-toggle");
            return !!t && t.getBoundingClientRect().width > 0;
        })(),
    })));
    const before = await state();
    check("a details without `open` loads folded, its body taking no height",
        before[0]?.collapsed === true && before[0]?.bodyHeight === 0, JSON.stringify(before[0]));
    check("a details with `open` loads unfolded",
        before[1]?.collapsed === false && before[1]?.bodyHeight > 0, JSON.stringify(before[1]));
    check("inside a list item there is no toggle to press",
        before[3]?.toggleShown === false && before[3]?.collapsed === false, JSON.stringify(before[3]));

    const updatesBefore = await page.evaluate(() => window.__posted.filter((m) => m.type === "update").length);
    await page.locator(".ProseMirror .details-block").first().locator(".details-toggle").click();
    await page.waitForTimeout(400);
    const after = await state();
    check("the toggle unfolds a closed details", after[0]?.collapsed === false && after[0]?.bodyHeight > 0,
        JSON.stringify(after[0]));
    // Allow the sync scheduler's idle window to pass before reading.
    await page.waitForTimeout(1200);
    const updatesAfter = await page.evaluate(() => window.__posted.filter((m) => m.type === "update").length);
    check("unfolding posts no document update", updatesAfter === updatesBefore,
        `${updatesBefore} -> ${updatesAfter}`);

    // The control for the arm above: a real edit DOES post, so "no update"
    // was a reading and not a harness that never posts. Typed through the
    // keyboard into the summary island, the path WebKit is the one to doubt.
    const summary = page.locator(".ProseMirror .details-block").first().locator(".details-summary-text");
    await summary.click();
    // Caret to the end through the selection API: `End` does not move to the
    // end of a line in WebKit on macOS, and a probe whose caret landed
    // mid-word would report the editor's failure rather than its own.
    const atEnd = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .details-block .details-summary-text");
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return document.activeElement === el && sel.anchorNode !== null;
    });
    check("the probe put the caret at the end of the focused summary", atEnd, String(atEnd));
    await page.keyboard.type(" & more");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
        (n) => window.__posted.filter((m) => m.type === "update").length > n, updatesAfter, { timeout: 5000 },
    ).catch(() => {});
    const posted = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").at(-1)?.content ?? "");
    check("a typed summary posts, escaped, with the rest of the details intact",
        posted.includes("<details>\n<summary>Timestamps &amp; more</summary>\n\n- `00:04` Testing.")
            && posted.includes("Listed body.\n\n  </details>")
            && posted.includes("<details>\n\n    <summary>Indented</summary>\n\n    - `00:04` Indented body.\n\n</details>"),
        JSON.stringify(posted));
}
