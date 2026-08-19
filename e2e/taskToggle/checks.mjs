/**
 * Ticking the task the caret is in.
 *
 * Driven through the `editorCommand` message, which is the path BOTH surfaces
 * use: a VS Code keybinding routes through it, and Jot's Edit-menu item routes
 * through it. Asserting the serialized markdown rather than the DOM, because
 * the markdown is what reaches the file and a checkbox rendered as ticked over
 * an unticked document would be the bug this guards.
 */
export async function run({ page, check, baseUrl }) {
    /**
     * The document as MARKDOWN, asked for the way the host asks: a `flushSave`,
     * answered with a `flushResult` carrying the serialized bytes.
     *
     * Not the `update` stream. A command's edit is a doc change like any other,
     * but what schedules an `update` is the sync scheduler, and waiting on it
     * makes the assertion about timing rather than about the edit. The flush is
     * the same path a save takes and answers immediately.
     */
    let flushSeq = 0;
    const doc = async () => {
        const id = `probe-${++flushSeq}`;
        await page.evaluate((flushId) =>
            window.postMessage({ type: "flushSave", id: flushId }, "*"), id);
        await page.waitForFunction(
            (flushId) => window.__posted.some((m) => m.type === "flushResult" && m.id === flushId),
            id, { timeout: 5000 });
        return page.evaluate((flushId) =>
            window.__posted.find((m) => m.type === "flushResult" && m.id === flushId).content, id);
    };

    /** Put the caret in the paragraph whose text starts with `text`. */
    async function caretIn(text) {
        await page.evaluate((needle) => {
            const p = [...document.querySelectorAll(".ProseMirror li p")]
                .find((el) => (el.textContent ?? "").trim().startsWith(needle));
            if (!p) { throw new Error(`no list paragraph starting "${needle}"`); }
            const range = document.createRange();
            range.setStart(p.firstChild ?? p, 1);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.querySelector(".ProseMirror").focus();
        }, text);
        await page.waitForTimeout(120);
    }

    /**
     * Run the command and WAIT FOR THE UPDATE, rather than for a guessed
     * interval. The sync scheduler decides when the host hears about an edit,
     * and a fixed sleep shorter than its window reads as "the command did
     * nothing" when the document had in fact already changed.
     */
    const toggle = async () => {
        const before = await page.evaluate(
            () => window.__posted.filter((m) => m.type === "update").length);
        await page.evaluate(() =>
            window.postMessage({ type: "editorCommand", command: "toggleTaskChecked" }, "*"));
        await page.waitForFunction(
            (n) => window.__posted.filter((m) => m.type === "update").length > n,
            before, { timeout: 5000 },
        ).catch(() => {});
    };

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => /open task/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
        { timeout: 10000 });
    await page.waitForTimeout(300);

    // The instrument first: a harness that never reached the document would
    // report every assertion below as a pass.
    const start = await page.evaluate(
        () => document.querySelectorAll(".ProseMirror li").length);
    check("the harness mounted the task list", start >= 5, `list items=${start}`);

    // ── An open task ticks ──
    await caretIn("open task");
    await toggle();
    let md = await doc();
    check("an open task ticks from a caret in its text", /- \[x\] open task/.test(md ?? ""),
        JSON.stringify(md));

    // ── And unticks again: the same key both ways ──
    await toggle();
    md = await doc();
    check("…and the same command unticks it", /- \[ \] open task/.test(md ?? ""), JSON.stringify(md));

    // ── A ticked task unticks ──
    await caretIn("done task");
    await toggle();
    md = await doc();
    check("a done task unticks", /- \[ \] done task/.test(md ?? ""), JSON.stringify(md));

    // ── A nested task ticks ITSELF, not the parent ──
    await caretIn("nested task");
    await toggle();
    md = await doc();
    check("a nested task ticks itself", /- \[x\] nested task/.test(md ?? ""), JSON.stringify(md));
    check("…and leaves its parent alone", /- \[ \] parent/.test(md ?? ""), JSON.stringify(md));

    // ── A plain bullet is not a task and must not become one ──
    const before = await doc();
    await caretIn("plain bullet");
    await toggle();
    md = await doc();
    check("a plain bullet does not become a task", /- plain bullet/.test(md ?? "")
        && !/\[[ x]\] plain bullet/.test(md ?? ""), JSON.stringify(md));
    // `before` has to be a real document, or "unchanged" is two nulls agreeing.
    check("…and nothing else moved either",
        typeof before === "string" && before.length > 0 && md === before,
        JSON.stringify({ before, md })); 

    const errors = await page.evaluate(() => window.__pageErrors ?? []);
    check("no page errors", errors.length === 0, JSON.stringify(errors));
}
