/**
 * Floating selection palette end-to-end checks against the real bundle:
 *   - inline math is grouped with the marks (right after inline code);
 *   - the turn-into (P/H1–H6) dropdown shows for a whole-block selection but
 *     hides for a substring;
 *   - a mark already on the selection lights its button (active state);
 *   - the palette re-anchors when the editor content reflows (ResizeObserver);
 *   - opening the block (handle) menu dismisses the palette.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const toolbar = page.locator(".sel-toolbar");
    // The turn-into dropdown and the table-alignment dropdown share the wrap
    // class; the turn-into one is the only one carrying the P/H-level label.
    const fmtWrap = page.locator(".sel-toolbar .sel-tb-fmt-wrap:has(.sel-tb-fmt-label)");

    // Center-point of the first occurrence of `word` in the editor, via a Range
    // rect — robust to font/measure differences.
    const wordPoint = (word) =>
        page.evaluate((w) => {
            const pm = document.querySelector(".milkdown .ProseMirror");
            const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const idx = node.textContent.indexOf(w);
                if (idx >= 0) {
                    const r = document.createRange();
                    r.setStart(node, idx);
                    r.setEnd(node, idx + w.length);
                    const rect = r.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
            }
            return null;
        }, word);

    const selectWord = async (word) => {
        await page.waitForTimeout(700); // clear the browser multi-click window
        const p = await wordPoint(word);
        if (!p) throw new Error(`word not found: ${word}`);
        await page.mouse.dblclick(p.x, p.y);
        await page.waitForTimeout(150);
        return page.evaluate(() => window.getSelection().toString().trim());
    };

    const selectWholeParagraph = async () => {
        await page.waitForTimeout(700);
        const p = await wordPoint("plain");
        await page.mouse.click(p.x, p.y, { clickCount: 3 });
        await page.waitForTimeout(150);
    };

    // ── 1. Inline math is grouped with the marks (after inline code) ──
    // The bar is built at setup, so its DOM order is assertable without a
    // selection. aria-labels carry a trailing shortcut for some buttons, so
    // match on the leading name.
    const mathNeighbors = await page.evaluate(() => {
        const bar = document.querySelector(".sel-toolbar");
        const label = (el) => el?.getAttribute("aria-label") ?? "";
        const math = [...bar.querySelectorAll(".sel-tb-btn")].find((b) =>
            label(b).startsWith("Inline Math"));
        return {
            prev: label(math?.previousElementSibling),
            next: label(math?.nextElementSibling),
        };
    });
    check(
        "inline math sits between inline code and highlight",
        mathNeighbors.prev.startsWith("Inline Code") && mathNeighbors.next.startsWith("Highlight"),
        JSON.stringify(mathNeighbors),
    );

    // ── 2. Substring selection → format (turn-into) dropdown hidden ──
    const w = await selectWord("plain");
    check("a substring word is selected", w === "plain", JSON.stringify(w));
    check("the palette is visible for the substring", await toolbar.isVisible());
    check(
        "the turn-into dropdown is HIDDEN for a substring selection",
        !(await fmtWrap.isVisible()),
    );

    // The palette is one of the floating surfaces, so it paints the SAME ground
    // as every menu — the shared --ui-card-bg. It used to carry a 6% nudge
    // toward the ink of its own, added because a chip the color of the page is
    // invisible (2026-07-28) and dropped once every menu beside it settled on
    // one ground: the nudge separated the palette from the menus far more than
    // it separated it from the page, and on Slate it overshot the page rather
    // than clearing it. What holds the chip off the page now is the card border
    // and the elevation shadow, the same two things every menu uses.
    //
    // Asserted as sameness against a menu's ground rather than against a hex,
    // so the check keeps meaning if the card token is ever repointed.
    const groundOf = (sel) =>
        page.evaluate((s) => {
            // color-mix computes to `color(srgb r g b)` with 0-1 channels;
            // normalize either format to 0-255.
            const raw = getComputedStyle(document.querySelector(s)).backgroundColor;
            const nums = raw.match(/[\d.]+/g).map(Number);
            return nums.slice(0, 3).map((c) => (c <= 1 ? c * 255 : c));
        }, sel);
    const cardGround = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--ui-card-bg)";
        document.body.append(probe);
        const raw = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const nums = raw.match(/[\d.]+/g).map(Number);
        return nums.slice(0, 3).map((c) => (c <= 1 ? c * 255 : c));
    });
    const samePaint = (a, b) => a.every((c, i) => Math.abs(c - b[i]) <= 1);
    check(
        "the palette paints the shared card ground, not a surface of its own (light theme)",
        samePaint(await groundOf(".sel-toolbar"), cardGround),
        `${JSON.stringify(await groundOf(".sel-toolbar"))} vs card ${JSON.stringify(cardGround)}`,
    );
    // The chip is not the page: the ground is the card's, and the border is
    // what holds it off the document behind it.
    check(
        "the palette carries the card hairline that separates it from the page",
        await page.evaluate(() => {
            const s = getComputedStyle(document.querySelector(".sel-toolbar"));
            return s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) > 0;
        }),
    );
    await page.evaluate(() => document.body.classList.replace("vscode-light", "vscode-dark"));
    check(
        "the palette keeps the shared ground in a dark theme",
        samePaint(await groundOf(".sel-toolbar"), cardGround),
        JSON.stringify(await groundOf(".sel-toolbar")),
    );
    await page.evaluate(() => document.body.classList.replace("vscode-dark", "vscode-light"));

    // ── 3. Whole-block selection → format dropdown shown ──
    await selectWholeParagraph();
    check("the palette is visible for the whole block", await toolbar.isVisible());
    check(
        "the turn-into dropdown is SHOWN for a whole-block selection",
        await fmtWrap.isVisible(),
    );

    // ── 4. Active state: selecting the bold word lights the Bold button ──
    const b = await selectWord("bold");
    check("the bold word is selected", b === "bold", JSON.stringify(b));
    const boldActive = await page.evaluate(() => {
        const bar = document.querySelector(".sel-toolbar");
        const bold = [...bar.querySelectorAll(".sel-tb-btn")].find((el) =>
            (el.getAttribute("aria-label") ?? "").startsWith("Bold"));
        const italic = [...bar.querySelectorAll(".sel-tb-btn")].find((el) =>
            (el.getAttribute("aria-label") ?? "").startsWith("Italic"));
        return {
            bold: bold?.classList.contains("sel-tb-btn--active"),
            italic: italic?.classList.contains("sel-tb-btn--active"),
        };
    });
    check("the Bold button is lit for bold text", boldActive.bold === true);
    check("the Italic button is NOT lit for bold text", boldActive.italic === false);

    // ── 5. Reflow: the palette re-anchors when the editor content resizes ──
    const before = await toolbar.boundingBox();
    await page.evaluate(() => {
        // Shrink the editor content box — the ToC docking/resizing does this in
        // the real app; a ResizeObserver on the content should re-anchor the bar.
        const pm = document.querySelector(".milkdown .ProseMirror");
        pm.style.maxWidth = "320px";
        pm.style.marginLeft = "200px";
    });
    await page.waitForTimeout(200);
    const after = await toolbar.boundingBox();
    check(
        "the palette re-anchors after the editor content reflows",
        Boolean(before && after) && Math.abs(after.x - before.x) > 1,
        JSON.stringify({ beforeX: before?.x, afterX: after?.x }),
    );

    // ── 6. Opening the block (handle) menu dismisses the palette ──
    await selectWord("bold"); // palette up again
    check("the palette is visible before opening the block menu", await toolbar.isVisible());
    await page.locator(".heading-fold-marker").first().click({ force: true });
    await page.waitForSelector(".block-menu", { state: "visible", timeout: 3000 }).catch(() => {});
    const menuOpen = await page.locator(".block-menu").isVisible();
    check("clicking the gutter marker opens the block menu", menuOpen);
    await page.waitForTimeout(100); // let the menu's search input focus (focusin → hide)
    check(
        "opening the block menu dismisses the floating palette",
        !(await toolbar.isVisible()),
    );

    // ── 7. Block palette: the grab-menu button shows the block symbol and
    // opens the gutter block menu. Select the H1 heading as a whole block. ──
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.locator(".ProseMirror h1").first().click();
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape"); // caret → whole-block (BlockRangeSelection)
    await page.waitForTimeout(250);
    const gripInfo = await page.evaluate(() => {
        const bar = document.querySelector(".sel-toolbar");
        if (!bar || bar.style.display === "none") return { visible: false };
        const grip = [...bar.querySelectorAll(".sel-tb-btn")].find((b) =>
            (b.getAttribute("aria-label") ?? "").startsWith("Block menu"));
        return {
            visible: Boolean(grip && grip.style.display !== "none"),
            badge: grip?.querySelector(".sel-tb-block-badge")?.textContent ?? null,
        };
    });
    check("selecting a whole block shows the grab-menu button in the palette", gripInfo.visible);
    check("the grab-menu button shows the block symbol (H1 for the heading)",
        gripInfo.badge === "H1", JSON.stringify(gripInfo));

    await page.evaluate(() => {
        const bar = document.querySelector(".sel-toolbar");
        const grip = [...bar.querySelectorAll(".sel-tb-btn")].find((b) =>
            (b.getAttribute("aria-label") ?? "").startsWith("Block menu"));
        grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await page.waitForSelector(".block-menu", { state: "visible", timeout: 3000 }).catch(() => {});
    check(
        "clicking the grab-menu button opens the block menu",
        await page.locator(".block-menu").isVisible(),
    );

    // ── Agent-reference button: the one-click "copy for my AI agent" path ──
    await page.keyboard.press("Escape"); // leave block mode
    await page.waitForTimeout(150);
    // Collapse the block selection with its OWN click before double-clicking a
    // word. Escape hides the palette but leaves the block selection standing,
    // and folding the collapse and the word-select into one double-click is
    // unreliable: the collapse re-renders the paragraph between the two
    // mousedowns, so the browser's word selection lands on replaced DOM and
    // yields an empty selection. (Order-dependent, not a palette bug — a
    // second identical double-click always succeeds.)
    const plainPoint = await wordPoint("plain");
    await page.mouse.click(plainPoint.x, plainPoint.y);
    await page.waitForTimeout(150);
    const agentSel = await selectWord("plain");
    const agentBtn = page.locator(".sel-tb-agent-btn");
    check(
        "a text selection shows the agent-reference button",
        await agentBtn.isVisible(),
        `selection: ${JSON.stringify(agentSel)}`,
    );
    // Chrome buttons act on mousedown (see webview/ui/dom.ts); a synthetic
    // click with detail 0 would read as a keyboard activation and double-fire.
    await page.evaluate(() => {
        document.querySelector(".sel-tb-agent-btn")
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(80);
    const agentPosts = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "copyAgentReference").length,
    );
    check(
        "clicking the agent-reference button asks the extension to copy the reference",
        agentPosts === 1,
        `copyAgentReference messages: ${agentPosts}`,
    );

    // ── The palette never opens inside the fixed topbar's band ──
    // The topbar is fixed, opaque, and z 10002 against the palette's 1200, so
    // a palette placed above it is not merely awkward — it is invisible and
    // unclickable. A selection in the FIRST block is the reachable case: the
    // content starts one topbar-height down, so the space above the selection
    // looks ample measured from y=0 and is nil measured from the bar.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const firstLine = await selectWord("Heading");
    const band = await page.evaluate(() => {
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        const tb = document.querySelector(".sel-toolbar").getBoundingClientRect();
        const sel = window.getSelection().getRangeAt(0).getBoundingClientRect();
        return {
            barBottom: bar.bottom,
            paletteTop: tb.top,
            paletteHeight: tb.height,
            selTop: sel.top,
        };
    });
    check(
        "the first-line word is selected",
        firstLine === "Heading",
        JSON.stringify(firstLine),
    );
    // Precondition, so the assertion below cannot pass vacuously: there must
    // be too little room above the selection to hold the palette clear of the
    // bar. Without this, a fixture that simply had room would "pass".
    check(
        "the first-line selection genuinely has no room above it for the palette",
        band.selTop - band.barBottom < band.paletteHeight + 8,
        JSON.stringify(band),
    );
    check(
        "the palette opens clear of the topbar rather than behind it",
        band.paletteTop >= band.barBottom,
        JSON.stringify(band),
    );
}
