/**
 * Content-width segmented control (MAR-51) end-to-end checks against the real
 * bundle: the typography (A) menu carries a Full Width / Fixed Width segmented
 * control (the Font settings row left the menu); picking Fixed Width caps the document
 * (`--editor-max-width` px + no full-width body class) and Full Width restores
 * the pane-filling layout. Choices post a `setContentWidth` message.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const fontWrap = page.locator('[data-item-id="fontPreset"]');
    check("the typography (A) menu item renders", (await fontWrap.count()) > 0);

    // Open the hover menu (wireHoverMenu opens on mouseenter of the wrap).
    await fontWrap.dispatchEvent("mouseenter");
    await page.waitForTimeout(150);

    const segButtons = page.locator(".tb-font-menu .tb-seg-btn");
    const segCount = await segButtons.count();
    check("a two-button segmented control renders in the menu", segCount === 2, `count=${segCount}`);

    const labels = await segButtons.allTextContents();
    check(
        "the segments read Full Width / Fixed",
        labels.join("|") === "Full Width|Fixed",
        labels.join("|"),
    );

    // Labels must never wrap to a second line.
    const singleLine = await page.evaluate(() => {
        const btns = [...document.querySelectorAll(".tb-font-menu .tb-seg-btn")];
        return btns.every((b) => {
            const cs = getComputedStyle(b);
            return cs.whiteSpace === "nowrap" && b.offsetHeight <= 28;
        });
    });
    check("the segment labels stay on a single line (no wrap)", singleLine);

    // The "Font settings" row deliberately LEFT this menu (the display (A)
    // menu slimmed down — see the CHANGELOG Changed entry; the entry lives in
    // Settings-only territory now). Pin the removal alongside the control's
    // presence, so a resurrected row fails loudly instead of drifting back.
    const slimmed = await page.evaluate(() => {
        const menu = document.querySelector(".tb-font-menu");
        if (!menu) return { seg: false, settingsRow: true };
        return {
            seg: !!menu.querySelector(".tb-seg-row"),
            settingsRow: [...menu.querySelectorAll(".tb-fmt-item")].some(
                (el) => el.textContent.trim() === "Font settings",
            ),
        };
    });
    check("the width control renders and the Font settings row stays gone",
        slimmed.seg && !slimmed.settingsRow, JSON.stringify(slimmed));

    // Default: Full Width active.
    const fullBtn = segButtons.nth(0);
    const fixedBtn = segButtons.nth(1);
    check(
        "Full Width is active by default",
        (await fullBtn.getAttribute("class")).includes("tb-seg-btn--on"),
    );

    const maxWidth = () =>
        page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-max-width").trim());
    const hasAutoClass = () => page.evaluate(() => document.body.classList.contains("editor-width-auto"));
    const lastWidthMsg = () =>
        page.evaluate(() => {
            const m = window.__posted.filter((x) => x.type === "setContentWidth");
            return m.length ? m[m.length - 1] : null;
        });

    // ── Click Fixed ──
    await fixedBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(100);
    check("Fixed sets --editor-max-width to 100ch (from maxContentWidth)", (await maxWidth()) === "100ch", await maxWidth());
    check("Fixed removes the full-width body class", (await hasAutoClass()) === false);
    check(
        "Fixed marks the Fixed segment active",
        (await fixedBtn.getAttribute("class")).includes("tb-seg-btn--on"),
    );
    check(
        "Fixed posts setContentWidth mode=fixed",
        (await lastWidthMsg())?.mode === "fixed",
        JSON.stringify(await lastWidthMsg()),
    );

    // The frontmatter panel and the editor must cap to the SAME width even
    // though the panel uses the UI font and #editor the content font — the
    // panel resolves its ch cap against the content font so the edges align.
    // (The harness uses a monospace content font vs a proportional UI font, so
    // this would diverge without that alignment.)
    const widthMatch = await page.evaluate(() => {
        const editor = document.querySelector("#editor");
        const panel = document.querySelector("#frontmatter-panel");
        if (!editor || !panel) return { ok: false, reason: "missing element" };
        const ew = editor.getBoundingClientRect().width;
        const pw = panel.getBoundingClientRect().width;
        return { ok: Math.abs(ew - pw) <= 1, ew: Math.round(ew), pw: Math.round(pw) };
    });
    check(
        "the frontmatter panel caps to the same width as the editor",
        widthMatch.ok,
        `editor=${widthMatch.ew} panel=${widthMatch.pw}`,
    );

    // ...but the metadata VALUES stay in the UI font (Arial here), not the
    // content/editor font (Courier) the box borrows only for its ch width.
    const valueFont = await page.evaluate(() => {
        const val = document.querySelector("#frontmatter-panel .fm-val, #frontmatter-panel td:not(.fm-key)");
        return val ? getComputedStyle(val).fontFamily : null;
    });
    check(
        "frontmatter values render in the UI font, not the content font",
        !!valueFont && /arial|helvetica|sans-serif/i.test(valueFont) && !/courier/i.test(valueFont),
        String(valueFont),
    );

    // ── Fixed-width content must clear a docked TOC sidebar, not hide under it ──
    // Regression guard for the centering fix: in Fixed mode the content box is
    // capped and would otherwise center in the whole viewport, so a wide docked
    // sidebar overlaps its start. We widen the drawer to a value at which plain
    // viewport-centering WOULD tuck the content under it, then assert the fix
    // pushes the content clear (its box never starts left of the drawer's edge).
    // Open the drawer (the harness doesn't auto-open it) — docked at 1000px wide.
    await page.evaluate(() => {
        document.querySelector(".toc-toggle-tab")
            ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const clearance = await page.evaluate(() => {
        // Force a wide drawer (the panel and the reserve both read --toc-width).
        document.documentElement.style.setProperty("--toc-width", "460px");
        const editor = document.querySelector("#editor");
        const panel = document.querySelector(".toc-panel");
        if (!editor || !panel) return { ok: false, reason: "missing element" };
        const e = editor.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        // Where plain `margin: 0 auto` would place this same box.
        const naiveCenterLeft = (window.innerWidth - e.width) / 2;
        return {
            dockedOpen:
                document.body.classList.contains("toc-open") &&
                panel.classList.contains("toc-panel--open"),
            editorLeft: Math.round(e.left),
            panelRight: Math.round(p.right),
            wouldOverlapNaively: naiveCenterLeft < p.right,
            clears: e.left >= p.right,
        };
    });
    // Guard against a vacuous pass: the drawer must actually be docked+open.
    check(
        "the TOC is docked+open in the fixed-width harness",
        clearance.dockedOpen,
        JSON.stringify(clearance),
    );
    // Prove the scenario is real: a plain-centered box of this width would overlap.
    check(
        "a naively centered box would tuck under the widened drawer",
        clearance.wouldOverlapNaively,
        `naiveCenter<panelRight? editorLeft=${clearance.editorLeft} panelRight=${clearance.panelRight}`,
    );
    // The fix: fixed-width content clears the docked drawer, never hides behind it.
    check(
        "fixed-width content clears the docked sidebar (never tucked under it)",
        clearance.clears,
        `editorLeft=${clearance.editorLeft} panelRight=${clearance.panelRight}`,
    );
    // Restore the default drawer width for any later assertions.
    await page.evaluate(() => document.documentElement.style.removeProperty("--toc-width"));

    // ── With room to spare, the content centers in the space BESIDE the
    //    drawer, not the whole viewport (maintainer decision 2026-07-28,
    //    replacing the old "viewport-centered until collision" nudge): the
    //    drawer owns its strip, so the content's center tracks the midpoint
    //    of [drawer edge, pane edge] and therefore DOES drift as the drawer
    //    widens. We shrink the content so centering clears even a wide
    //    drawer, then check the center against the leftover midpoint at two
    //    drawer widths. ──
    const centered = await page.evaluate(() => {
        const html = document.documentElement;
        const editor = document.querySelector("#editor");
        const panel = document.querySelector(".toc-panel");
        const measure = (tocWidth) => {
            html.style.setProperty("--editor-max-width", "360px");
            html.style.setProperty("--toc-width", `${tocWidth}px`);
            const e = editor.getBoundingClientRect();
            const p = panel.getBoundingClientRect();
            const leftoverMid = (tocWidth + html.clientWidth) / 2;
            return {
                left: Math.round(e.left),
                panelRight: Math.round(p.right),
                centerDelta: Math.abs((e.left + e.right) / 2 - leftoverMid),
            };
        };
        const narrow = measure(150);
        const wide = measure(250);
        html.style.removeProperty("--editor-max-width");
        html.style.removeProperty("--toc-width");
        return {
            narrow,
            wide,
            clearsBoth: narrow.left >= narrow.panelRight && wide.left >= wide.panelRight,
            centeredBoth: narrow.centerDelta <= 1.5 && wide.centerDelta <= 1.5,
        };
    });
    check(
        "content clears the drawer in both narrow/wide-drawer cases (centered regime)",
        centered.clearsBoth,
        JSON.stringify(centered),
    );
    check(
        "content centers in the leftover space beside the drawer (center tracks drawer width)",
        centered.centeredBoth,
        `narrowΔ=${centered.narrow.centerDelta.toFixed(1)} wideΔ=${centered.wide.centerDelta.toFixed(1)}`,
    );

    // ── Click Full Width ──
    await fullBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(100);
    check("Full Width sets --editor-max-width to none", (await maxWidth()) === "none", await maxWidth());
    check("Full Width restores the full-width body class", (await hasAutoClass()) === true);
    check(
        "Full Width posts setContentWidth mode=full",
        (await lastWidthMsg())?.mode === "full",
        JSON.stringify(await lastWidthMsg()),
    );

    // ── Width flips keep the top visible line stable (scrollAnchor.ts) ──
    // Scroll a known short paragraph to the top of the viewport, flip the
    // width mode both ways, and assert that paragraph's top stays put. A
    // flip rewraps all 40 paragraphs above it, so without anchoring the
    // target drifts by hundreds of pixels.
    await page.setViewportSize({ width: 1000, height: 400 });
    await page.waitForTimeout(150);
    const targetTop = () =>
        page.evaluate(() => {
            const target = [...document.querySelectorAll(".ProseMirror p")]
                .find((p) => p.textContent.startsWith("para 30"));
            return target ? target.getBoundingClientRect().top : null;
        });
    await page.evaluate(() => {
        const target = [...document.querySelectorAll(".ProseMirror p")]
            .find((p) => p.textContent.startsWith("para 30"));
        const topbar = document.querySelector(".editor-topbar").getBoundingClientRect().height;
        window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - topbar - 4 });
    });
    await page.waitForTimeout(100);
    const anchorBefore = await targetTop();

    await fontWrap.dispatchEvent("mouseenter");
    await page.waitForTimeout(150);
    await fixedBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(200);
    const afterFixed = await targetTop();
    check(
        "flipping Full→Fixed keeps the top visible line at the top",
        afterFixed !== null && Math.abs(afterFixed - anchorBefore) <= 6,
        `before=${anchorBefore?.toFixed(0)} afterFixed=${afterFixed?.toFixed(0)}`,
    );

    await fullBtn.dispatchEvent("mousedown");
    await page.waitForTimeout(200);
    const afterFull = await targetTop();
    check(
        "flipping Fixed→Full keeps it there too",
        afterFull !== null && Math.abs(afterFull - anchorBefore) <= 6,
        `before=${anchorBefore?.toFixed(0)} afterFull=${afterFull?.toFixed(0)}`,
    );
}
