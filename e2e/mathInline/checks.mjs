/**
 * Inline-math in-place editing (MAR-74) — real-browser truths jsdom can't reach:
 *   - arrow keys ENTER the formula (per-character caret, the inline-code model)
 *     instead of skipping it or selecting it whole,
 *   - entry reveals the raw source (.math-inline--editing shows the src span,
 *     hides the KaTeX render); leaving re-renders,
 *   - pure navigation through a formula never posts an update (no dirty file),
 *   - typed edits inside the source serialize to the correct `$...$` bytes in
 *     the posted update — the end-to-end fidelity proof,
 *   - Backspace against the right edge reveals instead of invisibly deleting,
 *   - `$` typed at the source end exits the formula (close-the-delimiter),
 *   - emptying the source then leaving deletes the node,
 *   - clicking the rendered formula puts the caret in the source.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".math-inline", { timeout: 10000 });
    await page.waitForTimeout(400); // KaTeX lazy render

    const math = (i = 0) => `.ProseMirror .math-inline >> nth=${i}`;
    const editing = (i = 0) =>
        page.$eval(`.ProseMirror .math-inline >> nth=${i}`, (el) => el.classList.contains("math-inline--editing"));
    const srcVisible = (i = 0) =>
        page.$eval(`.ProseMirror .math-inline >> nth=${i}`,
            (el) => getComputedStyle(el.querySelector(".math-inline-src")).display !== "none");
    const renderVisible = (i = 0) =>
        page.$eval(`.ProseMirror .math-inline >> nth=${i}`,
            (el) => getComputedStyle(el.querySelector(".math-inline-render")).display !== "none");
    const updates = () =>
        page.evaluate(() => window.__posted.filter((m) => m.type === "update").map((m) => m.content));
    // Updates are debounced (300ms in editor.ts) — poll for the one we expect.
    async function lastUpdateMatching(predicate, timeoutMs = 3000) {
        const startAt = Date.now();
        for (;;) {
            const all = await updates();
            const last = all[all.length - 1];
            if (last !== undefined && predicate(last)) return last;
            if (Date.now() - startAt > timeoutMs) return last ?? null;
            await page.waitForTimeout(100);
        }
    }
    const press = async (key, times = 1) => {
        for (let i = 0; i < times; i++) {
            await page.keyboard.press(key);
            await page.waitForTimeout(30);
        }
    };

    // Click in the text before the first formula: "before $a+b$ after"
    async function caretInTextBefore() {
        const box = await page.evaluate(() => {
            const walk = document.createTreeWalker(document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walk.nextNode())) {
                const i = n.textContent.indexOf("before");
                if (i >= 0) {
                    const r = document.createRange();
                    r.setStart(n, i + 2); r.setEnd(n, i + 3);
                    const rect = r.getBoundingClientRect();
                    return { x: rect.x, y: rect.y + rect.height / 2 };
                }
            }
            return null;
        });
        await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(60);
    }

    // ── 1. Idle state: KaTeX shown, source hidden ──
    check("idle: render visible", await renderVisible());
    check("idle: source hidden", !(await srcVisible()));
    check("idle: not marked editing", !(await editing()));

    // ── 2. Arrow into the formula from the left (through "fore ") ──
    await caretInTextBefore();
    const updatesBeforeNav = (await updates()).length;
    // caret is a few chars into "before"; walk right until inside the formula
    let entered = false;
    for (let i = 0; i < 14 && !entered; i++) {
        await press("ArrowRight");
        entered = await editing();
    }
    check("ArrowRight enters the formula (reveal)", entered);
    check("editing: source visible", await srcVisible());
    check("editing: render hidden", !(await renderVisible()));

    // ── 3. Per-character caret inside: walk the source end to end ──
    // Source is "a+b" (3 chars): from inside-start, 3 more rights stay inside,
    // the 4th exits — proving positions exist per character.
    let stepsInside = 0;
    while ((await editing()) && stepsInside < 10) {
        await press("ArrowRight");
        stepsInside++;
    }
    check("caret steps through the source per character then exits", stepsInside >= 3 && stepsInside <= 5, `steps=${stepsInside}`);
    check("after exit: render restored", await renderVisible());
    check("after exit: source hidden again", !(await srcVisible()));

    // ── 4. Fidelity: pure navigation never posted an update ──
    const updatesAfterNav = (await updates()).length;
    check("navigation through a formula posts NO update (never dirties)", updatesAfterNav === updatesBeforeNav, `before=${updatesBeforeNav} after=${updatesAfterNav}`);

    // ── 5. Backspace against the right edge reveals instead of deleting ──
    // Caret sits just after the formula now.
    await press("Backspace");
    check("Backspace at the edge reveals (no deletion)", await editing());
    const contentAfterReveal = (await updates()).length;
    check("that Backspace posted no update", contentAfterReveal === updatesAfterNav);

    // ── 6. Edit the source and verify the serialized bytes ──
    // Caret is at inside-end ("a+b|"). Type "+c" → "a+b+c".
    await page.keyboard.type("+c");
    const edited = await lastUpdateMatching((c) => c.includes("$a+b+c$"));
    check("typed edit posts an update", edited !== null);
    check("the update serializes the edited formula as $a+b+c$", !!edited?.includes("$a+b+c$"), JSON.stringify(edited ?? "").slice(0, 80));

    // ── 7. `$` at the end exits the formula without inserting ──
    check("precondition: still editing", await editing());
    await page.keyboard.type("$");
    await page.waitForTimeout(60);
    check("typing $ at the end exits the formula", !(await editing()));
    await page.waitForTimeout(500); // let any (wrong) update flush
    const afterDollar = (await updates()).pop();
    check("the $ was not inserted into the source", !afterDollar?.includes("$a+b+c$$") && !!afterDollar?.includes("$a+b+c$"));

    // ── 8. KaTeX re-rendered the edited source on exit ──
    await page.waitForTimeout(300);
    check("render face is back after the edit", await renderVisible());

    // ── 9. Backspacing out the whole source removes the formula ──
    // (Native deletion of the last char in the live DOM removes the node
    // eagerly; the appendTransaction net covers programmatic paths — jsdom
    // tests pin that. Either way: all chars gone → formula gone.)
    const mathCountBefore = await page.$$eval(".ProseMirror .math-inline", (els) => els.length);
    check("two formulas at start of scenario 9", mathCountBefore === 2);
    await page.click(math(1)); // click the rendered formula → caret inside
    await page.waitForTimeout(60);
    check("clicking the render puts the caret in the source", await editing(1));
    await press("Backspace", 3); // "x^2" → gone
    await caretInTextBefore(); // settle the caret elsewhere
    await page.waitForTimeout(200);
    const mathCountAfter = await page.$$eval(".ProseMirror .math-inline", (els) => els.length);
    check("backspacing out the source deletes the formula", mathCountAfter === 1, `count=${mathCountAfter}`);
    const finalDoc = await lastUpdateMatching((c) => !c.includes("x^2"));
    check("the deletion serialized (no $x^2$ left)", finalDoc !== null && !finalDoc.includes("x^2"));
}
