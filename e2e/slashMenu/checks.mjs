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
}
