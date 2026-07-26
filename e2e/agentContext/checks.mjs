/**
 * The coding-agent bridge's selection context, against the real bundle: a
 * `requestEditorContext` message must come back as `editorContextResult` with
 * the live selection in DOCUMENT coordinates (frontmatter included).
 *
 * The fixture's loose list is the regression that shipped wrong in the wild:
 * one document node spanning eight map entries. Before reconciliation-by-text,
 * a caret in the paragraph after it reported the line of a list item 16 lines
 * up, and a caret in a later loose item reported a contiguous guess several
 * lines short.
 */

let reqSeq = 0;

/** Ask the webview for its selection context, exactly as the extension does. */
async function requestContext(page) {
    const id = `e2e-${++reqSeq}`;
    await page.evaluate(
        (id) => window.postMessage({ type: "requestEditorContext", id }, "*"),
        id,
    );
    await page.waitForTimeout(80);
    return page.evaluate((id) => {
        const replies = window.__posted.filter(
            (m) => m.type === "editorContextResult" && m.id === id,
        );
        return replies[replies.length - 1] ?? null;
    }, id);
}

/** Put a collapsed caret `offset` characters into the block matching `selector`. */
async function caretInto(page, selector, offset, { nth = 0 } = {}) {
    await page.locator(selector).nth(nth).click();
    const placed = await page.evaluate(
        ({ selector, nth, offset }) => {
            const el = document.querySelectorAll(selector)[nth];
            if (!el) { return -1; }
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
            if (!node) { return -1; }
            const range = document.createRange();
            range.setStart(node, remaining);
            range.collapse(true);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return remaining;
        },
        { selector, nth, offset },
    );
    if (placed < 0) { throw new Error(`caretInto: no text node at ${selector}[${nth}]+${offset}`); }
    await page.waitForTimeout(80);
}

/** Select [from, to) within the first text node of the block matching `selector`. */
async function selectWithin(page, selector, from, to, { nth = 0 } = {}) {
    await page.locator(selector).nth(nth).click();
    await page.evaluate(
        ({ selector, nth, from, to }) => {
            const el = document.querySelectorAll(selector)[nth];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode();
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, to);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        },
        { selector, nth, from, to },
    );
    await page.waitForTimeout(80);
}

export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    // ── 1. Shape and correlation ──
    await caretInto(page, ".ProseMirror > p", 6, { nth: 0 }); // "Intro paragraph."
    let reply = await requestContext(page);
    check("a request is answered with a correlated editorContextResult", reply !== null, JSON.stringify(reply));
    check(
        "a bare caret reports isEmpty with one selection",
        reply?.context?.isEmpty === true && reply?.context?.selections?.length === 1,
        JSON.stringify(reply?.context),
    );
    let sel = reply?.context?.selections?.[0];
    check(
        "a caret in a paragraph carries its DOCUMENT line (frontmatter included) and column",
        sel?.active?.line === 7 && sel?.active?.column === 6,
        JSON.stringify(sel),
    );

    // ── 2. THE field regression: a caret after the loose list ──
    // "After the list." is document line 27; the naive entry-per-node pairing
    // says 11 (a list item 16 lines up).
    await caretInto(page, ".ProseMirror > p", 6, { nth: 1 });
    sel = (await requestContext(page))?.context?.selections?.[0];
    check(
        "a caret in the paragraph after the loose list reports the paragraph's real line",
        sel?.active?.line === 27 && sel?.active?.column === 6,
        JSON.stringify(sel),
    );

    // ── 3. A caret INSIDE a later loose item: anchors are not contiguous ──
    // "item six" is document line 25; the contiguous guess (blockLine + anchor
    // index) says 18.
    await caretInto(page, ".ProseMirror li p", 2, { nth: 9 });
    sel = (await requestContext(page))?.context?.selections?.[0];
    check(
        "a caret in a late loose-list item reports the item's real line",
        sel?.active?.line === 25,
        JSON.stringify(sel),
    );

    // ── 4. A nested sub-item separated from its parent by a blank line ──
    // "sub b" is document line 16.
    await caretInto(page, ".ProseMirror li p", 2, { nth: 4 });
    sel = (await requestContext(page))?.context?.selections?.[0];
    check(
        "a caret in a nested sub-item reports the sub-item's real line",
        sel?.active?.line === 16,
        JSON.stringify(sel),
    );

    // ── 5. A paragraph whose SOURCE line ends with a trailing space ──
    // "Trailing space here. " is document line 33; the invisible trailing
    // space used to fail the exact suffix match and derail reconciliation.
    await caretInto(page, ".ProseMirror > p", 3, { nth: 3 });
    sel = (await requestContext(page))?.context?.selections?.[0];
    check(
        "a caret in a paragraph whose source line ends with a space reports its real line",
        sel?.active?.line === 33,
        JSON.stringify(sel),
    );

    // ── 6. A tight ordered list whose items carry inline markup, behind a
    // cumulative drift of 8 map entries. Rendered text drops the link URL and
    // the emphasis asterisks, so only the normalized (letters+digits) match
    // can verify the pairing. "As Teller put it…" is document line 45.
    await caretInto(page, ".ProseMirror ol li p", 3, { nth: 2 });
    sel = (await requestContext(page))?.context?.selections?.[0];
    check(
        "a caret in a marked-up ordered-list item past two loose lists reports its real line",
        sel?.active?.line === 45,
        JSON.stringify(sel),
    );

    // ── 7. The paragraph after everything — maximum accumulated drift ──
    await caretInto(page, ".ProseMirror > p", 2, { nth: 4 });
    sel = (await requestContext(page))?.context?.selections?.[0];
    check(
        "a caret in the final paragraph reports its real line",
        sel?.active?.line === 47,
        JSON.stringify(sel),
    );

    // ── 8. A real selection carries its range and plain text ──
    await selectWithin(page, ".ProseMirror > p", 0, 5, { nth: 0 }); // "Intro"
    const ctx = (await requestContext(page))?.context;
    check("a selection is not empty", ctx?.isEmpty === false, JSON.stringify(ctx));
    sel = ctx?.selections?.[0];
    check(
        "a selection carries ordered anchor/active columns on its line",
        sel?.anchor?.line === 7 && sel?.anchor?.column === 0 && sel?.active?.column === 5,
        JSON.stringify(sel),
    );
    check("a selection carries its plain text", sel?.text === "Intro", JSON.stringify(sel?.text));

    // ── 9. Selection carry, raw → rendered: a scrollToLine bearing an anchor
    // restores the whole selection, not a bare caret ──
    await page.evaluate(() =>
        window.postMessage(
            { type: "scrollToLine", line: 27, column: 5, anchorLine: 7, anchorColumn: 0 },
            "*",
        ),
    );
    await page.waitForTimeout(150);
    const carried = (await requestContext(page))?.context;
    check(
        "an arriving selection spans anchor to caret with its text",
        carried?.isEmpty === false &&
            carried?.selections?.[0]?.anchor?.line === 7 &&
            carried?.selections?.[0]?.active?.line === 27 &&
            (carried?.selections?.[0]?.text?.length ?? 0) > 0,
        JSON.stringify({ ...carried, selections: carried?.selections?.map((s) => ({ ...s, text: s.text.slice(0, 30) })) }),
    );

    // ── 10. Selection carry, rendered → raw: the switch target bears the anchor ──
    await selectWithin(page, ".ProseMirror > p", 0, 5, { nth: 0 }); // "Intro"
    await page.evaluate(() => window.postMessage({ type: "requestSwitchToTextEditor" }, "*"));
    await page.waitForTimeout(150);
    const switchTarget = await page.evaluate(() => {
        const posted = window.__posted.filter((m) => m.type === "switchToTextEditor");
        return posted[posted.length - 1] ?? null;
    });
    check(
        "a departing selection carries caret line/column and its anchor",
        switchTarget?.line === 7 &&
            switchTarget?.column === 5 &&
            switchTarget?.anchorLine === 7 &&
            switchTarget?.anchorColumn === 0,
        JSON.stringify(switchTarget),
    );

    check("no page errors", errors.length === 0, errors.join(" | "));
}
