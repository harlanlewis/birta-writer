/**
 * The rendered diff has to be a rendering (MAR-55).
 *
 * Everything this suite asserts is invisible to jsdom, which is why it lives
 * here rather than beside diffPlan.test.ts. The unit tests own the arithmetic —
 * that positions index the document they claim to, that a plan reconstructs
 * the working document from the base. What only a browser can answer is
 * whether the plan reaches the DOM as a rendering: that a word-level change
 * marks the WORD and not the paragraph, that removed blocks come back as
 * blocks rather than as text swallowed by a paragraph, and that a widget
 * decoration survives the browser's own parsing rules for where an element may
 * sit.
 *
 * That last one is the reason the inline/block split exists at all. A `<div>`
 * placed inside a textblock's inline content is invalid HTML: the browser
 * reparents it out of the widget, and ProseMirror is then tracking a node that
 * is no longer where it drew it. jsdom will happily nest anything inside
 * anything, so it cannot see the failure this arm exists for.
 *
 *   node e2e/run.mjs renderedDiff
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".diff-doc .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => document.querySelectorAll(".diff-ins").length > 0,
        { timeout: 10000 },
    );

    const texts = (selector) => page.$$eval(selector, (els) => els.map((el) => el.textContent));

    // ── The word-level claim ────────────────────────────────────────────────
    // A one-word edit inside a sentence must mark the word. Marking the
    // paragraph is exactly the line-level behaviour this panel exists to
    // replace, and it would still leave a `.diff-ins` on the page, so
    // asserting presence alone would pass for the thing being fixed.
    const inserted = await texts(".diff-ins");
    check(
        "a one-word edit marks the word, not the paragraph",
        inserted.includes("red") && !inserted.some((t) => t.includes("jumps over the lazy")),
        `inserted runs: ${JSON.stringify(inserted)}`,
    );

    const deletedInline = await texts(".diff-del");
    check(
        "the word it replaced is shown struck through",
        deletedInline.includes("brown"),
        `inline deletions: ${JSON.stringify(deletedInline)}`,
    );

    // ── The block claim ─────────────────────────────────────────────────────
    const deletedBlocks = await page.$$eval(".diff-del-block", (els) =>
        els.map((el) => ({
            text: el.textContent,
            // What the browser ACTUALLY built, after its own parsing rules.
            children: [...el.children].map((c) => c.tagName),
            parent: el.parentElement?.tagName,
        })),
    );
    check(
        "a removed paragraph comes back as a paragraph",
        deletedBlocks.some(
            (b) => b.text.includes("going away entirely") && b.children.includes("P"),
        ),
        `deleted blocks: ${JSON.stringify(deletedBlocks)}`,
    );
    // The reparenting check: a block widget the browser moved would report a
    // parent it was never appended to.
    check(
        "no block deletion was reparented out of its widget",
        deletedBlocks.every((b) => b.parent !== "P"),
        `deleted blocks: ${JSON.stringify(deletedBlocks)}`,
    );

    // ── Navigation ──────────────────────────────────────────────────────────
    const summary = await page.$eval(".diff-summary", (el) => el.textContent);
    check("the header counts the changes", /\d+ changes? · since HEAD/.test(summary), summary);

    const nextDisabled = await page.$eval(".diff-nav-btn:last-of-type", (el) => el.disabled);
    check("navigation is offered when there are changes", nextDisabled === false, `disabled=${nextDisabled}`);

    // ── The unchanged case ──────────────────────────────────────────────────
    // Same bytes both sides: no marks, and navigation says so rather than
    // stepping through nothing.
    await page.evaluate(() => window.__setPair("# Same\n\nidentical text\n", "# Same\n\nidentical text\n"));
    await page.waitForFunction(
        () => /^0 changes/.test(document.querySelector(".diff-summary")?.textContent ?? ""),
        { timeout: 10000 },
    );
    const quiet = await page.evaluate(() => ({
        ins: document.querySelectorAll(".diff-ins").length,
        del: document.querySelectorAll(".diff-del, .diff-del-block").length,
        disabled: document.querySelector(".diff-nav-btn").disabled,
    }));
    check(
        "an unchanged file draws nothing and offers no navigation",
        quiet.ins === 0 && quiet.del === 0 && quiet.disabled === true,
        JSON.stringify(quiet),
    );

    // ── An untracked file ───────────────────────────────────────────────────
    // The empty base is not an error: every line reads as inserted, and the
    // header has to say why, or "all new" and "no repository" look alike.
    await page.evaluate(() => window.__setPair("", "# Brand new\n\nfirst draft\n", "untracked"));
    await page.waitForFunction(
        () => /not yet in git/.test(document.querySelector(".diff-summary")?.textContent ?? ""),
        { timeout: 10000 },
    );
    const fresh = await texts(".diff-ins");
    check(
        "an untracked file reads as all-inserted",
        fresh.some((t) => t.includes("first draft")),
        `inserted runs: ${JSON.stringify(fresh)}`,
    );
}
