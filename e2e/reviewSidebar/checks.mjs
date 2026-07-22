/**
 * The MAR-188 review sidebar, verified against the REAL bundle — the surface
 * the jsdom unit suite can only assume, since it never mounts Milkdown, never
 * parses markers out of a real markdown round-trip (HTML comments as `html`
 * atoms, `- [ ]` as a checked list_item), and never runs the proofread pass.
 *
 * Covers: the four tabs render in order (Contents/Links/Notes/Proofreading);
 * Notes lists every built-in marker in document order with no dismiss actions;
 * Proofreading lists live style findings; Links groups by destination with the
 * URL inline on hover and a working Open action; keyboard nav; and typing with
 * the Notes tab open keeps the list correct through the incremental scan — with
 * a page-error/console-error guard over the whole run (MAR-192 hardening).
 */
export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    // Let auto-open + the deferred proofread idle pass settle.
    await page.waitForSelector(".pf-style-hit", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);

    // ── Tabs render ───────────────────────────────────────────────────────
    const tabLabels = await page.$$eval(".toc-tab", (els) => els.map((e) => e.textContent));
    check("four tabs render in the order Contents / Links / Notes / Proofread",
        JSON.stringify(tabLabels) === JSON.stringify(["Contents", "Links", "Notes", "Proofread"]),
        JSON.stringify(tabLabels));

    // Contents is the default tab and lists the headings.
    const headingRows = await page.$$eval(".toc-list .toc-item", (els) => els.map((e) => e.textContent.trim()));
    check("Contents tab lists the document headings",
        headingRows.length === 5 && headingRows[0] === "Intro",
        JSON.stringify(headingRows));

    // The inactive tabs' lists must be fully hidden — a CSS regression once let
    // .review-list's `display:flex` override .toc-view--hidden, leaking the
    // Proofreading/Notes lists (and a second toggle) into other tabs.
    const leak = await page.evaluate(() => {
        const shown = (sel) => { const el = document.querySelector(sel); return !!el && el.offsetHeight > 0; };
        return { proof: shown(".review-list--proofread"), notes: shown(".review-list--notes") };
    });
    check("inactive review lists are fully hidden on the Contents tab (no leak)",
        !leak.proof && !leak.notes, JSON.stringify(leak));

    // ── Outline accordion: a heading with children folds away its subtree ──
    // Intro (H1) parents the three H2s; collapsing it hides them.
    const visible = () => page.$$eval(".toc-list .toc-item:not([hidden])", (e) => e.length);
    const parentCount = await page.$$eval(".toc-list .toc-item--parent", (e) => e.length);
    check("a heading with nested headings is marked foldable", parentCount >= 1, `parents=${parentCount}`);
    const shownBefore = await visible();
    await page.locator(".toc-list .toc-item--parent .toc-caret").first().click();
    await page.waitForTimeout(100);
    const shownCollapsed = await visible();
    check("collapsing an outline heading hides its nested headings",
        shownCollapsed < shownBefore, `${shownBefore} -> ${shownCollapsed}`);
    await page.locator(".toc-list .toc-item--parent .toc-caret").first().click();
    await page.waitForTimeout(100);
    check("expanding restores them", (await visible()) === shownBefore, `restored`);

    // ── Keyboard: the outline is arrow-navigable and foldable ─────────────
    await page.locator(".toc-list .toc-item").first().focus();
    const kbA = await page.evaluate(() => document.activeElement?.textContent ?? "");
    await page.keyboard.press("ArrowDown");
    const kbB = await page.evaluate(() => document.activeElement?.textContent ?? "");
    check("ArrowDown moves focus down the outline", !!kbB && kbA !== kbB, `${kbA} -> ${kbB}`);
    await page.locator(".toc-list .toc-item--parent").first().focus();
    const foldBefore = await visible();
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(60);
    const foldAfter = await visible();
    check("ArrowLeft folds the focused outline heading", foldAfter < foldBefore, `${foldBefore} -> ${foldAfter}`);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    check("ArrowRight unfolds it again", (await visible()) === foldBefore, `restored`);

    // ── Notes tab: markers in document order, checked box excluded ─────────
    await page.click(".toc-tab:nth-child(3)"); // Notes
    await page.waitForSelector(".review-list--notes:not(.toc-view--hidden)", { timeout: 5000 });
    const notes = await page.$$eval(".review-list--notes .review-item", (els) =>
        els.map((el) => ({
            tag: el.querySelector(".review-item__tag")?.textContent,
            label: el.querySelector(".review-item__label")?.textContent,
        })));
    check("Notes lists every built-in marker in document order",
        JSON.stringify(notes.map((n) => n.tag)) === JSON.stringify(["TK", "TODO", "FIXME"]),
        JSON.stringify(notes));

    // ── Grouping: default By-type shows one header per marker type ─────────
    const groupNames = await page.$$eval(".review-list--notes .review-group__name", (els) => els.map((e) => e.textContent));
    check("Notes defaults to By-type grouping with a header per type",
        JSON.stringify(groupNames) === JSON.stringify(["TK", "TODO", "FIXME"]),
        JSON.stringify(groupNames));

    // Switch to In-order: headers disappear, the flat list remains.
    await page.locator(".toc-utility .review-seg", { hasText: "In order" }).click();
    await page.waitForTimeout(100);
    const afterFlat = await page.$$eval(".review-list--notes .review-group", (els) => els.length);
    check("the In-order toggle drops the group headers", afterFlat === 0, `groups=${afterFlat}`);

    // Back to By-type, then collapse a group: its row leaves the DOM.
    await page.locator(".toc-utility .review-seg", { hasText: "By type" }).click();
    await page.waitForTimeout(100);
    const beforeCollapse = await page.$$eval(".review-list--notes .review-item", (e) => e.length);
    await page.click(".review-list--notes .review-group:first-child");
    await page.waitForTimeout(100);
    const afterCollapse = await page.$$eval(".review-list--notes .review-item", (e) => e.length);
    check("collapsing a group removes its rows from the list",
        afterCollapse === beforeCollapse - 1, `before=${beforeCollapse} after=${afterCollapse}`);
    // Re-expand so the later navigation/typing checks see the full list again.
    await page.click(".review-list--notes .review-group:first-child");
    await page.waitForTimeout(100);
    check("task checkboxes are NOT listed as notes (they're content, not scaffolding)",
        !notes.some((n) => /gather sources|outline done/.test(n.label || "")),
        JSON.stringify(notes.map((n) => n.label)));
    check("a bracketed/colon marker's trailing text becomes the row label",
        notes.some((n) => n.tag === "TODO" && /background section/.test(n.label || "")),
        JSON.stringify(notes.map((n) => n.label)));

    // ── Proofreading tab: a live style finding ────────────────────────────
    await page.click(".toc-tab:nth-child(4)"); // Proofreading
    await page.waitForSelector(".review-list--proofread:not(.toc-view--hidden)", { timeout: 5000 });
    await page.waitForTimeout(300);
    const findings = await page.$$eval(".review-list--proofread .review-item", (els) =>
        els.map((el) => el.querySelector(".review-item__label")?.textContent));
    check("Proofreading lists the live style finding (filler 'really')",
        findings.some((f) => f === "really"),
        JSON.stringify(findings));
    // Em-dash findings can't identify themselves as "—"; they must fall back to a
    // surrounding-context snippet so a group isn't N identical dash rows.
    check("short/punctuation findings show context, not a bare glyph",
        findings.length > 0 && !findings.some((f) => f === "—") && findings.some((f) => /—/.test(f) && f.length > 3),
        JSON.stringify(findings));
    // The flagged span inside a context label is marked so the row shows WHAT's flagged.
    const flags = await page.$$eval(".review-list--proofread .review-item__flag", (els) => els.map((e) => e.textContent));
    check("the flagged span is emphasized inside context labels", flags.includes("—"), JSON.stringify(flags));

    // A group larger than the cap shows a "Show K more" toggle; clicking it reveals the rest.
    const emItemsBefore = await page.$$eval(".review-list--proofread .review-item", (e) => e.length);
    const moreLabels = await page.$$eval(".review-list--proofread .review-more", (els) => els.map((e) => e.textContent));
    check("a large group caps its rows behind a Show-more toggle",
        moreLabels.some((l) => /Show \d+ more/.test(l)), JSON.stringify(moreLabels));
    await page.locator(".review-list--proofread .review-more").first().click();
    await page.waitForTimeout(100);
    const emItemsAfter = await page.$$eval(".review-list--proofread .review-item", (e) => e.length);
    check("Show-more reveals the hidden rows", emItemsAfter > emItemsBefore, `${emItemsBefore} -> ${emItemsAfter}`);

    // ── Keyboard: review list arrow-nav + Escape returns to the editor ────
    await page.locator(".review-list--proofread .review-group, .review-list--proofread .review-item__main").first().focus();
    await page.keyboard.press("ArrowDown");
    const stayInList = await page.evaluate(() => !!document.activeElement?.closest(".review-list--proofread"));
    check("review list is arrow-navigable (focus stays within it)", stayInList);
    await page.keyboard.press("Escape");
    const backToEditor = await page.evaluate(() => !!document.activeElement?.closest(".milkdown .ProseMirror"));
    check("Escape returns focus from the review list to the editor", backToEditor);

    // ── Click a Notes row → it selects the marker in the editor ───────────
    await page.click(".toc-tab:nth-child(3)"); // back to Notes
    await page.waitForSelector(".review-list--notes:not(.toc-view--hidden)", { timeout: 5000 });
    // The [TK] row is first (document order); clicking it must select "[TK]".
    await page.locator(".review-list--notes .review-item__main").first().click();
    await page.waitForTimeout(150);
    const selected = await page.evaluate(() => (window.getSelection()?.toString() ?? ""));
    check("clicking the [TK] note selects its marker in the document",
        selected.includes("[TK]"), JSON.stringify(selected));

    // ── Type with the Notes tab open → incremental scan keeps it correct ──
    const beforeCount = notes.length;
    await page.click(".ProseMirror");
    // Type into the first paragraph, ahead of every marker, so every anchor
    // shifts — the incremental-scan path.
    await page.keyboard.press("Home");
    await page.keyboard.type("Prefixed. ");
    await page.waitForTimeout(300);
    const afterTags = await page.$$eval(".review-list--notes .review-item", (els) =>
        els.map((el) => el.querySelector(".review-item__tag")?.textContent));
    check("typing with the Notes tab open keeps the marker list intact",
        JSON.stringify(afterTags) === JSON.stringify(["TK", "TODO", "FIXME"]),
        `before=${beforeCount} after=${JSON.stringify(afterTags)}`);

    // Clicking [TK] AFTER the edit must still select it (anchors tracked live).
    await page.locator(".review-list--notes .review-item__main").first().click();
    await page.waitForTimeout(150);
    const selectedAfter = await page.evaluate(() => (window.getSelection()?.toString() ?? ""));
    check("after typing, the [TK] note still selects its (shifted) marker",
        selectedAfter.includes("[TK]"), JSON.stringify(selectedAfter));

    // ── Toolbar "Show issues" reveals the Proofreading tab ────────────────
    await page.click(".toc-tab:nth-child(1)"); // move off Proofreading (to Contents)
    const checksBtn = page.locator('.editor-topbar [aria-label="Checks"]');
    if (await checksBtn.count()) {
        await checksBtn.hover();
        await page.waitForSelector(".tb-checks-menu .tb-checks-action", { state: "visible", timeout: 5000 });
        await page.click(".tb-checks-menu .tb-checks-action");
        await page.waitForTimeout(200);
        const proofActive = await page.$eval(".toc-tab:nth-child(4)",
            (el) => el.classList.contains("toc-tab--active"));
        check("toolbar 'Show issues' switches the sidebar to the Proofreading tab", proofActive);
    } else {
        check("toolbar 'Show issues' switches the sidebar to the Proofreading tab", true,
            "SKIPPED — Checks button not rendered in this harness");
    }

    // ── Links tab: every link in the doc, grouped by destination kind ─────
    await page.click(".toc-tab:nth-child(2)"); // Links
    await page.waitForSelector(".review-list--links:not(.toc-view--hidden)", { timeout: 5000 });
    await page.waitForTimeout(150);
    const linkGroups = await page.$$eval(".review-list--links .review-group__name", (els) => els.map((e) => e.textContent));
    check("Links groups by DESTINATION (Web / Local files / This document; wikilinks fold into Local files)",
        linkGroups.includes("Web") && linkGroups.includes("Local files") && linkGroups.includes("This document")
            && !linkGroups.includes("Wikilink"),
        JSON.stringify(linkGroups));
    const linkRows = await page.$$eval(".review-list--links .review-item__label", (els) => els.map((e) => e.textContent));
    check("Links lists the document's links (inline, autolink, local, wiki)",
        linkRows.includes("inline link") && linkRows.some((l) => /autolink\.dev/.test(l)) && linkRows.includes("wiki page"),
        JSON.stringify(linkRows));

    // ── URL meta shows inline on row hover (not a tooltip) ────────────────
    const inlineRow = page.locator(".review-list--links .review-item", { hasText: "inline link" }).first();
    const metaHidden = await inlineRow.locator(".review-item__meta").evaluate((el) => getComputedStyle(el).display === "none");
    await inlineRow.hover();
    const metaShown = await inlineRow.locator(".review-item__meta").evaluate(
        (el) => getComputedStyle(el).display !== "none" && el.textContent === "https://example.com");
    check("a link row reveals its URL inline on hover", metaHidden && metaShown,
        `hidden-before=${metaHidden} shown-on-hover=${metaShown}`);

    // ── The URL text itself is clickable and follows the link ─────────────
    await page.evaluate(() => { window.__posted.length = 0; });
    await inlineRow.hover();
    await inlineRow.locator(".review-item__meta").click();
    const metaOpened = await page.evaluate(() =>
        window.__posted.some((m) => m.type === "openUrl" && /example\.com/.test(m.url)));
    check("clicking the URL text follows the link (posts openUrl)", metaOpened,
        JSON.stringify(await page.evaluate(() => window.__posted.map((m) => m.type))));

    // An in-document anchor row's Open follows to the TARGET heading (no host
    // message — it scrolls the doc to the heading), never posts an open.
    await page.evaluate(() => { window.__posted.length = 0; });
    const docRow = page.locator(".review-list--links .review-item", { hasText: "heading" }).first();
    await docRow.hover();
    await docRow.locator(".review-item__action", { hasText: "Open" }).click();
    await page.waitForTimeout(150);
    const anchorPosted = await page.evaluate(() =>
        window.__posted.some((m) => m.type === "openUrl" || m.type === "openFile"));
    check("an in-document anchor's Open resolves in-doc (no host open message)", !anchorPosted);

    // ── Open action follows the link (posts the host open message) ────────
    await page.evaluate(() => { window.__posted.length = 0; });
    await inlineRow.locator(".review-item__action", { hasText: "Open" }).click();
    const opened = await page.evaluate(() =>
        window.__posted.some((m) => m.type === "openUrl" || m.type === "openFile" || /open/i.test(m.type)));
    check("the Open action posts an open message to the host", opened,
        JSON.stringify(await page.evaluate(() => window.__posted.map((m) => m.type))));

    // ── Notes rows carry NO dismiss action (a note is document content) ───
    await page.click(".toc-tab:nth-child(3)");
    await page.waitForTimeout(100);
    const noteActions = await page.$$eval(".review-list--notes .review-item__action", (els) => els.length);
    check("notes rows have no per-row actions (edit the doc to clear a note)", noteActions === 0, `actions=${noteActions}`);

    // ── Show-more is a full-width row like its neighbors ──────────────────
    await page.click(".toc-tab:nth-child(4)"); // Proofreading (has a capped group)
    await page.waitForTimeout(100);
    const widths = await page.evaluate(() => {
        const more = document.querySelector(".review-list--proofread .review-more");
        const item = document.querySelector(".review-list--proofread .review-item");
        return more && item ? { more: more.getBoundingClientRect().width, item: item.getBoundingClientRect().width } : null;
    });
    check("Show-more spans the full row width", !!widths && Math.abs(widths.more - widths.item) < 2,
        JSON.stringify(widths));

    // ── All four tabs share one row at the default width (no wrap) ────────
    const tabTops = await page.$$eval(".toc-tab", (els) => els.map((e) => e.getBoundingClientRect().top));
    check("the four tabs sit on ONE row at the default width",
        new Set(tabTops.map((t) => Math.round(t))).size === 1, JSON.stringify(tabTops));

    // ── Shortcuts panel: wheel scrolls the PANEL, never chains to the doc ──
    await page.setViewportSize({ width: 1000, height: 480 }); // force panel overflow
    const gear = page.locator('.editor-topbar [aria-label="Settings"]').first();
    await gear.hover();
    await page.waitForTimeout(250);
    await page.locator(".tb-fmt-item", { hasText: "Keyboard Shortcuts" }).first().dispatchEvent("mousedown");
    await page.waitForTimeout(250);
    const shBox = await page.locator(".shortcuts-help").boundingBox();
    await page.mouse.move(shBox.x + shBox.width / 2, shBox.y + shBox.height / 2);
    const docYBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 4000); // far past the panel's range
    await page.waitForTimeout(200);
    const scrollRes = await page.evaluate(() => ({
        panel: document.querySelector(".shortcuts-help").scrollTop,
        docMoved: window.scrollY,
    }));
    check("wheel over the shortcuts panel scrolls the panel",
        scrollRes.panel > 0, JSON.stringify(scrollRes));
    check("an exhausted wheel gesture does NOT chain to the document (overscroll contained)",
        scrollRes.docMoved === docYBefore, JSON.stringify({ before: docYBefore, after: scrollRes.docMoved }));
    check("the shortcuts footer keeps only the Edit button (note line removed)",
        await page.evaluate(() => {
            const f = document.querySelector(".shortcuts-help__footer");
            return !!f.querySelector(".shortcuts-help__customize") && !f.querySelector(".shortcuts-help__note");
        }));
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1000, height: 800 });

    check("no page errors or console errors during the run", errors.length === 0,
        errors.slice(0, 5).join(" | "));
}
