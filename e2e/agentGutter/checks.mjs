/**
 * What a block's gutter does while an `/ai` run is anchored to it.
 *
 * The run marker stands in the block marker's own column rather than beside it,
 * so the block has to stand its gutter down for the run's duration or a grab
 * handle appears over the pill on hover. Two things about that are only
 * answerable in a browser, and both were wrong at some point in the change that
 * introduced it:
 *
 * The suppression reaches the gutter from a class on the block, and WHICH
 * element the gutter hangs off differs per block type. A unit test cannot see
 * this: the editor its fixture builds composes no gutter plugin at all, so
 * there is no gutter to stand in the right or wrong relationship to, and an
 * assertion there passed while the rule matched nothing.
 *
 * A COLLAPSED chevron must survive the suppression. Since the heading's `…`
 * chip was removed, that chevron is the only thing saying a section is folded,
 * so hiding it for a run would leave a heading with its body gone, nothing
 * saying so, and nothing to click. `/ai` is not gated to paragraphs, so this is
 * reachable rather than theoretical.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => /list item one/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
        { timeout: 10000 },
    );
    await page.waitForTimeout(300);

    /** Put the caret in the block whose text matches, and start a confirmed run there. */
    const runOn = async (text) => {
        await page.evaluate((needle) => {
            const el = [...document.querySelectorAll(".ProseMirror p, .ProseMirror h1")]
                .find((e) => e.textContent.includes(needle));
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode();
            document.querySelector(".ProseMirror").focus();
            const range = document.createRange();
            // Start of the block: the slash menu opens on a `/` that begins a
            // token, and appending to the text gives `paragraph./ai`, which does
            // not. This is why the first draft posted nothing on two of three.
            range.setStart(node, 0);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }, text);
        await page.waitForTimeout(120);
        // The row has to be COMMITTED with Space before the request is typed;
        // typing the whole thing in one go leaves the slash menu open and posts
        // nothing. This is the sequence e2e/slashMenu drives.
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
        if (id === null) { return null; }
        await page.evaluate((rid) => window.postMessage(
            { type: "agentRun", requestId: rid, status: "running" }, "*"), id);
        await page.waitForTimeout(200);
        return id;
    };

    const endRun = async (id) => {
        await page.evaluate((rid) => window.postMessage(
            { type: "agentRun", requestId: rid, status: "done" }, "*"), id);
        await page.waitForTimeout(150);
    };

    /** The host block, and whether the gutter chrome sharing its column is painted. */
    const gutterState = () => page.evaluate(() => {
        const shown = (el) => el !== null && getComputedStyle(el).display !== "none"
            && el.getBoundingClientRect().width > 0;
        const pill = document.querySelector(".ProseMirror .agent-pending");
        const host = document.querySelector(".ProseMirror .agent-pending-host");
        if (!pill || !host) { return null; }
        // The gutter the pill actually shares a column with is the one on the
        // nearest gutter host at or above the pill, which is not always the
        // marked block: a list item's first line has no gutter of its own.
        const owner = pill.closest(".block-gutter-host, .heading-fold-heading") ?? host;
        const gutter = owner.querySelector(":scope > .heading-fold-gutter");
        const marker = gutter?.querySelector(".heading-fold-marker") ?? null;
        const toggle = gutter?.querySelector(".heading-fold-toggle") ?? null;
        return {
            hostTag: host.tagName,
            ownerTag: owner.tagName,
            sameElement: owner === host,
            hasGutter: gutter !== null,
            markerShown: shown(marker),
            toggleShown: shown(toggle),
            collapsed: owner.classList.contains("heading-fold-heading--collapsed")
                || (gutter?.classList.contains("heading-fold-gutter--collapsed") ?? false),
        };
    });

    // ── 1. A run that FAILS ─────────────────────────────────────────
    // Nothing is left in the gutter. This page declares nothing, which means
    // the VS Code profile, and VS Code raises its own error notification for a
    // failed run, so the corner stays empty here: the message in the corner is
    // for a host that has no way to say it. e2e/jotHost drives the other arm.
    let id = await runOn("plain paragraph.");
    check("a run was started before failing it", id !== null, String(id));
    const markerBefore = await page.evaluate(
        () => document.querySelectorAll(".ProseMirror .agent-pending").length);
    // The instrument reached something: an empty gutter below is the failure
    // clearing the marker rather than a run that never drew one.
    check("the run drew a marker while it was running", markerBefore === 1, String(markerBefore));

    await page.evaluate((rid) => window.postMessage(
        { type: "agentRun", requestId: rid, status: "failed", harness: "claude",
          message: "command not found" }, "*"), id);
    await page.waitForTimeout(300);

    const failure = await page.evaluate(() => ({
        markers: document.querySelectorAll(".ProseMirror .agent-pending").length,
        toast: document.querySelector(".agent-toast") !== null,
    }));
    check("the failure takes the marker out of the gutter",
        failure.markers === 0, JSON.stringify(failure));
    check("and says nothing in the corner, because this host says it itself",
        failure.toast === false, JSON.stringify(failure));

    // ── 2. A run on a plain top-level paragraph ──────────────────────
    id = await runOn("plain paragraph.");
    check("a run was started on the paragraph", id !== null, String(id));
    await page.mouse.move(400, 300); // hover the content so at-rest handles would reveal
    await page.waitForTimeout(150);
    const para = await gutterState();
    check("the paragraph's block is the pill's host and owns its gutter",
        para !== null && para.hasGutter && para.sameElement, JSON.stringify(para));
    check("its grab handle is suppressed for the run",
        para !== null && !para.markerShown, JSON.stringify(para));
    await endRun(id);

    // ── 3. A run on a list item's first line ─────────────────────────
    // The case a `>` selector silently missed: the item's gutter hangs off the
    // <li>, and the marked block is the <p> inside it, so the rule has to reach
    // a gutter that is the marked block's SIBLING rather than its child.
    id = await runOn("list item two");
    check("a run was started on the list item", id !== null, String(id));
    await page.mouse.move(400, 300);
    await page.waitForTimeout(150);
    const item = await gutterState();
    check("the list item's gutter is a different element from the marked block",
        item !== null && !item.sameElement,
        JSON.stringify(item));
    check("and its grab handle is still suppressed for the run",
        item !== null && !item.markerShown, JSON.stringify(item));
    await endRun(id);

    // ── 4. A heading folded WHILE a run is live ─────────────────────
    // Order matters and the first draft had it backwards: typing `/ai` into a
    // collapsed heading expands it, so a run cannot be started on one. The
    // reachable case, and the one the defect was about, is folding a heading
    // that already has a run anchored to it.
    id = await runOn("Section");
    check("a run was started on the heading", id !== null, String(id));
    await page.locator(".milkdown .ProseMirror h1").first().hover();
    await page.waitForTimeout(200);
    await page.evaluate(() => {
        const t = document.querySelector(".ProseMirror h1 .heading-fold-toggle");
        t?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        t?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    await page.mouse.move(400, 400);
    await page.waitForTimeout(150);
    const heading = await gutterState();
    check("the heading folded while its run is live",
        heading !== null && heading.collapsed, JSON.stringify(heading));
    check("its grab handle is suppressed like any other block's",
        heading !== null && !heading.markerShown, JSON.stringify(heading));
    // The one thing the suppression must NOT take: with the `…` chip gone, this
    // chevron is the only thing saying the section is folded, and the only way
    // back to it.
    check("but its collapsed chevron survives, so the fold stays visible and clickable",
        heading !== null && heading.toggleShown, JSON.stringify(heading));
    await endRun(id);
}
