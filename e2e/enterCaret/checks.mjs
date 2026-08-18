/**
 * Return must leave the caret in the block it just made.
 *
 * The empty paragraph a Return creates holds nothing but widget decorations:
 * the empty-line hint and the block-handle gutter, both `contenteditable=false`.
 * When the hint sorted AFTER the caret's own position, WebKit could not hold an
 * insertion point in front of it and re-anchored to the end of the previous
 * block, so the next character typed landed on the previous line. One such
 * widget is enough; the gutter is beside it but not part of the cause.
 * Chromium tolerated the arrangement, so the whole class of defect was
 * invisible to a Chromium-only sweep and shipped in Jot, which renders in
 * WebKit.
 *
 * Run under BOTH engines. The typing arms only go red in WebKit, but the
 * widget-order arm pins the mechanism in either, so a Chromium sweep still
 * catches a regression of the fix.
 *   node e2e/run.mjs enterCaret
 *   BIRTA_E2E_BROWSER=webkit node e2e/run.mjs enterCaret
 */
export async function run({ page, check, baseUrl }) {
    async function mount() {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /Some text/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
    }
    const topBlocks = () =>
        page.$$eval(".ProseMirror > *", (els) => els.map((el) => `${el.tagName}:${el.textContent}`));

    /** Where the caret is now: its top-level block index and DOM offset. */
    const caretAt = () => page.evaluate(() => {
        const sel = document.getSelection();
        const root = document.querySelector(".ProseMirror");
        let el = sel?.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel?.anchorNode;
        while (el && el.parentElement !== root) { el = el.parentElement; }
        return { block: el ? [...root.children].indexOf(el) : -1, offset: sel?.anchorOffset ?? -1 };
    });

    /**
     * Put the caret in the first paragraph, `back` characters from its end,
     * and confirm it landed there. The click and the arrow keys can race a
     * mount that is still settling, and a probe that missed its target would
     * otherwise report the editor's failure rather than its own — so this
     * retries the placement and returns whether it ever succeeded.
     */
    async function placeCaret(back) {
        for (let attempt = 0; attempt < 3; attempt++) {
            await page.locator(".milkdown .ProseMirror p").first().click();
            await page.keyboard.press("End");
            for (let i = 0; i < back; i++) { await page.keyboard.press("ArrowLeft"); }
            await page.waitForTimeout(150);
            const at = await caretAt();
            if (at.block === 1 && at.offset === "Some text.".length - back) { return at; }
            await page.waitForTimeout(300);
        }
        return await caretAt();
    }

    // ── Return at the END of a paragraph: the new block is empty, so it is
    // the one the hint decorates, and it is the case that broke. ───────────
    await mount();
    const endCaret = await placeCaret(0);
    check("the probe put the caret at the end of the paragraph", endCaret.block === 1 && endCaret.offset === 10,
        JSON.stringify(endCaret));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    // The state under test was actually reached: without this, a build that
    // dropped the hint entirely would satisfy every assertion below while
    // exercising none of the arrangement they exist to pin.
    const decorated = await page.evaluate(() => {
        const p = document.querySelectorAll(".ProseMirror > p")[1];
        const kids = [...(p?.childNodes ?? [])];
        const hint = p?.querySelector(".md-empty-hint-text");
        const sel = document.getSelection();
        // Where the caret sits INSIDE this paragraph, against where the hint
        // sits. The invariant is between the widget and the caret, not between
        // one widget and another: a single uneditable widget in front of the
        // caret is enough to break it, whether or not the block-handle gutter
        // happens to be beside it.
        const caretIndex = sel?.anchorNode === p ? sel.anchorOffset : -1;
        const hintIndex = hint ? kids.indexOf(hint) : -1;
        return {
            hasHint: !!hint,
            caretIndex,
            hintIndex,
            hintBeforeCaret: hintIndex >= 0 && caretIndex > hintIndex,
            kinds: kids.filter((n) => n.nodeType === 1).map((n) => n.className || n.nodeName),
        };
    });
    check("the new empty paragraph carries the empty-line hint widget", decorated.hasHint, JSON.stringify(decorated.kinds));
    check("the caret is in that paragraph, not still in the one above",
        decorated.caretIndex >= 0, JSON.stringify(decorated));
    check("the hint sorts before the caret's own position (side: -1)",
        decorated.hintBeforeCaret, JSON.stringify(decorated));

    await page.keyboard.type("Next", { delay: 40 });
    await page.waitForTimeout(400);
    const after = await topBlocks();
    check("text typed after Return lands in the NEW paragraph, not the previous one",
        after[1] === "P:Some text." && after[2]?.startsWith("P:Next"), JSON.stringify(after.slice(0, 4)));

    const serialized = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update").map((m) => m.content);
        return updates[updates.length - 1] ?? "";
    });
    check("and the document serializes as two paragraphs", /Some text\.\n\nNext/.test(serialized),
        JSON.stringify(serialized.slice(0, 60)));

    // ── Return in the MIDDLE: the new block is non-empty, so no hint. This
    // arm held throughout, and it is here so a suite that fails everything
    // (a broken mount, a 404 bundle) is distinguishable from this defect. ──
    await mount();
    const midCaret = await placeCaret(5);
    check("the probe put the caret mid-paragraph", midCaret.block === 1 && midCaret.offset === 5,
        JSON.stringify(midCaret));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.type("Next", { delay: 40 });
    await page.waitForTimeout(400);
    const mid = await topBlocks();
    check("a mid-paragraph Return also leaves the caret in the new block",
        mid[1] === "P:Some " && mid[2] === "P:Nexttext.", JSON.stringify(mid.slice(0, 4)));
}
