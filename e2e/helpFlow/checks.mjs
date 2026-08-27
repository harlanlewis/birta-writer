/**
 * `/help` driven end to end through the real bundle (MAR-395).
 *
 * What this covers that the unit tests cannot: that typing `/help` in a real
 * document reaches the command at all, that the lazy chunk loads, that the
 * four steps cross the message boundary in order, and that what the page hands
 * the host to open is the composed report rather than something the composer
 * would have refused. Every layer between the keystroke and the URL is the
 * shipped one.
 *
 *   node e2e/run.mjs helpFlow
 *   BIRTA_E2E_BROWSER=webkit node e2e/run.mjs helpFlow
 */

export async function run({ page, check, baseUrl }) {
    // Which profile the page boots under. The Mac app declares its own
    // (`HOST_PROFILES.mac`), and `/help` is ungated, which is a claim about
    // `hostHasCommand` rather than something visible in the row's own data.
    let hostQuery = "";

    async function mount(script) {
        await page.goto(`${baseUrl}/index.html${hostQuery}`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /Second line/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.evaluate((s) => {
            window.__promptScript = s;
            window.__promptsSeen = [];
            window.__posted.length = 0;
        }, script);
        await page.waitForTimeout(200);
    }

    /** Puts the caret at the end of the paragraph with the given text. */
    async function caretAtEndOf(text) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const p = page.locator(`.milkdown .ProseMirror p:text-is("${text}")`).first();
            await p.click();
            await page.keyboard.press("End");
            await page.waitForTimeout(150);
            const ok = await page.evaluate((t) => {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) { return false; }
                const node = sel.anchorNode;
                const block = node?.nodeType === 3 ? node.parentElement : node;
                return (block?.closest("p")?.textContent ?? "") === t;
            }, text);
            if (ok) { return true; }
            await page.waitForTimeout(250);
        }
        return false;
    }

    /** Types `/help` and picks the highlighted row. */
    async function runHelp() {
        // The slash trigger only arms after whitespace or at a block start, so
        // the probe types the separating space the user would type anyway.
        await page.keyboard.type(" /help", { delay: 40 });
        await page.waitForTimeout(250);
        await page.keyboard.press("Enter");
        // Long enough for the lazy chunk, four scripted round trips and the
        // diagnostics one.
        await page.waitForTimeout(1200);
    }

    const seen = () => page.evaluate(() => window.__promptsSeen);
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

    // ── 1. `/help` is what the row is called, and it outranks the cheatsheet ─
    await mount([]);
    check("the probe placed the caret in the first paragraph", await caretAtEndOf("First line."), "");
    await page.keyboard.type(" /help", { delay: 40 });
    await page.waitForTimeout(300);
    // The label element specifically, so a badge or a shortcut hint in the
    // same row cannot make a wrong row look like the right one.
    const rows = await page.evaluate(() =>
        [...document.querySelectorAll(".slash-menu-item .slash-menu-item-label")]
            .map((el) => el.textContent?.trim() ?? ""));
    check("typing /help offers at least one row", rows.length > 0, JSON.stringify(rows));
    check(
        "the first row a bare /help offers is Help, not the shortcuts cheatsheet",
        /^Help\b/.test(rows[0] ?? ""),
        JSON.stringify(rows.slice(0, 3)),
    );
    await page.keyboard.press("Escape");

    // ── 2. The whole flow, answered ────────────────────────────────────────
    await mount(["a summary from the harness", "very", "some detail", "github"]);
    await caretAtEndOf("First line.");
    await runHelp();

    const steps = await seen();
    check("all four steps were put to the host, in order", steps.length === 4, `saw ${steps.length}`);
    check(
        "the steps are input, pick, input, pick",
        JSON.stringify(steps.map((s) => s?.kind)) === JSON.stringify(["input", "pick", "input", "pick"]),
        JSON.stringify(steps.map((s) => s?.kind)),
    );
    check(
        "the first step is the required summary, carrying its own validation",
        steps[0]?.required?.message?.length > 0 && steps[0]?.maxLength?.value === 256,
        JSON.stringify(steps[0]),
    );
    check(
        "the destination step offers github, mail and clipboard, each with a detail line",
        JSON.stringify(steps[3]?.rows?.map((r) => r.id)) === JSON.stringify(["github", "mail", "clipboard"])
            && steps[3].rows.every((r) => typeof r.detail === "string" && r.detail.length > 0),
        JSON.stringify(steps[3]?.rows),
    );
    // No `$(github)` anywhere: the codicon is the palette renderer's, applied
    // host-side, or every other surface draws it as those characters.
    check(
        "no step carries a VS Code codicon in a label",
        !JSON.stringify(steps).includes("$("),
        JSON.stringify(steps).slice(0, 200),
    );

    const opened = await posted("openUrl");
    check("exactly one URL was handed to the host", opened.length === 1, `${opened.length}`);
    const url = opened[0]?.url ?? "";
    check(
        "it is a prefilled GitHub issue against this repository",
        url.startsWith("https://github.com/harlanlewis/birta-writer/issues/new?"),
        url.slice(0, 120),
    );
    const parsed = new URL(url || "https://x.invalid");
    check(
        "the issue title is the summary that was typed into the first step",
        parsed.searchParams.get("title") === "a summary from the harness",
        String(parsed.searchParams.get("title")),
    );
    const body = parsed.searchParams.get("body") ?? "";
    check("the body carries the detail that was given", body.includes("some detail"), body.slice(0, 120));
    check(
        "the body carries the disappointment answer that was chosen",
        body.includes("Very disappointed"),
        body.slice(0, 200),
    );
    check(
        "the body carries the diagnostics the HOST reported, not ones the page invented",
        body.includes("9.9.9") && body.includes("a stub host") && body.includes("the e2e harness"),
        body.slice(-300),
    );
    // The promise this command is built on, asserted on the bytes rather than
    // trusted: the composer is never given the document, so nothing from it
    // can appear here.
    check(
        "no document content reached the payload",
        !body.includes("First line") && !body.includes("Second line") && !body.includes("Journal"),
        body.slice(0, 300),
    );
    check("the clipboard was left alone by a report that fits", (await posted("clipboardWrite")).length === 0, "");

    // ── 3. The clipboard destination makes no outbound call at all ──────────
    await mount(["another summary", "skip", "", "clipboard"]);
    await caretAtEndOf("First line.");
    await runHelp();
    check("the clipboard destination opens no URL", (await posted("openUrl")).length === 0, "");
    const copied = await posted("clipboardWrite");
    check("the clipboard destination writes the report", copied.length === 1, `${copied.length}`);
    check(
        "what is copied is the whole report, titled",
        (copied[0]?.data ?? "").startsWith("# another summary"),
        (copied[0]?.data ?? "").slice(0, 80),
    );
    check(
        "a skipped disappointment question leaves it out of the report",
        !(copied[0]?.data ?? "").includes("Very disappointed"),
        "",
    );

    // ── 4. Cancelling at each step, through the real bundle ────────────────
    // The unit suite walks this matrix against a fake renderer; this arm is
    // what proves the same is true of the shipped path, message boundary and
    // lazy chunk included.
    const full = ["a summary", "very", "detail", "github"];
    for (let at = 0; at < full.length; at++) {
        const script = full.map((a, i) => (i === at ? null : a));
        await mount(script);
        await caretAtEndOf("First line.");
        await runHelp();
        const askedCount = (await seen()).length;
        check(
            `cancelling at step ${at + 1} asks nothing further`,
            askedCount === at + 1,
            `asked ${askedCount}`,
        );
        check(
            `cancelling at step ${at + 1} sends nowhere and copies nothing`,
            (await posted("openUrl")).length === 0 && (await posted("clipboardWrite")).length === 0,
            "",
        );
    }

    // ── 5. Cancelling leaves the document exactly as it was ────────────────
    // The one claim a message-level assertion cannot make: `/help` is reached
    // by typing into the document, so an abandoned flow must not leave the
    // typed trigger behind either.
    await mount([null]);
    await caretAtEndOf("First line.");
    await runHelp();
    const text = await page.evaluate(
        () => document.querySelector(".ProseMirror")?.textContent ?? "");
    check(
        "an abandoned flow leaves no /help text in the document",
        !text.includes("/help"),
        text.slice(0, 120),
    );

    // ── 6. The caret comes back ────────────────────────────────────────────
    // The claim no message-level assertion can make, and the one the ticket
    // asks for by name. Every renderer of a prompt takes focus off the
    // `contenteditable`, so the test is not "is something focused" but the
    // gesture itself: type, and see where the character lands. `e2e/enterCaret`
    // exists for this class and this is the same question.
    await page.keyboard.type("Z", { delay: 40 });
    await page.waitForTimeout(200);
    const landed = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror p")].map((p) => p.textContent ?? ""));
    // The trigger the probe typed opens with a space, which the slash menu
    // consumes as its own, so the block keeps that space and the character
    // lands after it. Asserting the block ENDS with the character, and that
    // the other block is untouched, says the caret came back to where it was
    // without pinning that incidental space.
    check(
        "typing after an abandoned flow reaches the block the caret started in",
        landed.some((p) => p.startsWith("First line.") && p.endsWith("Z"))
            && landed.some((p) => p === "Second line."),
        JSON.stringify(landed.slice(0, 3)),
    );

    // And after a flow that ran all the way through, which is the other exit.
    await mount(["a summary", "skip", "", "clipboard"]);
    await caretAtEndOf("Second line.");
    await runHelp();
    await page.keyboard.type("Q", { delay: 40 });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror p")].map((p) => p.textContent ?? ""));
    check(
        "typing after a completed flow reaches the block the caret started in",
        after.some((p) => p.startsWith("Second line.") && p.endsWith("Q"))
            && after.some((p) => p === "First line."),
        JSON.stringify(after.slice(0, 3)),
    );

    // ── 7. The same, under the Mac app's declared profile ──────────────────
    // The changelog says `/help` is there on both surfaces. Every arm above
    // ran under the VS Code profile, which says nothing about the other one:
    // a command carrying a `hostCapability` the Mac app does not declare is withdrawn
    // by `hostHasCommand` from the slash menu, the palette and
    // `runEditorCommand` at once, and it would be withdrawn silently. So the
    // claim is driven rather than reasoned about.
    hostQuery = "?host=mac";
    await mount(["a summary from mac", "skip", "", "github"]);
    check("the probe placed the caret, under the mac profile", await caretAtEndOf("First line."), "");
    await page.keyboard.type(" /help", { delay: 40 });
    await page.waitForTimeout(300);
    const macRows = await page.evaluate(() =>
        [...document.querySelectorAll(".slash-menu-item .slash-menu-item-label")]
            .map((el) => el.textContent?.trim() ?? ""));
    check(
        "the Help row is offered under the mac profile too, and still first",
        /^Help\b/.test(macRows[0] ?? ""),
        JSON.stringify(macRows.slice(0, 3)),
    );
    // The instrument reached the right page: under the mac profile the editor
    // withdraws commands VS Code has, so a row that IS gated must be gone. If
    // this passes with the VS Code profile still loaded, the arm above proves
    // nothing.
    const gated = await page.evaluate(() => window.__i18n?.host?.capabilities ?? null);
    check(
        "the page really booted under the mac profile",
        Array.isArray(gated) && !gated.includes("textEditor") && gated.includes("appPreferences"),
        JSON.stringify(gated),
    );

    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const macSteps = await seen();
    check("the flow runs under the mac profile", macSteps.length === 4, `saw ${macSteps.length}`);
    const macOpened = await posted("openUrl");
    check(
        "and hands the host the same prefilled issue",
        macOpened.length === 1
            && (macOpened[0]?.url ?? "").includes(encodeURIComponent("a summary from mac")),
        (macOpened[0]?.url ?? "").slice(0, 140),
    );
}
