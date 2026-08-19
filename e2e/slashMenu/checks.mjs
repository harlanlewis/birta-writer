/**
 * Slash-menu end-to-end checks against the real built bundle: the content-
 * shaped group headers (no Notion "Blocks"), the inline-vs-block math split,
 * the "Show all commands" footer that reveals the search-only rows, and the
 * single dynamic toggle rows for TOC visibility/side and toolbar visibility
 * (whose labels reflect live state via the getState snapshot).
 *
 * The committed-pill caret hint is checked here rather than in jsdom because
 * what can go wrong with it is geometry: whether it sits on the line's
 * baseline, and whether it takes width that shoves the rest of the line
 * along. jsdom has no layout engine and reports both as zero.
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

    // ── The committed pill's caret hint ──────────────────────
    /** Rects for the hint's host, its line, and the pill it follows. */
    const hintGeometry = () => page.evaluate(() => {
        const host = document.querySelector(".ProseMirror .md-slash-arg-hint");
        const line = document.querySelector(".ProseMirror .slash-query");
        if (!host || !line) { return null; }
        const span = host.firstElementChild;
        const s = span.getBoundingClientRect();
        const l = line.getBoundingClientRect();
        return {
            text: span.textContent,
            hostWidth: host.getBoundingClientRect().width,
            hostOffsetWidth: host.offsetWidth,
            bottomGap: Math.abs(s.bottom - l.bottom),
            startsAfterPill: s.left >= l.right,
            italic: getComputedStyle(span).fontStyle,
        };
    });

    await open("ai");
    await page.keyboard.press("Space");
    await page.waitForTimeout(200);
    let g = await hintGeometry();
    check("committing the pill shows the caret hint", g !== null && g.text.length > 0, JSON.stringify(g));
    // The invariant that keeps the rest of the line still: a host with no
    // width cannot move what follows it, whatever the hint says.
    check("the hint's host takes no width", g && g.hostWidth === 0 && g.hostOffsetWidth === 0, JSON.stringify(g));
    // Baseline: the hint and the pill are text on one line, so their boxes
    // bottom out together. An absolutely positioned child of a zero-height
    // inline box missed this by about an ascent.
    check("the hint sits on the line's baseline", g && g.bottomGap <= 2, `bottomGap=${g?.bottomGap}`);
    check("the hint follows the pill rather than overlapping it", g && g.startsAfterPill, JSON.stringify(g));
    check("the hint is italic, the empty-line hint's voice", g && g.italic === "italic", g?.italic);
    check("with no route pushed, the hint is the registry’s own text", g && g.text === "your request (press Enter for more options)", JSON.stringify(g?.text));

    // One character of argument retires it, and it never reached the document.
    await page.keyboard.type("make a diagram", { delay: 20 });
    await page.waitForTimeout(200);
    check("typing the request removes the hint",
        (await page.evaluate(() => document.querySelectorAll(".ProseMirror .md-slash-arg-hint").length)) === 0);
    // Asserted against the serialized document, not `textContent`: a widget
    // decoration IS a DOM node inside the paragraph, so it shows up in
    // `textContent` while never existing in the document. That is exactly
    // the distinction worth pinning, and only the posted markdown can see it.
    //
    // Waited for rather than sampled: the sync is debounced, so reading
    // straight after typing can catch a document from before the pill was
    // committed and report a pass having never seen the state under test.
    await page.waitForFunction(
        () => window.__posted.some((m) => m.type === "update" && m.content.includes("/ai make a diagram")),
        { timeout: 10000 },
    );
    const serialized = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").map((m) => m.content).join("\n"));
    check("the hint never reaches the serialized document",
        serialized.includes("/ai make a diagram") && !serialized.includes("your request"),
        JSON.stringify(serialized.slice(-160)));

    // The extension's route summary reaches the sentence: this is the whole
    // path (message → agentRoute store → host hook → decoration).
    await open("ai");
    await page.evaluate(() => window.postMessage({
        type: "agentRoute",
        route: { configured: true, kind: "shell", harness: "claude", model: "haiku", mode: "background" },
    }, "*"));
    await page.waitForTimeout(150);
    await page.keyboard.press("Space");
    await page.waitForTimeout(200);
    g = await hintGeometry();
    check("a pushed route names the harness and its model",
        g && g.text === "edit with claude (Haiku) (press Enter for more options)", JSON.stringify(g?.text));
    // The emphasis is what the eye is meant to land on, and it is the only
    // part of the line that changes, so it is asserted as its own element
    // rather than as a substring of the sentence.
    const strong = await page.evaluate(() =>
        document.querySelector(".ProseMirror .md-slash-arg-hint strong")?.textContent ?? null);
    check("…with what will run drawn heavier", strong === "Haiku", JSON.stringify(strong));

    // A row whose label leaves a real question carries its description in the
    // trailing slot, in the UI font so it never reads as syntax to type.
    await open("");
    const detail = await page.evaluate(() => {
        const row = [...document.querySelectorAll("#md-slash-menu .slash-menu-item")]
            .find((r) => r.querySelector(".slash-menu-item-label")?.textContent === "Mermaid Diagram");
        const slot = row?.querySelector(".slash-menu-item-hint");
        const syntaxRow = [...document.querySelectorAll("#md-slash-menu .slash-menu-item")]
            .find((r) => r.querySelector(".slash-menu-item-label")?.textContent === "Bullet List");
        const syntax = syntaxRow?.querySelector(".slash-menu-item-hint");
        if (!slot || !syntax) { return null; }
        return {
            text: slot.textContent,
            style: getComputedStyle(slot).fontStyle,
            font: getComputedStyle(slot).fontFamily,
            syntaxText: syntax.textContent,
            syntaxFont: getComputedStyle(syntax).fontFamily,
        };
    });
    check("the Mermaid row says what it inserts", detail?.text === "empty diagram", JSON.stringify(detail));
    // The two kinds share the slot, so they have to be told apart by eye. The
    // syntax hint is the control: same slot, same page, monospace by rule.
    check("…in italic and the UI font, where the syntax hint is monospace",
        detail?.style === "italic" && detail.font !== detail.syntaxFont && /mono/i.test(detail.syntaxFont),
        JSON.stringify(detail));

    // ── The advanced composer ────────────────────────────────
    const PANEL = ".agent-panel";
    /** Open the composer via `/ai-advanced`, optionally with text after it. */
    async function openPanel(argument) {
        await open("ai-advanced");
        await page.keyboard.press("Space");
        if (argument) { await page.keyboard.type(argument, { delay: 20 }); }
        await page.keyboard.press("Enter");
        await page.waitForSelector(PANEL, { state: "visible", timeout: 10000 });
        await page.waitForTimeout(150);
    }

    await openPanel();
    check("`/ai-advanced` opens the composer", await page.$(PANEL) !== null);
    check("…focused, so it can be typed into immediately",
        await page.evaluate(() => document.activeElement?.classList.contains("agent-panel-input")));
    // The construct is consumed exactly as the plain row consumes it: the
    // composer is a way of writing the request, not something in the document.
    text = await page.$eval(".milkdown .ProseMirror p", (el) => el.textContent);
    check("…and the /ai-advanced construct left the document", !text.includes("/ai-advanced"), `text=${JSON.stringify(text)}`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("Escape closes it leaving nothing behind", await page.$(PANEL) === null);

    // Text typed after the row arrives already in the textarea.
    await openPanel("summarise the section above");
    check("`/ai-advanced <text>` prefills the composer",
        await page.$eval(".agent-panel-input", (el) => el.value) === "summarise the section above");

    // No route is configured in this harness, so no capabilities are pushed
    // and the pickers must be absent rather than empty.
    check("with no harness capabilities, no model or effort control is offered",
        await page.$$eval(".agent-panel-spec-btn", (els) => els.length) === 0);

    // Capabilities arriving after the panel opened must reach it. This is the
    // real path: message → controller → open panel.
    await page.evaluate(() => window.postMessage({
        type: "agentCapabilities",
        capabilities: {
            harness: "claude", version: "test",
            supportsModel: true, supportsEffort: true,
            efforts: ["low", "medium", "high"],
            modelExamples: ["opus", "sonnet"],
        },
    }, "*"));
    await page.waitForTimeout(200);
    let specs = await page.$$eval(".agent-panel-spec-btn", (els) => els.map((e) => e.textContent));
    check("capabilities arriving late still reach an open composer",
        JSON.stringify(specs) === JSON.stringify(["Default model", "Default effort"]), JSON.stringify(specs));

    // The model menu offers what the help NAMED, plus free entry — never a
    // catalog, because no CLI publishes one.
    await page.locator(".agent-panel-spec-btn").first().click();
    await page.waitForTimeout(150);
    const modelRows = await page.$$eval(".agent-panel-menu-row", (els) => els.map((e) => e.textContent));
    check("the model menu offers the harness's own examples, a default, and free entry",
        JSON.stringify(modelRows) === JSON.stringify(["Default model", "Opus", "Sonnet", "Other model…"]),
        JSON.stringify(modelRows));
    // Free entry has to be a real field: Electron does not implement
    // window.prompt, so a row that called it would look live and do nothing.
    await page.locator(".agent-panel-menu-row").last().click();
    await page.waitForTimeout(150);
    check("Other model… opens a field rather than a native prompt",
        await page.$(".agent-panel-menu-input") !== null);
    await page.keyboard.type("claude-fable-5");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    specs = await page.$$eval(".agent-panel-spec-btn", (els) => els.map((e) => e.textContent));
    check("…and a typed model that is in no list is accepted verbatim",
        specs[0] === "claude-fable-5", JSON.stringify(specs));

    await page.locator(".agent-panel-spec-btn").first().click();
    await page.waitForTimeout(150);
    await page.locator(".agent-panel-menu-row").nth(1).click();
    await page.waitForTimeout(150);
    specs = await page.$$eval(".agent-panel-spec-btn", (els) => els.map((e) => e.textContent));
    check("picking a model shows it on the control", specs[0] === "Opus", JSON.stringify(specs));

    // Sending carries the chosen model, and the request, to the extension.
    await page.locator(".agent-panel-submit").click();
    await page.waitForTimeout(250);
    const sent = await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgentAdvanced"));
    check("sending posts one advanced request carrying the model",
        sent.length === 1 && sent[0].model === "opus" && sent[0].prompt === "summarise the section above",
        JSON.stringify(sent));
    check("…and the composer closed on send", await page.$(PANEL) === null);
    check("…and no plain askAgent was posted alongside it",
        (await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgent").length)) === 0);

    // An attachment still being written blocks Send. The alternative was to
    // drop it silently, which sends a request missing the file the user
    // attached it for, having watched the chip appear.
    await openPanel("describe this");
    await page.evaluate(() => {
        const input = document.querySelector(".agent-panel-file-input");
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    check("an attached file shows a chip", await page.$$eval(".agent-panel-chip", (e) => e.length) === 1);
    check("…and Send is refused while its bytes are still being written",
        await page.$eval(".agent-panel-submit", (el) => el.disabled) === true);
    // The extension is stubbed here, so resolve the write by hand.
    const attId = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "agentAttachment").at(-1)?.id ?? null);
    check("…and the bytes were handed to the extension to write", attId !== null);
    await page.evaluate((id) => window.postMessage(
        { type: "agentAttachmentSaved", id, path: "/tmp/birta-ai/shot.png" }, "*"), attId);
    await page.waitForTimeout(200);
    check("…and Send is allowed once the path comes back",
        await page.$eval(".agent-panel-submit", (el) => el.disabled) === false);
    await page.locator(".agent-panel-submit").click();
    await page.waitForTimeout(200);
    const withFile = await page.evaluate(() => window.__posted.filter((m) => m.type === "askAgentAdvanced").at(-1));
    check("sending carries the written path, not the browser's file object",
        JSON.stringify(withFile?.attachments) === JSON.stringify(["/tmp/birta-ai/shot.png"]),
        JSON.stringify(withFile));

    // `/ai` with nothing typed opens the composer rather than the old input box.
    await open("ai");
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check("`/ai` with nothing typed opens the composer", await page.$(PANEL) !== null);
    await page.keyboard.press("Escape");


    // ── Keyboard navigation is not taken back by a still pointer ──
    // The bug needs a row to ARRIVE under a pointer that has not moved, which
    // is what `scrollIntoView` does on every arrow once the list is longer
    // than its 320px max-height. `mouseover` fires then with no `mousemove` at
    // all, and unguarded it dragged the selection back to whatever slid under
    // the pointer, so the rows past it could not be reached from the keyboard.
    // The unfiltered menu is used because it is the one that scrolls; a
    // seven-row filtered list never moves and never reproduces this.
    await open("");
    const listBox = await page.locator(`${SLASH} .slash-menu-list`).boundingBox();
    const rowCount = await page.$$eval(`${SLASH} .slash-menu-item`, (els) => els.length);
    const scrolls = await page.$eval(
        `${SLASH} .slash-menu-list`, (el) => el.scrollHeight > el.clientHeight + 8);
    check("the browse list is long enough to scroll, which the case needs", scrolls);

    // Park the pointer in the middle of the list and leave it there.
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    await page.waitForTimeout(120);

    const selected = () => page.$$eval(
        `${SLASH} .slash-menu-item`,
        (els) => els.findIndex((e) => e.classList.contains("ui-menu-row--selected")));
    // Stop short of the wrap: the last row wrapping to the first is correct
    // behaviour, and counting it as a stall would fail the honest case.
    const steps = Math.min(rowCount - 1, 14);
    let previous = await selected();
    let stalled = 0;
    for (let i = 0; i < steps; i++) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(60);
        const now = await selected();
        if (now !== previous + 1) { stalled++; }
        previous = now;
    }
    check(`${steps} arrows each advance one row with the pointer parked mid-list`,
        stalled === 0, `presses that did not advance: ${stalled}`);
    const scrolledBy = await page.$eval(`${SLASH} .slash-menu-list`, (el) => el.scrollTop);
    check("…and the walk really did scroll rows under the pointer", scrolledBy > 0, `scrollTop=${scrolledBy}`);

    // The guard parks hover, it does not disable it: real motion takes it
    // back. Aim at a row that is on screen NOW, since the walk scrolled the
    // early rows out of the list's viewport.
    const target = await page.evaluate((sel) => {
        const list = document.querySelector(`${sel} .slash-menu-list`);
        const box = list.getBoundingClientRect();
        const rows = [...document.querySelectorAll(`${sel} .slash-menu-item`)];
        const index = rows.findIndex((r) => {
            const b = r.getBoundingClientRect();
            return b.top >= box.top + 4 && b.bottom <= box.bottom - 4
                && !r.classList.contains("ui-menu-row--selected");
        });
        const b = rows[index].getBoundingClientRect();
        return { index, x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, SLASH);
    // Move well away first, so the arrival at the target is a genuine
    // coordinate change. Landing on the pixel the pointer already occupies
    // produces no `mousemove`, which the guard correctly ignores.
    await page.mouse.move(target.x, target.y - 200);
    await page.waitForTimeout(60);
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(120);
    const afterMove = await selected();
    check("real pointer motion takes the highlight back", afterMove === target.index,
        `selected=${afterMove} wanted=${target.index}`);
}
