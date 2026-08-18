/**
 * Slash-menu end-to-end checks against the real built bundle: the content-
 * shaped group headers (no Notion "Blocks"), the inline-vs-block math split,
 * the "Show all commands" footer that reveals the search-only rows, and the
 * single dynamic toggle rows for TOC visibility/side and toolbar visibility
 * (whose labels reflect live state via the getState snapshot).
 */
export async function run({ page, check, baseUrl }) {
    const SLASH = "#md-slash-menu";

    /** Reload, drop into a fresh empty paragraph, and open the menu with `query`. */
    async function open(query) {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        // Let the stubbed "ready"→"init" round-trip populate the doc before we
        // place the caret, or "/" is typed into a doc that init then replaces.
        await page.waitForFunction(
            () => /Some text/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
        // Deterministic caret: click the paragraph and Home to its start (arrow/
        // Enter caret moves are unreliable headless). "/query" then sits at
        // block start, so slashContext matches regardless of trailing text.
        await page.locator(".milkdown .ProseMirror p").first().click();
        await page.keyboard.press("Home");
        await page.keyboard.type(`/${query}`, { delay: 60 });
        await page.waitForSelector(SLASH, { state: "visible", timeout: 10000 });
        await page.waitForTimeout(200);
    }

    const headers = () =>
        page.$$eval(`${SLASH} .slash-menu-group-label`, (els) => els.map((e) => e.textContent));
    const labels = () =>
        page.$$eval(`${SLASH} .slash-menu-item-label`, (els) => els.map((e) => e.textContent));

    // ── 1. Content-shaped headers, no "Blocks" ───────────────
    await open("");
    let h = await headers();
    check("browse headers are Text / Lists / Insert", JSON.stringify(h) === JSON.stringify(["Text", "Lists", "Insert"]), JSON.stringify(h));
    check("no Notion 'Blocks' header", !h.includes("Blocks"));

    // ── 2. Inline vs block math ──────────────────────────────
    let l = await labels();
    check("'Inline Math' row exists (renamed from 'Math')", l.includes("Inline Math"), JSON.stringify(l));
    check("'Math Block' row exists", l.includes("Math Block"));
    check("no bare 'Math' row", !l.includes("Math"));

    // ── 3. Show all commands reveals the search-only groups ──
    const footer = page.locator(`${SLASH} .slash-menu-footer-hint`);
    check("footer offers 'Show all commands'", (await footer.textContent()) === "Show all commands");
    await footer.click();
    await page.waitForTimeout(150);
    h = await headers();
    check(
        "Show all reveals Formatting / View / Actions headers",
        ["Formatting", "View", "Actions"].every((x) => h.includes(x)),
        JSON.stringify(h),
    );
    check("footer flips to 'Show fewer'", (await footer.textContent()) === "Show fewer");

    // ── 4. TOC: a single dynamic visibility toggle, not Show+Hide ──
    await open("toc");
    l = await labels();
    const tocVis = l.filter((x) => /Table of Contents/.test(x) && /Show|Hide/.test(x));
    check("exactly one TOC show/hide row", tocVis.length === 1, JSON.stringify(l));
    check("TOC toggle reads 'Show' while closed", tocVis[0] === "Show Table of Contents", tocVis[0]);
    const tocSide = l.filter((x) => /Move Table of Contents/.test(x));
    check("exactly one TOC side-swap row", tocSide.length === 1, JSON.stringify(tocSide));

    // ── 5. Toolbar: a single dynamic toggle, labelled for live state ──
    await open("toolbar");
    l = await labels();
    // The show/hide toggle is one row (not a Show+Hide pair); "Customize
    // Toolbar" is a separate, legitimately distinct command.
    const barToggle = l.filter((x) => /^(Show|Hide) Toolbar$/.test(x));
    check("exactly one toolbar show/hide toggle row", barToggle.length === 1, JSON.stringify(l));
    check("toolbar toggle reads 'Hide' while visible", barToggle[0] === "Hide Toolbar", barToggle[0]);

    // ── 6. The typed "/query" reads as UI input while the menu is open ──
    // (the Notion affordance: a quiet pill over the text feeding the filter,
    // cleared the moment the menu closes.)
    await open("head");
    const pill = await page.evaluate(
        () => document.querySelector(".ProseMirror .slash-query")?.textContent ?? null);
    check("typed /query carries the pill highlight while the menu is open",
        pill === "/head", `pill=${JSON.stringify(pill)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("dismissing the menu clears the pill",
        await page.evaluate(() => document.querySelector(".ProseMirror .slash-query") === null));

    // ── 7. Nesting flexibility: block inserts work INSIDE a callout ──
    // Policy: anything block-level inserts wherever the schema allows block
    // content — callout types included (the old gate hid them on the stale
    // premise that insertCallout toggles; it wrapIn-NESTS). Each case opens
    // the menu at the start of the callout's body paragraph, picks the top
    // row with Enter, and asserts the node serialized INSIDE the callout.
    async function openInCalloutBody(query) {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /callout body here/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const par = [...document.querySelectorAll(".ProseMirror .callout p")]
                .find((el) => el.textContent.includes("callout body here"));
            par.scrollIntoView({ block: "center" });
        });
        await page.locator(".ProseMirror .callout p", { hasText: "callout body here" }).click();
        await page.keyboard.press("Home");
        await page.keyboard.type(`/${query}`, { delay: 60 });
        await page.waitForSelector(SLASH, { state: "visible", timeout: 10000 });
        await page.waitForTimeout(200);
    }
    const nestedDoc = async (wanted) => {
        for (let i = 0; i < 30; i++) {
            const updates = await page.evaluate(() =>
                window.__posted.filter((m) => m.type === "update").map((m) => m.content));
            const last = updates[updates.length - 1];
            if (last && wanted.test(last)) return last;
            await page.waitForTimeout(100);
        }
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        return updates[updates.length - 1] ?? null;
    };
    for (const [query, firstRow, pattern, name] of [
        ["tip", "Tip", /^> > \[!tip\]/im, "a nested tip callout"],
        ["table", "Table", /^> \|/m, "a table"],
        ["code", "Code Block", /^> ```/m, "a code block"],
        ["horiz", "Horizontal Rule", /^> ---/m, "a divider"],
    ]) {
        await openInCalloutBody(query);
        const first = await page.$eval(`${SLASH} .slash-menu-item-label`, (el) => el.textContent);
        check(`inside a callout, /${query} offers ${firstRow}`, first === firstRow, `first=${first}`);
        await page.keyboard.press("Enter");
        const doc = await nestedDoc(pattern);
        check(`picking ${firstRow} inside a callout lands ${name} INSIDE it`,
            doc !== null && pattern.test(doc), `doc=${JSON.stringify(doc)}`);
    }

    // ── 8. Argument mode: /ai + Space + request + Enter (MAR-371) ──
    // Real key events, because the whole gesture turns on which listener
    // wins a Space keydown: the plugin's capture-phase handler must claim it
    // (rewriting the query to "/ai ") before the browser inserts a space that
    // would end the slash construct. jsdom cannot show that; only a real
    // keydown followed by the browser's own default action can.
    await open("ai");
    let first = await page.$eval(`${SLASH} .slash-menu-item-label`, (el) => el.textContent);
    check("/ai offers Ask Agent first", first === "Ask Agent", `first=${first}`);
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    let text = await page.$eval(".milkdown .ProseMirror p", (el) => el.textContent);
    check("Space commits the row: the paragraph now starts with '/ai '", text.startsWith("/ai "), `text=${JSON.stringify(text)}`);
    let hint = await page.locator(`${SLASH} .slash-menu-footer-hint`).textContent();
    check("the menu stays open in argument mode", /Enter to send/.test(hint), `hint=${hint}`);
    await page.keyboard.type("add a mermaid diagram of the flow", { delay: 30 });
    await page.waitForTimeout(150);
    let argPill = await page.evaluate(
        () => document.querySelector(".ProseMirror .slash-query")?.textContent ?? null);
    check("the pill covers the whole /ai request while typing",
        argPill === "/ai add a mermaid diagram of the flow", `pill=${JSON.stringify(argPill)}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const asked = await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgent"));
    check("Enter posts one askAgent message carrying the typed request",
        asked.length === 1 && asked[0].prompt === "add a mermaid diagram of the flow", JSON.stringify(asked));
    text = await page.$eval(".milkdown .ProseMirror p", (el) => el.textContent);
    check("the /ai construct is removed from the document", !text.includes("/ai"), `text=${JSON.stringify(text)}`);
    check("the menu is closed after sending",
        await page.evaluate(() => document.querySelector("#md-slash-menu") === null));
    check("the request carries an id the extension echoes back", typeof asked[0].requestId === "string" && asked[0].requestId.length > 0, JSON.stringify(asked));

    // ── 9. The run marker and the undo policy (MAR-376) ──
    // The harness plays the extension: confirm a background run, write the
    // "agent's" result as an external update, undo it, then finish the run.
    const requestId = asked[0].requestId;
    check("no marker before the extension confirms a run",
        await page.evaluate(() => document.querySelectorAll(".ProseMirror .agent-pending").length) === 0);
    await page.evaluate((id) => window.postMessage({ type: "agentRun", requestId: id, status: "running" }, "*"), requestId);
    await page.waitForTimeout(150);
    const marker = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .agent-pending");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const p = el.closest("p")?.getBoundingClientRect();
        return { inParagraph: el.closest("p")?.textContent ?? null, left: r.left, pLeft: p?.left ?? null, width: r.width, height: r.height };
    });
    check("a running run puts one marker in the gutter beside the request's block",
        marker !== null && marker.inParagraph === "Some text." && marker.width > 0 && marker.left < marker.pLeft, JSON.stringify(marker));
    // The agent writes the file; VS Code reloads; the webview takes it into history.
    await page.evaluate(() => window.postMessage({
        type: "externalUpdate",
        content: "# Title\n\nSome text.\n\nAgent wrote this.\n\n> [!note] Outer\n> callout body here.\n",
        syncVersion: 2,
    }, "*"));
    await page.waitForFunction(() => /Agent wrote this/.test(document.querySelector(".ProseMirror")?.textContent ?? ""), { timeout: 5000 });
    await page.locator(".milkdown .ProseMirror p").first().click();
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
    check("Cmd+Z removes the agent's insertion while its run is live (undoes like a paste)",
        !/Agent wrote this/.test(await page.evaluate(() => document.querySelector(".ProseMirror")?.textContent ?? "")));
    await page.evaluate((id) => window.postMessage({ type: "agentRun", requestId: id, status: "done" }, "*"), requestId);
    await page.waitForTimeout(150);
    check("done clears the marker",
        await page.evaluate(() => document.querySelectorAll(".ProseMirror .agent-pending").length) === 0);
    // A second request, typed on a fresh empty line below the paragraph (the
    // common gesture): its marker sits beside THAT line, not the one above.
    // Then cancelled from its marker, then reported failed.
    // Home is the one caret key that is reliable headless (see open()), so
    // the fresh line is made ABOVE the paragraph: Enter at its start, then
    // ArrowUp into the empty paragraph that split off.
    await page.locator(".milkdown .ProseMirror p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("/ai", { delay: 60 });
    await page.waitForSelector(SLASH, { state: "visible", timeout: 10000 });
    await page.keyboard.press("Space");
    await page.keyboard.type("second request", { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const second = await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgent").at(-1).requestId);
    check("a second request gets its own id", second && second !== requestId, JSON.stringify({ requestId, second }));
    await page.evaluate((id) => window.postMessage({ type: "agentRun", requestId: id, status: "running", harness: "claude" }, "*"), second);
    await page.waitForTimeout(150);
    const second_marker = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .agent-pending");
        if (!el) return null;
        const p = el.closest("p");
        const glyph = el.querySelector(".agent-pending__glyph");
        const r = glyph?.getBoundingClientRect();
        const square = glyph ? getComputedStyle(glyph, "::before") : null;
        return {
            paragraphText: p ? [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("") : null,
            paragraphIndex: p ? [...p.parentElement.children].indexOf(p) : -1,
            title: el.getAttribute("title"),
            width: r?.width, height: r?.height, squareWidth: square?.width,
        };
    });
    check("the marker sits beside the empty line the request was typed on, not the paragraph beside it",
        second_marker !== null && second_marker.paragraphText === "" && second_marker.paragraphIndex === 1, JSON.stringify(second_marker));
    // The pill must not cover the heading fold chevron, the one clickable
    // thing in a heading's gutter: a third request on the H1 (the second
    // stays live for the cancel checks below), hover the heading (the
    // chevron shows on hover) and compare rects.
    await page.locator(".milkdown .ProseMirror h1").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.type("/ai", { delay: 60 });
    await page.waitForSelector(SLASH, { state: "visible", timeout: 10000 });
    await page.keyboard.press("Space");
    await page.keyboard.type("heading request", { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const third = await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgent").at(-1).requestId);
    await page.evaluate((id) => window.postMessage({ type: "agentRun", requestId: id, status: "running", harness: "claude" }, "*"), third);
    await page.waitForTimeout(150);
    await page.locator(".milkdown .ProseMirror h1").first().hover();
    await page.waitForTimeout(150);
    const geometry = await page.evaluate(() => {
        const h1 = document.querySelector(".ProseMirror h1");
        const pill = h1?.querySelector(".agent-pending__glyph")?.getBoundingClientRect();
        const chevron = h1?.querySelector(".heading-fold-toggle, .heading-fold-chevron")?.getBoundingClientRect();
        const marker = h1?.querySelector(".heading-fold-marker")?.getBoundingClientRect();
        const overlap = (a, b) => a && b && b.width > 0 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
        return { pill: pill && [pill.left, pill.right], chevron: chevron && [chevron.left, chevron.right], marker: marker && [marker.left, marker.right], overChevron: overlap(pill, chevron), overMarker: overlap(pill, marker) };
    });
    check("on a heading, the pill sits clear of the fold chevron and the level badge, and inside the pane",
        geometry.pill !== undefined && geometry.pill !== null && !geometry.overChevron && !geometry.overMarker && geometry.pill[0] >= 0, JSON.stringify(geometry));
    await page.evaluate((id) => window.postMessage({ type: "agentRun", requestId: id, status: "done" }, "*"), third);
    await page.waitForTimeout(100);
    check("the marker is a pill wide enough to read, carrying a stop square and naming the harness",
        second_marker !== null && second_marker.width >= 18 && second_marker.height >= 12
            && second_marker.squareWidth === "7px" && /claude/.test(second_marker.title ?? ""), JSON.stringify(second_marker));
    await page.locator(".ProseMirror .agent-pending").first().click();
    await page.waitForTimeout(100);
    const cancels = await page.evaluate(() => window.__posted.filter((m) => m.type === "agentCancel"));
    check("clicking the marker asks the extension to cancel that run", cancels.length === 1 && cancels[0].requestId === second, JSON.stringify(cancels));
    await page.evaluate((id) => window.postMessage({ type: "agentRun", requestId: id, status: "failed", message: "exit 1" }, "*"), second);
    await page.waitForTimeout(150);
    check("a failed run turns the marker into an error marker",
        await page.evaluate(() => document.querySelectorAll(".ProseMirror .agent-pending--error").length) === 1);

    // Space on an ordinary row is still a filter character: the browser
    // inserts it and the construct ends.
    await open("he");
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    text = await page.$eval(".milkdown .ProseMirror p", (el) => el.textContent);
    check("Space on a non-argument row is inserted as text", text.startsWith("/he "), `text=${JSON.stringify(text)}`);
    check("…and no askAgent was posted by it",
        (await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgent").length)) === 0);
}
