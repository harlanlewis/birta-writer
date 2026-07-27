/**
 * Selection round trips across a mode switch, against the real bundle.
 *
 * modeSwitchCaret covers the bare caret; this suite covers RANGES — the other
 * half of the handoff contract: a selection made in the WYSIWYG editor arrives
 * in the raw editor as the same source range (anchor and head, in drag order),
 * and a raw-editor selection carried the other way is restored as a live
 * ProseMirror selection. Block-range selections (Escape / Shift+Down, MAR-82)
 * count as content selections covering their blocks' whole source lines.
 *
 * Document lines (frontmatter = 3): see index.html's reference table.
 */

/** The position payload the webview last handed to the raw editor. */
const lastSwitch = (page) =>
    page.evaluate(() => {
        const posted = window.__posted.filter((m) => m.type === "switchToTextEditor");
        return posted[posted.length - 1] ?? null;
    });

/** Ask the webview to leave for the raw editor, exactly as Cmd+Shift+M does. */
async function requestSwitch(page) {
    await page.evaluate(() => window.postMessage({ type: "requestSwitchToTextEditor" }, "*"));
    await page.waitForTimeout(120);
    return lastSwitch(page);
}

/**
 * Select from `offset` characters into the block at `from` to `offset`
 * characters into the block at `to`, via the DOM selection (ProseMirror reads
 * it back through its selectionchange observer). Walks editable text nodes
 * only, skipping widget/chrome text, as modeSwitchCaret's caretInto does.
 */
async function selectRange(page, from, to) {
    // A click first gives the editor focus (and clears any block-range state).
    await page.locator(from.selector).nth(from.nth ?? 0).click();
    await page.waitForTimeout(60);
    const ok = await page.evaluate(({ from, to }) => {
        const resolve = ({ selector, nth = 0, offset }) => {
            const el = document.querySelectorAll(selector)[nth];
            if (!el) { return null; }
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) =>
                    n.parentElement?.closest("[contenteditable='false'], .ProseMirror-widget")
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT,
            });
            let remaining = offset;
            let node = walker.nextNode();
            while (node && remaining > node.length) {
                remaining -= node.length;
                node = walker.nextNode();
            }
            return node ? { node, offset: remaining } : null;
        };
        const a = resolve(from);
        const b = resolve(to);
        if (!a || !b) { return false; }
        getSelection().setBaseAndExtent(a.node, a.offset, b.node, b.offset);
        return true;
    }, { from, to });
    if (!ok) { throw new Error(`selectRange: could not resolve ${JSON.stringify({ from, to })}`); }
    await page.waitForTimeout(120);
}

/** Fresh page load, editor ready. */
async function freshPage(page, baseUrl) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);
}

/** The last content the webview synced out. */
const lastContent = (page) =>
    page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates[updates.length - 1]?.content ?? "";
    });

export async function run({ page, check, baseUrl }) {
    await freshPage(page, baseUrl);

    // ── 1. A selection inside one line carries both ends, drag order intact ──
    // "paragraph with" in "First paragraph with some words." (doc line 7).
    await selectRange(
        page,
        { selector: ".ProseMirror > p", offset: 6 },
        { selector: ".ProseMirror > p", offset: 20 },
    );
    let target = await requestSwitch(page);
    check(
        "an in-line selection carries head line/col",
        target?.line === 7 && target?.column === 20,
        JSON.stringify(target),
    );
    check(
        "an in-line selection carries anchor line/col",
        target?.anchorLine === 7 && target?.anchorColumn === 6,
        JSON.stringify(target),
    );

    // ── 2. A multi-line selection carries both ends across blocks ──
    // From the paragraph's start (line 7 col 0) into "beta" (line 10 col 6).
    await selectRange(
        page,
        { selector: ".ProseMirror > p", offset: 0 },
        { selector: ".ProseMirror li p", nth: 1, offset: 4 },
    );
    target = await requestSwitch(page);
    check(
        "a multi-line selection carries the head end (list item line, bullet-adjusted col)",
        target?.line === 10 && target?.column === 6,
        JSON.stringify(target),
    );
    check(
        "a multi-line selection carries the anchor end",
        target?.anchorLine === 7 && target?.anchorColumn === 0,
        JSON.stringify(target),
    );

    // ── 3. A backward drag keeps anchor/head roles (head above anchor) ──
    await selectRange(
        page,
        { selector: ".ProseMirror pre code", offset: "const a = 1;\n".length + 2 },
        { selector: ".ProseMirror h1", offset: 2 },
    );
    target = await requestSwitch(page);
    check(
        "a backward selection's head maps to the earlier position",
        target?.line === 5 && target?.column === 4,
        JSON.stringify(target),
    );
    check(
        "a backward selection's anchor maps to the later position",
        target?.anchorLine === 14 && target?.anchorColumn === 2,
        JSON.stringify(target),
    );

    // ── 4. A block-range selection (Escape) covers its block's source lines ──
    await freshPage(page, baseUrl);
    await page.locator(".ProseMirror > p").first().click();
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    target = await requestSwitch(page);
    check(
        "a one-block range selects that block's whole source line",
        target?.anchorLine === 7 && target?.anchorColumn === 0 &&
        target?.line === 7 && target?.column === "First paragraph with some words.".length,
        JSON.stringify(target),
    );

    // ── 5. A grown block range (Shift+Down) covers all its blocks' lines ──
    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(120);
    target = await requestSwitch(page);
    check(
        "a two-block range spans first block start to last block end",
        target?.anchorLine === 7 && target?.anchorColumn === 0 &&
        target?.line === 10 && target?.column === "- beta".length,
        JSON.stringify(target),
    );

    // ── 5b. A block range over a fence includes the closing fence line ──
    // The closing ``` has no text position in the document, but the block
    // owns it in the source.
    await freshPage(page, baseUrl);
    await page.locator(".ProseMirror pre code").first().click();
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    target = await requestSwitch(page);
    check(
        "a fence block range runs from its opening to its closing fence",
        target?.anchorLine === 12 && target?.anchorColumn === 0 &&
        target?.line === 15 && target?.column === 3,
        JSON.stringify(target),
    );

    // ── 6. Arriving: a carried range is restored as a live selection ──
    await freshPage(page, baseUrl);
    await page.evaluate(() =>
        window.postMessage(
            { type: "scrollToLine", line: 7, column: 20, anchorLine: 7, anchorColumn: 6 },
            "*",
        ));
    await page.waitForTimeout(250);
    let selected = await page.evaluate(() => getSelection()?.toString() ?? "");
    check(
        "an arriving in-line range is selected in the editor",
        selected === "paragraph with",
        JSON.stringify(selected),
    );
    // Typing replaces the restored selection — the raw editor's behavior.
    await page.keyboard.type("X");
    await page.waitForTimeout(400);
    let content = await lastContent(page);
    check(
        "typing over the arriving range replaces exactly it",
        content.includes("First X some words."),
        JSON.stringify(content.split("\n").slice(0, 4)),
    );

    // ── 7. Arriving: a multi-line carried range is restored whole ──
    await freshPage(page, baseUrl);
    await page.evaluate(() =>
        window.postMessage(
            { type: "scrollToLine", line: 10, column: 6, anchorLine: 7, anchorColumn: 6 },
            "*",
        ));
    await page.waitForTimeout(250);
    selected = await page.evaluate(() => getSelection()?.toString() ?? "");
    check(
        "an arriving multi-line range spans paragraph into the list",
        selected.startsWith("paragraph with some words.") && selected.endsWith("beta"),
        JSON.stringify(selected),
    );

    // ── 8. A WRAPPED paragraph: a selection on a later source line maps to
    // ITS line, not the paragraph's first (the user-reported collapse) ──
    // "middle" sits on the wrapped paragraph's second source line (doc 26),
    // past invisible ** markup: source col 24, rendered text-node offset found
    // by word.
    await freshPage(page, baseUrl);
    const found = await page.evaluate(() => {
        const el = document.querySelectorAll(".ProseMirror > p")[3];
        if (!el || !el.textContent.includes("middle")) { return false; }
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) =>
                n.parentElement?.closest("[contenteditable='false'], .ProseMirror-widget")
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT,
        });
        let node;
        while ((node = walker.nextNode())) {
            const idx = node.textContent.indexOf("middle");
            if (idx >= 0) {
                getSelection().setBaseAndExtent(node, idx, node, idx + "middle".length);
                return true;
            }
        }
        return false;
    });
    check("the wrapped paragraph and its 'middle' word exist", found, "");
    await page.waitForTimeout(150);
    target = await requestSwitch(page);
    check(
        "a selection on a wrapped line carries that line and markup-adjusted columns",
        target?.line === 26 && target?.column === 30 &&
        target?.anchorLine === 26 && target?.anchorColumn === 24,
        JSON.stringify(target),
    );

    // ── 9. Arriving on a wrapped line: range restored, caret typing lands there ──
    await page.evaluate(() =>
        window.postMessage(
            { type: "scrollToLine", line: 26, column: 30, anchorLine: 26, anchorColumn: 24 },
            "*",
        ));
    await page.waitForTimeout(250);
    selected = await page.evaluate(() => getSelection()?.toString() ?? "");
    check(
        "an arriving range on a wrapped line is selected",
        selected === "middle",
        JSON.stringify(selected),
    );
    await page.evaluate(() =>
        window.postMessage({ type: "scrollToLine", line: 27, column: 4 }, "*"));
    await page.waitForTimeout(250);
    await page.keyboard.type("W");
    await page.waitForTimeout(400);
    content = await lastContent(page);
    check(
        "a caret arriving on a wrapped paragraph's LAST line types on that line",
        content.includes("and Wfinally ends."),
        JSON.stringify(content.split("\n").filter((l) => l.includes("finally"))),
    );

    // ── 10. Arriving far down the document lands scrolled, not top-then-jump ──
    // The raw editor opens at the right place; the WYSIWYG side must too. The
    // scroll is applied synchronously in the init handler, so it must already
    // hold well before the 300ms fallback retry could have fired.
    await page.goto(`${baseUrl}/index.html?arrive=61`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(120);
    const arrivedScroll = await page.evaluate(() => window.scrollY);
    check(
        "an init-carried line is scrolled to before the fallback timers",
        arrivedScroll > 200,
        `scrollY=${arrivedScroll}`,
    );

    // ── 11. A selection whose head is off screen still carries the range ──
    // The user's explicit range beats "what the viewport shows": scrolling
    // away must not silently downgrade a selection to a bare viewport line.
    await freshPage(page, baseUrl);
    await selectRange(
        page,
        { selector: ".ProseMirror > p", offset: 0 },
        { selector: ".ProseMirror li p", nth: 1, offset: 4 },
    );
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
    await page.waitForTimeout(200);
    target = await requestSwitch(page);
    check(
        "an off-screen selection still carries both ends",
        target?.anchorLine === 7 && target?.line === 10,
        JSON.stringify(target),
    );
}
