/**
 * `/ai` argument mode (MAR-371), driven with REAL key events in a real browser.
 *
 * Why this suite exists rather than only the jsdom plugin tests: the behavior
 * is decided by which keydown listener wins. The plugin listens in the CAPTURE
 * phase on the editor root so it runs before ProseMirror's keymaps, and the two
 * keys it has to get right pull in opposite directions.
 *
 *   - Space must NOT be claimed. The plugin records the commit and lets the
 *     event through, so ProseMirror types the space as ordinary document text.
 *     A jsdom test cannot see that, because jsdom has no contenteditable and
 *     ProseMirror never inserts the character there.
 *   - Enter MUST be claimed. Unclaimed, ProseMirror splits the block, so a
 *     submission would leave the prompt text behind in two paragraphs. Again
 *     invisible to jsdom, where the default action does not exist.
 *
 * AGENTS.md names this exact class ("anything ... depending on which listener
 * wins needs an e2e check dispatching a real event"), and MAR-277 is the bug
 * that made it a rule.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(200);

    const settle = () =>
        page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    /** Put the caret in the empty trailing paragraph. */
    const caretToLastBlock = async () => {
        await page.evaluate(() => {
            const blocks = document.querySelectorAll(".milkdown .ProseMirror > *");
            const last = blocks[blocks.length - 1];
            const range = document.createRange();
            range.selectNodeContents(last);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await settle();
    };

    const menuOpen = () =>
        page.evaluate(() => {
            const el = document.getElementById("md-slash-menu");
            return el !== null && el.style.display !== "none";
        });

    const docText = () =>
        page.evaluate(() => document.querySelector(".milkdown .ProseMirror").textContent);

    const blockCount = () =>
        page.evaluate(() => document.querySelectorAll(".milkdown .ProseMirror > *").length);

    const posted = () => page.evaluate(() => window.__posted.filter((m) => m.type === "invokeAgent"));

    // ── Space is not claimed: it becomes document text and arms the row ──────
    // Enter first, so the slash sits at the START of a fresh block: the slash
    // construct only opens at a block start or after whitespace (paths like
    // /usr/bin must never trigger it), and typing "/" straight after "." would
    // legitimately match nothing.
    await caretToLastBlock();
    await page.keyboard.press("Enter");
    await settle();
    await page.keyboard.type("/ai");
    await settle();
    check("the gated row appears once birta.ai.enabled is on", await menuOpen());

    const blocksBefore = await blockCount();
    await page.keyboard.press("Space");
    await settle();

    check("Space keeps the menu open instead of ending the slash construct", await menuOpen());
    // The space reached ProseMirror: without it the construct would read "/ai".
    const afterSpace = await docText();
    check(
        "Space is typed as document text rather than swallowed",
        afterSpace.includes("/ai "),
        JSON.stringify(afterSpace),
    );

    // ── The prompt is ordinary typing, spaces and all ────────────────────────
    await page.keyboard.type("add a mermaid diagram of the auth flow");
    await settle();
    const withPrompt = await docText();
    check(
        "a multi-word prompt types through without re-filtering the menu",
        withPrompt.includes("/ai add a mermaid diagram of the auth flow"),
        JSON.stringify(withPrompt),
    );
    check("the menu is still open while the prompt is typed", await menuOpen());

    // ── Enter IS claimed: it submits instead of splitting the block ──────────
    await page.keyboard.press("Enter");
    await settle();

    const messages = await posted();
    check("Enter posts exactly one invokeAgent", messages.length === 1, `n=${messages.length}`);
    check(
        "the posted prompt is what was typed, without the /ai prefix",
        messages[0]?.prompt === "add a mermaid diagram of the auth flow",
        JSON.stringify(messages[0]?.prompt ?? null),
    );
    const afterSubmit = await docText();
    check(
        "the whole /ai construct is deleted from the document",
        !afterSubmit.includes("/ai"),
        JSON.stringify(afterSubmit),
    );
    const blocksAfter = await blockCount();
    check(
        "Enter did not also split the block (ProseMirror never saw it)",
        blocksAfter === blocksBefore,
        `before=${blocksBefore} after=${blocksAfter}`,
    );
    check("the menu closed on submit", (await menuOpen()) === false);

    // ── Space on a row that takes no argument keeps its filter meaning ───────
    await caretToLastBlock();
    await page.keyboard.press("Enter");
    await settle();
    await page.keyboard.type("/table");
    await settle();
    await page.keyboard.press("Space");
    await settle();
    check(
        "Space on a non-argument row ends the construct as before",
        (await menuOpen()) === false,
    );
    const finalMessages = await posted();
    check(
        "and posts nothing",
        finalMessages.length === 1,
        `n=${finalMessages.length}`,
    );
}
