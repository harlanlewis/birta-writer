/**
 * Go to Line, in a real browser.
 *
 * The unit tests hold the parse rule and the prompt's three ways out against
 * a fake host. What only a layout engine can answer is what the reveal DOES:
 * that a document line typed into the prompt scrolls the block that holds
 * that line onto the screen, that Enter puts the caret in that block and
 * Escape puts the scroll back, and that the number the prompt takes is the
 * number the gutter paints beside the same text, frontmatter counted, so a
 * line quoted from a diff lands where the diff meant.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(400);

    const settle = async () => {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.waitForTimeout(150);
    };
    const runCommand = (id) => page.evaluate((command) =>
        window.postMessage({ type: "editorCommand", command }, "*"), id);
    const promptOpen = () => page.evaluate(() =>
        !!document.querySelector(".goto-line--visible") && document.activeElement?.classList.contains("goto-line__input"));
    const hint = () => page.$eval(".goto-line__hint", (el) => el.textContent);
    const scrollY = () => page.evaluate(() => window.scrollY);
    /** Whether the block whose text contains `needle` is inside the viewport. */
    const onScreen = (needle) => page.evaluate((text) => {
        const el = [...document.querySelectorAll(".ProseMirror > *")].find((b) => b.textContent.includes(text));
        if (!el) { return null; }
        const box = el.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
    }, needle);
    /** The text of the block the caret is in. */
    const caretBlockText = () => page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel?.anchorNode;
        const block = node instanceof Element ? node : node?.parentElement;
        return block?.closest(".ProseMirror > *")?.textContent ?? null;
    });

    const at = await page.evaluate(() => window.__at);
    const documentLines = await page.evaluate(() => window.__documentLines);
    check("the fixture's target is off screen before anything happens", (await onScreen("marker40")) === false);

    // ── Open, and the prompt knows the document's length ─────────────
    await runCommand("gotoLine");
    await page.waitForTimeout(400);
    check("the gotoLine command opens the prompt with the field focused", await promptOpen());
    const opened = await hint();
    check("the hint names the document's line count, frontmatter counted",
        opened.includes(String(documentLines)), opened);
    const openedAt = await scrollY();

    // ── Typing previews: the line's block comes on screen, the caret stays ──
    await page.keyboard.type(String(at.para40));
    await settle();
    check("typing a line scrolls the block holding that line onto the screen",
        (await onScreen("marker40")) === true, `line ${at.para40}, scrollY ${await scrollY()}`);
    check("the preview moves the scroll and not the caret",
        !((await caretBlockText()) ?? "").includes("marker40"));

    // The gutter paints the same number beside the same text, which is the
    // claim the prompt makes about what a line number means here.
    const gutterAgrees = await page.evaluate((line) => {
        const numbers = [...document.querySelectorAll(".line-number")].filter((el) => !el.hidden);
        const painted = numbers.find((el) => Number(el.textContent) === line);
        if (!painted) { return { painted: false }; }
        const block = [...document.querySelectorAll(".ProseMirror > *")].find((b) => b.textContent.includes("marker40"));
        const top = Number.parseFloat(painted.style.top);
        const box = block.getBoundingClientRect();
        const blockTop = box.top + window.scrollY;
        return { painted: true, top, blockTop, blockBottom: blockTop + box.height };
    }, at.para40);
    check("the gutter paints that same number beside the block the prompt revealed",
        gutterAgrees.painted && gutterAgrees.top >= gutterAgrees.blockTop - 1 && gutterAgrees.top <= gutterAgrees.blockBottom,
        JSON.stringify(gutterAgrees));

    // ── Escape puts the scroll back ──────────────────────────────────
    await page.keyboard.press("Escape");
    await settle();
    check("Escape closes the prompt", !(await promptOpen()));
    check("and puts the scroll back where the prompt opened",
        Math.abs((await scrollY()) - openedAt) <= 1, `${await scrollY()} vs ${openedAt}`);
    check("the editor has the keyboard back",
        await page.evaluate(() => document.activeElement?.closest(".ProseMirror") !== null));

    // ── Enter lands the caret in the block and closes ────────────────
    await runCommand("gotoLine");
    await page.waitForTimeout(300);
    await page.keyboard.type(String(at.para55));
    await page.keyboard.press("Enter");
    await settle();
    check("Enter closes the prompt", !(await promptOpen()));
    check("and the block holding the line is on screen", (await onScreen("marker55")) === true);
    check("and the caret is in that block", ((await caretBlockText()) ?? "").includes("marker55"), await caretBlockText());

    // ── A line past the end is refused, and Enter keeps the prompt ───
    await runCommand("gotoLine");
    await page.waitForTimeout(300);
    const before = await scrollY();
    // At once rather than key by key: the digits on the way to a number past
    // the end are lines of their own, and each of those previews.
    await page.fill(".goto-line__input", String(documentLines + 50));
    await settle();
    const refused = await page.evaluate(() => !!document.querySelector(".goto-line__hint--refused"));
    check("a line past the end is refused in the hint", refused, await hint());
    check("and nothing scrolls for it", Math.abs((await scrollY()) - before) <= 1);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check("Enter on a refused line keeps the prompt open", await promptOpen());
    await page.keyboard.press("Escape");
    await settle();

    // ── The first line of the frontmatter is a document line too ─────
    await runCommand("gotoLine");
    await page.waitForTimeout(300);
    await page.keyboard.type("1");
    await page.keyboard.press("Enter");
    await settle();
    check("line 1 (the frontmatter fence) is accepted and the document is at its top",
        (await scrollY()) <= 1, String(await scrollY()));
    check("and the caret lands on the body's first line, since the frontmatter has no caret position",
        ((await caretBlockText()) ?? "").includes("Go to line"), await caretBlockText());
}
