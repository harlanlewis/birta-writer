/**
 * Ticking the task the caret is in, and what the tick says to a screen reader.
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

    /**
     * The ACCESSIBILITY state of every list item, in document order: its own
     * first line, and the `aria-checked` of the control inside it (null when
     * there is no control).
     *
     * Read off the `li` elements rather than off a list of texts we expect, so
     * an item that lost its control shows up as a row with a null in it rather
     * than as a row nobody looked for.
     */
    const ariaStates = () => page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror li")].map((li) => ({
            text: (li.querySelector(":scope > p")?.textContent ?? "").trim(),
            aria: li.querySelector(":scope > [role=checkbox]")?.getAttribute("aria-checked") ?? null,
        })));

    /**
     * The same thing, read off the MARKDOWN the flush returns.
     *
     * The document is the oracle, which is what stops this being a check that a
     * once-correct attribute is still there. Every assertion above already
     * establishes what the markdown says; comparing the accessibility tree
     * against it asks whether the two agree AFTER the gesture, which an
     * `aria-checked` frozen at the value it was first painted with cannot do.
     */
    const ariaFromMarkdown = (md) =>
        (md ?? "").split("\n")
            .filter((line) => /^\s*[-*]\s/.test(line))
            .map((line) => {
                const task = /^\s*[-*]\s+\[([ x])\]\s+(.*)$/.exec(line);
                if (task) { return { text: task[2], aria: task[1] === "x" ? "true" : "false" }; }
                return { text: line.replace(/^\s*[-*]\s+/, ""), aria: null };
            });

    /** Assert the two agree, and that the reading found any task at all. */
    async function checkAria(when) {
        const [tree, md] = [await ariaStates(), await doc()];
        const expected = ariaFromMarkdown(md);
        check(`${when}: every task's accessible state is the state on disk`,
            JSON.stringify(tree) === JSON.stringify(expected),
            JSON.stringify({ tree, expected, md }));
        // A reading that found no control would agree with a markdown parse
        // that found no task, so pin the count the fixture actually has.
        check(`${when}: …read off four real checkbox controls`,
            tree.filter((row) => row.aria !== null).length === 4, JSON.stringify(tree));
    }

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

    // ── What a screen reader is handed (MAR-403) ──
    //
    // The tick is drawn in `::before`/`::after` with `content: ""` and the
    // completion cue is `text-decoration: line-through`; neither reaches the
    // accessibility tree, so the tree is the only place this can be asked. Only
    // a real engine computes it, which is why it is asked here rather than in a
    // jsdom unit test.
    const snapshot = await page.locator(".ProseMirror ul").first().ariaSnapshot();
    check("the accessibility tree tells a done task from an open one",
        /checkbox[^\n]*\[checked\]/.test(snapshot) && /- checkbox "Task"\s*$/m.test(snapshot),
        snapshot);
    // The control must not have been put on the `li` itself: `role=checkbox` is
    // name-from-contents and children-presentational there, so the item stops
    // being a listitem and its name swallows its own text and the
    // block-options button's label with it.
    check("…and a task item is still a list item holding its own text",
        /- listitem:/.test(snapshot) && /paragraph: open task/.test(snapshot)
        && !/checkbox "[^"]*open task/.test(snapshot), snapshot);
    // Every control names ITSELF. A role on the `li` takes its name from the
    // item's contents instead, so each one comes back carrying the item's text
    // and the labels of whatever chrome is inside it.
    const names = [...snapshot.matchAll(/- checkbox "([^"]*)"/g)].map((m) => m[1]);
    check("…and every checkbox is named for the control, not for the item",
        names.length === 4 && names.every((name) => name === "Task"), JSON.stringify(names));
    // The nested task, between its parent's line and its own, is still an item
    // of a list rather than something folded into the parent's name.
    const parentToNested = snapshot.split("paragraph: parent")[1]?.split("paragraph: nested task")[0] ?? "";
    check("…and a parent task's sub-list is still a list of items",
        /- list:/.test(parentToNested) && /- listitem:/.test(parentToNested), snapshot);
    await checkAria("at first paint");

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
    // Four ticks have moved by now, in both directions, so a control rendered
    // once and never re-rendered no longer matches the file.
    await checkAria("after the command route");

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

    // ── The MOUSE route, which is the one the first-run tour teaches ──
    //
    // Every check above drives `toggleTaskChecked`, the command both surfaces
    // route a keybinding through. Clicking the drawn box is a different path
    // entirely: a capture-phase document listener in `webview/index.ts` with an
    // x-coordinate hit test (`isTaskCheckboxClick` in `utils/taskCheckbox.ts`,
    // which measures against its own `CHECKBOX_COLUMN_WIDTH` rather than
    // against the item's CSS padding), because the box is a pseudo-element and
    // cannot be an event target of its own. Nothing here exercised it, so a
    // change to that constant, to the column the box is drawn in, or to the
    // listener's phase would have left this suite green.
    //
    // It is pinned rather than merely covered because the tour a first launch
    // opens on now instructs somebody to click that box, and a broken gesture
    // there is the first thing a new user would meet.
    const beforeClick = await doc();
    const target = await page.evaluate(() => {
        const li = [...document.querySelectorAll('.ProseMirror li[data-item-type="task"]')]
            .find((el) => (el.textContent ?? "").includes("open task"));
        if (!li) { throw new Error("no open task item"); }
        const r = li.getBoundingClientRect();
        // Inside the column the box is drawn in, left of the text.
        return { x: r.left + 7, y: r.top + 12 };
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(400);
    md = await doc();
    check("clicking the drawn box ticks the task", /- \[x\] open task/.test(md ?? ""),
        JSON.stringify({ beforeClick, md }));
    // The click must not have been a document-wide toggle: everything else holds.
    check("…and touches nothing else", /- \[ \] parent/.test(md ?? "")
        && /- plain bullet/.test(md ?? ""), JSON.stringify(md));

    // A click in the TEXT must place the caret and leave the box alone, or the
    // hit test has stopped discriminating and every click is a toggle.
    const textPoint = await page.evaluate(() => {
        const p = [...document.querySelectorAll('.ProseMirror li[data-item-type="task"] p')]
            .find((el) => (el.textContent ?? "").includes("open task"));
        const r = p.getBoundingClientRect();
        return { x: r.left + Math.min(30, r.width / 2), y: r.top + r.height / 2 };
    });
    await page.mouse.click(textPoint.x, textPoint.y);
    await page.waitForTimeout(400);
    const afterText = await doc();
    check("a click in the text does not toggle", afterText === md,
        JSON.stringify({ md, afterText }));
    await checkAria("after the mouse route");

    const errors = await page.evaluate(() => window.__pageErrors ?? []);
    check("no page errors", errors.length === 0, JSON.stringify(errors));
}
