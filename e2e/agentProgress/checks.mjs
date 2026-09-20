/**
 * The corner notice a live `/ai` run draws (MAR-464), in a browser.
 *
 * What only an engine can answer here is the POINTER. The notice's node
 * outlives every message on it and is laid out at zero opacity between them,
 * so whether a corner of the document is still clickable is a question about
 * hit testing rather than about class lists, and jsdom has no answer to it.
 * Two arms below drive real clicks at the corner and read where they landed:
 * one while a notice is up, one after everything has gone. The second pins
 * that a dismissed failure pill, laid out at zero opacity, takes no click
 * from the document under it.
 *
 * Everything about WHAT the notice says is in webview/__tests__/agentPending,
 * over the plugin state; this suite deliberately asserts as little of the
 * wording as it can get away with.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => /line 59 of the note/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
        { timeout: 10000 },
    );
    await page.waitForTimeout(300);

    const post = (msg) => page.evaluate((m) => window.postMessage(m, "*"), msg);

    /**
     * Start a run the way a user does, and confirm it the way the host does.
     *
     * The id has to come from the page: a run exists only once the editor has
     * registered one at the caret, so a `running` report for an id nobody
     * asked for is correctly ignored, and a suite that invented one would
     * assert against a corner that was never going to say anything.
     */
    const startRun = async (needle, harness) => {
        await page.evaluate((text) => {
            const el = [...document.querySelectorAll(".ProseMirror p")]
                .find((e) => e.textContent.includes(text));
            const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
            document.querySelector(".ProseMirror").focus();
            const range = document.createRange();
            range.setStart(node, 0);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }, needle);
        await page.waitForTimeout(120);
        // The row is committed with Space before the request is typed; typing
        // it all at once leaves the slash menu open and posts nothing.
        await page.keyboard.type("/ai", { delay: 60 });
        await page.waitForTimeout(200);
        await page.keyboard.press("Space");
        await page.waitForTimeout(150);
        await page.keyboard.type("do a thing", { delay: 20 });
        await page.waitForTimeout(120);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(250);
        const id = await page.evaluate(
            () => window.__posted.filter((m) => m.type === "askAgent").at(-1)?.requestId ?? null);
        if (id !== null) {
            await post({ type: "agentRun", requestId: id, status: "running", harness });
            await page.waitForTimeout(200);
        }
        return id;
    };
    const corner = () => page.evaluate(() => {
        const el = document.querySelector(".agent-toast");
        if (!el) { return null; }
        const box = el.getBoundingClientRect();
        return {
            text: el.textContent,
            visible: el.classList.contains("agent-toast--visible"),
            live: el.getAttribute("aria-live"),
            count: document.querySelectorAll(".agent-toast").length,
            box: { x: box.x, y: box.y, w: box.width, h: box.height },
        };
    });
    /** What a real click at the middle of the corner's pill actually hits. */
    const clickAtCorner = async (box) => {
        const x = box.x + box.w / 2;
        const y = box.y + box.h / 2;
        const hit = await page.evaluate(([cx, cy]) => {
            const el = document.elementFromPoint(cx, cy);
            return el ? `${el.tagName}.${el.className}` : "nothing";
        }, [x, y]);
        await page.mouse.click(x, y);
        await page.waitForTimeout(80);
        return hit;
    };

    // ── 1. A run with nothing said about it yet ─────────────────────
    check("the corner says nothing before a run", (await corner()) === null,
        JSON.stringify(await corner()));

    const id = await startRun("line 3 of the note", "claude");
    check("a run was started before anything is asked of the corner", id !== null, String(id));
    let now = await corner();
    check("a running run puts a line in the corner naming its harness",
        now !== null && now.visible && now.text.includes("claude"), JSON.stringify(now));
    check("and it is one node, not a stack", now !== null && now.count === 1, JSON.stringify(now));
    check("and it is not announced, because it rewrites itself on a clock",
        now !== null && now.live === "off", JSON.stringify(now));

    // ── 2. A progress line replaces it in place ──────────────────────
    await post({ type: "agentProgress", requestId: id, line: "Read plan.md" });
    await page.waitForTimeout(150);
    now = await corner();
    check("a progress line replaces the corner's words",
        now !== null && now.text.includes("Read plan.md"), JSON.stringify(now));
    check("still one node after a second message",
        now !== null && now.count === 1, JSON.stringify(now));

    // ── 3. The notice must not take the corner's clicks ─────────────
    // It offers nothing to click, so a click aimed past it belongs to the
    // document. Quiet, in the DESIGN_PRINCIPLES sense, includes not standing
    // in the way for the length of a run.
    const overNotice = await clickAtCorner(now.box);
    check("a click at the corner reaches the document under the notice",
        !overNotice.includes("agent-toast"), overNotice);

    // ── 4. A failure takes the corner, and that one IS clickable ────
    await post({ type: "agentRun", requestId: id, status: "failed", harness: "claude",
                 message: "exit code 2" });
    await page.waitForTimeout(200);
    now = await corner();
    check("the failure replaces the notice on the same one node",
        now !== null && now.visible && now.text.includes("exit code 2") && now.count === 1,
        JSON.stringify(now));
    check("and it is announced, unlike the notice",
        now !== null && now.live === "polite", JSON.stringify(now));
    const overFailure = await page.evaluate(([cx, cy]) => {
        const el = document.elementFromPoint(cx, cy);
        return el ? `${el.tagName}.${el.className}` : "nothing";
    }, [now.box.x + now.box.w / 2, now.box.y + now.box.h / 2]);
    check("a click on the reason reaches the reason, which is what dismisses it",
        overFailure.includes("agent-toast"), overFailure);

    // ── 5. Nothing is left standing in the way afterwards ───────────
    // The node stays in the page between messages, laid out at zero opacity.
    // Without a rule that stands it down, every click in this corner for the
    // rest of the session lands on a pill nobody can see.
    await page.evaluate(() => {
        const el = document.querySelector(".agent-toast");
        el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(150);
    const gone = await corner();
    check("the reason goes when it is clicked away",
        gone !== null && !gone.visible, JSON.stringify(gone));
    const afterAll = await clickAtCorner(gone.box);
    check("and a click there afterwards reaches the document, not the empty pill",
        !afterAll.includes("agent-toast"), afterAll);
}
