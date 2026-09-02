/**
 * The Format picker's heading rows are toggles: clicking the filled row demotes
 * the block back to a paragraph.
 *
 * The behaviour itself lives in one registry entry and is pinned against the
 * real editor by `webview/__tests__/headingToggle.test.ts`. What that test
 * cannot reach is the claim a user actually checks, which is about the toolbar:
 * that the lit row is the one whose click clears it, and that the trigger label
 * follows. jsdom can neither hit-test a hover menu nor focus a contenteditable
 * island, so the gesture has to be driven here.
 *
 * The row read is its GLYPH (`.tb-fmt-fill-glyph`) rather than its whole text:
 * a row is a glyph plus a name plus, on a surface that binds one, a chord, and
 * an exact-match include over all of that would fail for reasons unrelated to
 * which row is filled.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector('[data-item-id="format"] .tb-fmt-label', { timeout: 10000 });
    await page.waitForTimeout(300);

    const fmtLabel = () =>
        page.$eval('[data-item-id="format"] .tb-fmt-label', (e) => e.textContent.trim());
    const filledGlyphs = () =>
        page.$$eval('[data-item-id="format"] .tb-fmt-item--on', (els) =>
            els.map((e) => (e.querySelector(".tb-fmt-fill-glyph") ?? e).textContent.trim()),
        );
    // The markdown the page has shipped to the host, which is what a save would
    // write, the outcome and not the editor's opinion of itself. Waited for,
    // never read off the last post: once the document is dirty an edit ships
    // on the sync scheduler's trailing edge (webview/syncScheduler.ts), so the
    // post on the wire right after a gesture is the previous gesture's.
    let seenUpdates = 0;
    const lastUpdate = async () => {
        await page.waitForFunction(
            (seen) => window.__posted.filter((m) => m.type === "update").length > seen,
            seenUpdates,
            { timeout: 3000 },
        ).catch(() => {});
        const { count, content } = await page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return { count: ups.length, content: ups.length ? ups[ups.length - 1].content : null };
        });
        seenUpdates = count;
        return content;
    };

    async function clickText(needle) {
        const box = await page.evaluate((needle) => {
            const walk = document.createTreeWalker(
                document.querySelector(".ProseMirror"),
                NodeFilter.SHOW_TEXT,
            );
            let n;
            while ((n = walk.nextNode())) {
                const i = n.textContent.indexOf(needle);
                if (i >= 0) {
                    n.parentElement.scrollIntoView({ block: "center" });
                    const r = document.createRange();
                    r.setStart(n, i + Math.min(2, needle.length));
                    r.setEnd(n, i + Math.min(3, needle.length));
                    const rect = r.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
            }
            return null;
        }, needle);
        if (!box) throw new Error(`text not found: ${needle}`);
        await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(80);
    }

    /**
     * Pick a Format row by its glyph, through the real hover menu.
     *
     * The rows listen on `mousedown` and the menu opens on hover, so this is
     * hover-then-mousedown rather than `element.click()`: a synthesised click
     * on a hidden row would prove the handler runs, which was never in doubt,
     * and not that the row is reachable.
     *
     * The open is waited on by the menu's own visibility rather than a fixed
     * delay. Toolbar menus open on a hover-INTENT delay (`openDelayMs`,
     * components/toolbar/hoverMenu.ts), and a hardcoded wait shorter than it
     * samples the menu before it can be there (the MAR-147 shape).
     */
    async function pickFormatRow(glyph) {
        await page.hover('[data-item-id="format"] .tb-fmt-btn');
        await page.waitForFunction(
            () => {
                const el = document.querySelector('[data-item-id="format"] .tb-fmt-menu');
                return el && getComputedStyle(el).display !== "none";
            },
            { timeout: 2000 },
        );
        const handle = await page.evaluateHandle((g) => {
            const rows = [...document.querySelectorAll('[data-item-id="format"] .tb-fmt-item')];
            return rows.find((r) => r.querySelector(".tb-fmt-fill-glyph")?.textContent.trim() === g) ?? null;
        }, glyph);
        const el = handle.asElement();
        if (!el) throw new Error(`format row not found: ${glyph}`);
        const box = await el.boundingBox();
        if (!box) throw new Error(`format row not visible: ${glyph}`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(40);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(150);
    }

    // Guard: the picker must be on the bar, or the hover cannot happen and
    // every check below would fail for a reason that is not its subject.
    const overflowed = await page.$eval(
        '[data-item-id="format"] .tb-fmt-wrap',
        (el) => !!el.closest(".tb-more-menu"),
    );
    check("Format picker renders on the bar (not overflowed)", !overflowed);

    // ── 1. The lit row is the caret's level ────────────────────────────────
    await clickText("Alpha heading");
    check("caret in H1 → trigger reads H1", (await fmtLabel()) === "H1", `label=${await fmtLabel()}`);
    check("caret in H1 → the H1 row is the filled one", (await filledGlyphs()).includes("H1"),
        `filled=${JSON.stringify(await filledGlyphs())}`);

    // ── 2. Clicking the FILLED row clears it: the toggle, as a user does it ─
    await pickFormatRow("H1");
    check("clicking the filled H1 row demotes the block", (await fmtLabel()) === "P",
        `label=${await fmtLabel()}`);
    check("and the P row is now the filled one", (await filledGlyphs()).includes("P"),
        `filled=${JSON.stringify(await filledGlyphs())}`);
    const demoted = await lastUpdate();
    check("the demotion reaches the markdown the host would save",
        demoted !== null && demoted.includes("Alpha heading") && !demoted.includes("# Alpha heading"),
        JSON.stringify(demoted));

    // ── 3. The first press is unchanged ────────────────────────────────────
    await pickFormatRow("H1");
    check("clicking H1 again promotes it back", (await fmtLabel()) === "H1",
        `label=${await fmtLabel()}`);
    const restored = await lastUpdate();
    check("the round trip returns the original markdown",
        restored !== null && restored.includes("# Alpha heading"), JSON.stringify(restored));

    // ── 4. A DIFFERENT level retypes rather than demoting ──────────────────
    // The toggle keys on the level, not on being a heading at all. Picking H2
    // on an H1 must still be a pick, or the menu stops working as a picker.
    await pickFormatRow("H2");
    check("picking H2 on an H1 retypes it, not demotes it", (await fmtLabel()) === "H2",
        `label=${await fmtLabel()}`);
    const retyped = await lastUpdate();
    check("the retype reaches the markdown", retyped !== null && retyped.includes("## Alpha heading"),
        JSON.stringify(retyped));

    // ── 5. Body stays unconditional ────────────────────────────────────────
    // setParagraph means paragraph at any level, including when P is already
    // filled: a second Body press must not toggle back to a heading.
    await clickText("Gamma heading");
    check("caret in H3 → trigger reads H3", (await fmtLabel()) === "H3", `label=${await fmtLabel()}`);
    await pickFormatRow("P");
    check("Body demotes the H3", (await fmtLabel()) === "P", `label=${await fmtLabel()}`);
    await pickFormatRow("P");
    check("Body pressed again is still a paragraph, never a toggle back",
        (await fmtLabel()) === "P", `label=${await fmtLabel()}`);
    const afterBody = await lastUpdate();
    check("Body left the text as a plain paragraph",
        afterBody !== null && afterBody.includes("Gamma heading") && !afterBody.includes("### Gamma heading"),
        JSON.stringify(afterBody));
}
