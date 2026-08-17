/**
 * Sticky heading badge — real-browser truths (fixed-position mirroring,
 * computed opacity, live menu wiring):
 *   - scrolling past a heading shows the sticky mirror with its title,
 *   - the H-badge is a real <button> block handle (not a display-only span)
 *     and clicking it opens the block menu, marking the badge menu-open,
 *   - in "Hover only" mode (body.handles-rest-hover) the sticky LEVEL BADGE
 *     rests at opacity 0 and reveals while the sticky title is hovered —
 *     except when the stuck heading is collapsed (data-collapsed carve-out),
 *   - the fold chevron rests hidden like its in-flow twin, follows
 *     `editor.showFoldingControls` through all three modes, and is governed
 *     by that setting ALONE — the two controls share a gutter, never a rule,
 *   - the chevron is reachable and folds the section it names.
 */
/**
 * The level badge's resting contrast, held in exact parity with the in-flow
 * `.heading-fold-marker` (see .heading-sticky-marker in style.css). Revealing
 * a hidden badge restores THIS, not full contrast — full contrast is reserved
 * for the badge's own hover and menu-open states, so a check that expects 1
 * from a reveal is measuring the wrong thing.
 */
const BADGE_REST_OPACITY = 0.7;

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(400);

    // ── 1. Scrolling past "Section One" reveals its sticky mirror ──
    check("sticky hidden at the top of the document",
        await page.$eval(".heading-sticky-title", (el) => el.hidden));
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(250);
    const sticky = await page.$eval(".heading-sticky-title", (el) => ({
        hidden: el.hidden,
        text: el.querySelector(".heading-sticky-text")?.textContent,
    }));
    check("scrolling past the heading shows the sticky with its title",
        !sticky.hidden && sticky.text === "Section One", JSON.stringify(sticky));

    // ── 2. The badge is a real button that opens the block menu ──
    const badge = await page.$eval(".heading-sticky-marker", (el) => ({
        tag: el.tagName,
        type: el.getAttribute("type"),
        label: el.textContent,
        haspopup: el.getAttribute("aria-haspopup"),
        expanded: el.getAttribute("aria-expanded"),
    }));
    check("sticky badge is a <button type=button> with menu semantics",
        badge.tag === "BUTTON" && badge.type === "button" &&
            badge.haspopup === "menu" && badge.expanded === "false",
        JSON.stringify(badge));
    check("badge carries the heading level (H1)", badge.label === "H1", `label=${badge.label}`);

    // The mirror's badge and chevron are sized against the CONTENT em like
    // the in-flow gutter's (MAR-93); the sticky mounts on <body>, outside
    // #editor, so it has to opt into that em itself. Parity is checked at
    // 200% content scale, where a mirror still reading the em's initial value
    // would sit at half the in-flow size.
    const scaledParity = await page.evaluate(() => {
        document.documentElement.style.setProperty("--content-font-scale", "2");
        const font = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null);
        const width = (el) => (el ? el.getBoundingClientRect().width : null);
        const inFlow = document.querySelector(".ProseMirror > .heading-fold-heading .heading-fold-marker");
        const inFlowToggle = document.querySelector(".ProseMirror > .heading-fold-heading .heading-fold-toggle");
        const mirror = document.querySelector(".heading-sticky-marker");
        const mirrorToggle = document.querySelector(".heading-sticky-toggle");
        const out = {
            badge: font(inFlow), mirrorBadge: font(mirror),
            toggle: width(inFlowToggle), mirrorToggle: width(mirrorToggle),
        };
        document.documentElement.style.removeProperty("--content-font-scale");
        return out;
    });
    check("at 200% the sticky badge and chevron match the in-flow gutter's size",
        scaledParity.badge !== null && scaledParity.badge > 20 &&
            Math.abs(scaledParity.badge - scaledParity.mirrorBadge) < 0.6 &&
            Math.abs(scaledParity.toggle - scaledParity.mirrorToggle) < 0.6,
        JSON.stringify(scaledParity));

    const markerBox = await page.$eval(".heading-sticky-marker", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(markerBox.x, markerBox.y);
    await page.waitForTimeout(150);
    const menuState = await page.evaluate(() => ({
        menu: !!document.querySelector(".block-menu"),
        menuOpenClass: document.querySelector(".heading-sticky-marker")
            ?.classList.contains("heading-fold-marker--menu-open") ?? false,
    }));
    check("clicking the badge opens the block menu", menuState.menu, JSON.stringify(menuState));
    check("open menu marks the badge (heading-fold-marker--menu-open)",
        menuState.menuOpenClass, JSON.stringify(menuState));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const closed = await page.evaluate(() => ({
        menu: !!document.querySelector(".block-menu"),
        menuOpenClass: document.querySelector(".heading-sticky-marker")
            ?.classList.contains("heading-fold-marker--menu-open") ?? false,
    }));
    check("Escape closes the menu and clears the badge's menu-open state",
        !closed.menu && !closed.menuOpenClass, JSON.stringify(closed));

    // ── 3. "Hover only" mode: the badge rests hidden, reveals on sticky hover ──
    // The toolbarMenu suite covers the real toggle path; here the body class
    // is applied directly, exactly what the toolbar pick does.
    await page.evaluate(() => document.body.classList.add("handles-rest-hover"));
    await page.mouse.move(500, 800); // pointer well away from the sticky
    await page.waitForTimeout(300); // opacity transition is 120ms
    const restOpacity = await page.$eval(".heading-sticky-marker", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: the sticky level badge rests at opacity 0", restOpacity === 0,
        `opacity=${restOpacity}`);
    const textBox = await page.$eval(".heading-sticky-text", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
    });
    await page.mouse.move(textBox.x, textBox.y);
    await page.waitForTimeout(300);
    const hoverOpacity = await page.$eval(".heading-sticky-marker", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: hovering the sticky title reveals the badge",
        hoverOpacity === BADGE_REST_OPACITY, `opacity=${hoverOpacity}`);
    // The badge stays clickable through the reveal (the full loop).
    const markerBox2 = await page.$eval(".heading-sticky-marker", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(markerBox2.x, markerBox2.y);
    await page.waitForTimeout(150);
    await page.mouse.click(markerBox2.x, markerBox2.y);
    await page.waitForTimeout(150);
    check("hover-only mode: the revealed badge still opens the menu",
        (await page.$(".block-menu")) !== null);
    // While the menu is open the badge must not fade, even unhovered. Full
    // contrast here, not BADGE_REST_OPACITY: menu-open is one of the two
    // states that take the badge past its resting value.
    await page.mouse.move(500, 800);
    await page.waitForTimeout(300);
    const menuOpenOpacity = await page.$eval(".heading-sticky-marker", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: the badge never fades while its menu is open",
        menuOpenOpacity > 0.9, `opacity=${menuOpenOpacity}`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.body.classList.remove("handles-rest-hover"));

    // ── 4. Scrolling into Section Two swaps the sticky's content ──
    // Scroll the heading 20px ABOVE the viewport top explicitly —
    // scrollIntoView can land it a hair below the sticky threshold (topbar
    // bottom minus the heading-padding offset), which is not the scenario
    // under test.
    await page.evaluate(() => {
        const h = [...document.querySelectorAll(".ProseMirror h1")]
            .find((el) => el.textContent.includes("Section Two"));
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY + 20);
    });
    await page.waitForTimeout(250);
    const swapped = await page.$eval(".heading-sticky-title", (el) => ({
        hidden: el.hidden,
        text: el.querySelector(".heading-sticky-text")?.textContent,
    }));
    check("scrolling into the next section swaps the sticky title",
        !swapped.hidden && swapped.text === "Section Two", JSON.stringify(swapped));

    // ── 5. Hover-only mode spares a COLLAPSED stuck heading's badge ──
    // A collapsed section must keep its badge visible (the in-flow parity
    // rule). Holding a REAL collapsed heading stuck is not stable in this
    // two-section fixture — collapsing a section puts the next heading
    // immediately below it, so the sticky is pushed out almost instantly —
    // so stamp the dataset the plugin writes (updateSticky sets
    // data-collapsed from the fold state on every refresh) and assert the
    // CSS carve-out directly.
    // The class flip first: the plugin's body-class observer re-runs
    // updateSticky (which re-stamps data-collapsed from the fold state), so
    // stamping in the same breath would be overwritten a frame later.
    await page.evaluate(() => document.body.classList.add("handles-rest-hover"));
    await page.mouse.move(500, 800); // pointer well away from the sticky
    await page.waitForTimeout(200); // let the observer-driven refresh settle
    await page.evaluate(() => {
        document.querySelector(".heading-sticky-title").dataset.collapsed = "true";
    });
    await page.waitForTimeout(300);
    const collapsedRest = await page.$eval(".heading-sticky-marker", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: a collapsed sticky keeps its badge visible at rest",
        collapsedRest === BADGE_REST_OPACITY, `opacity=${collapsedRest}`);
    // Restore the expanded stamp: the hide rule applies again.
    await page.evaluate(() => {
        document.querySelector(".heading-sticky-title").dataset.collapsed = "false";
    });
    await page.waitForTimeout(300);
    const expandedRest = await page.$eval(".heading-sticky-marker", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("hover-only mode: the expanded sticky hides its badge at rest again",
        expandedRest === 0, `opacity=${expandedRest}`);
    await page.evaluate(() => document.body.classList.remove("handles-rest-hover"));

    // ── 6. A truncated title reveals its full text on hover (truncatedOnly) ──
    // The clip hides the tail behind an ellipsis; parity with the TOC, the
    // sticky recovers it with a hover tooltip that appears ONLY when the text
    // is actually truncated — never duplicating a title that already fits.
    // Drive the real applyTooltip binding synchronously (mouseenter dispatch):
    // updateSticky re-stamps the sticky width on the next rAF, so a
    // measure-then-hover across an await would race it — one synchronous pass
    // (squeeze → measure → dispatch → read) is deterministic and still
    // exercises the actual truncatedOnly gate and the captured heading text.
    const tt = await page.evaluate(() => {
        const title = document.querySelector(".heading-sticky-title");
        const label = document.querySelector(".heading-sticky-text");
        const reset = () => {
            const tip = document.querySelector(".custom-tooltip");
            if (tip) tip.style.display = "none";
            label.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        };
        const read = () => {
            const tip = document.querySelector(".custom-tooltip");
            return { display: tip ? tip.style.display : "none", text: tip?.textContent ?? null };
        };
        // Untruncated (the real ~full-column width): hover surfaces nothing.
        reset();
        label.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        const fit = read();
        // Squeeze the sticky (text unchanged) until "Section Two" clips: now
        // the same hover surfaces the tooltip carrying the full heading text.
        reset();
        title.style.width = "48px";
        const offsetWidth = label.offsetWidth, scrollWidth = label.scrollWidth;
        label.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        const clipped = read();
        reset();
        title.style.width = "";
        return { fit, clipped, offsetWidth, scrollWidth };
    });
    check("the title is actually clipped once squeezed (scrollWidth > offsetWidth)",
        tt.scrollWidth > tt.offsetWidth, JSON.stringify(tt));
    check("untruncated title shows no tooltip on hover",
        tt.fit.display === "none", JSON.stringify(tt.fit));
    check("truncated title reveals its full text on hover",
        tt.clipped.display === "block" && tt.clipped.text === "Section Two", JSON.stringify(tt.clipped));

    // ── 7. The sticky's tooltip is never occluded by the topbar ──
    // The sticky sits flush under the fixed topbar, and the topbar (z 10002)
    // covers the tooltip (z 10000) — an "above" placement would render the
    // tip half-hidden behind the bar, so position() must drop it below the
    // label instead (the topbar's bottom edge is the placement ceiling).
    const tipPos = await page.evaluate(() => {
        const title = document.querySelector(".heading-sticky-title");
        const label = document.querySelector(".heading-sticky-text");
        title.style.width = "48px"; // force truncation so the tooltip shows
        label.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        const tip = document.querySelector(".custom-tooltip").getBoundingClientRect();
        const topbarBottom = document.querySelector(".editor-topbar").getBoundingClientRect().bottom;
        const labelBottom = label.getBoundingClientRect().bottom;
        label.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        title.style.width = "";
        return {
            tipTop: Math.round(tip.top),
            topbarBottom: Math.round(topbarBottom),
            labelBottom: Math.round(labelBottom),
        };
    });
    check("the sticky tooltip drops below the label, clear of the topbar",
        tipPos.tipTop >= tipPos.topbarBottom && tipPos.tipTop >= tipPos.labelBottom,
        JSON.stringify(tipPos));

    // ── 8. Clicking the sticky title jumps to the heading and places the caret ──
    // The sticky mirrors the heading's left/width/typography, so a click x maps
    // 1:1 onto the heading's first line: the heading scrolls fully below the
    // topbar (un-sticking the mirror) and the caret lands at the clicked
    // character. Click 1px into "T" of "Section Two" (text offset 8), measured
    // on the label's own text node.
    const clickProbe = await page.evaluate(() => {
        const label = document.querySelector(".heading-sticky-text");
        const range = document.createRange();
        range.setStart(label.firstChild, 8);
        range.setEnd(label.firstChild, 9);
        const r = range.getBoundingClientRect();
        const lr = label.getBoundingClientRect();
        return { x: r.left + 1, y: lr.top + lr.height / 2 };
    });
    await page.mouse.click(clickProbe.x, clickProbe.y);
    await page.waitForTimeout(250);
    const afterClick = await page.evaluate(() => {
        const topbarBottom = document.querySelector(".editor-topbar").getBoundingClientRect().bottom;
        const h = [...document.querySelectorAll(".ProseMirror h1")]
            .find((el) => el.textContent.includes("Section Two"));
        const sel = document.getSelection();
        return {
            headingTop: Math.round(h.getBoundingClientRect().top),
            topbarBottom: Math.round(topbarBottom),
            stickyHidden: document.querySelector(".heading-sticky-title").hidden,
            stickyText: document.querySelector(".heading-sticky-text")?.textContent ?? null,
            anchorText: sel?.anchorNode?.textContent ?? null,
            anchorOffset: sel?.anchorOffset ?? null,
            inHeading: Boolean(sel?.anchorNode && h.contains(sel.anchorNode)),
        };
    });
    check("clicking the sticky title scrolls the heading fully below the topbar",
        afterClick.headingTop >= afterClick.topbarBottom &&
            afterClick.headingTop <= afterClick.topbarBottom + 24,
        JSON.stringify(afterClick));
    // The clicked heading is fully visible, so ITS mirror is gone — the sticky
    // either hides or hands over to the previous section (push-away).
    check("the jump un-sticks the clicked heading's mirror",
        afterClick.stickyHidden || afterClick.stickyText !== "Section Two",
        JSON.stringify(afterClick));
    check("the caret lands in the heading at the clicked character",
        afterClick.inHeading && afterClick.anchorOffset === 8, JSON.stringify(afterClick));

    // Re-stick "Section Two" — the next section measures the sticky's rendered
    // geometry, which needs it visible again after the jump above hid it.
    await page.evaluate(() => {
        const h = [...document.querySelectorAll(".ProseMirror h1")]
            .find((el) => el.textContent.includes("Section Two"));
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY + 20);
    });
    await page.waitForTimeout(250);

    // ── 9. A long title clips to one ellipsised line instead of overflowing ──
    // In a narrow content area a heading longer than the sticky must stay on a
    // single line and truncate with an ellipsis, never spill past the width the
    // plugin sets. The text span is block-level for overflow/text-overflow to
    // apply; assert both the computed contract and the runtime truth (rendered
    // width bounded, content overflowing → clipped, height stays one line).
    const longTitle = await page.evaluate(() => {
        const sticky = document.querySelector(".heading-sticky-title");
        const text = sticky.querySelector(".heading-sticky-text");
        // Pin a narrow sticky and a very long title, mirroring a narrow content
        // area next to a sidebar. (updateSticky would re-stamp width on scroll;
        // we measure statically without scrolling.)
        sticky.style.width = "200px";
        text.textContent = "A very long heading title that comfortably exceeds the sticky width " +
            "and would otherwise overflow the narrow content area next to the sidebar";
        const style = getComputedStyle(text);
        return {
            display: style.display,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            clientWidth: text.clientWidth,
            scrollWidth: text.scrollWidth,
            rectWidth: text.getBoundingClientRect().width,
            offsetHeight: text.offsetHeight,
            lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3,
        };
    });
    check("long title: text span is block-level so text-overflow applies",
        longTitle.display === "block", JSON.stringify(longTitle));
    check("long title: computed text-overflow is ellipsis with nowrap",
        longTitle.textOverflow === "ellipsis" && longTitle.whiteSpace === "nowrap",
        JSON.stringify(longTitle));
    check("long title: rendered width stays within the narrow sticky (no overflow)",
        longTitle.rectWidth <= 200, JSON.stringify(longTitle));
    check("long title: content overflows the box and is clipped",
        longTitle.scrollWidth > longTitle.clientWidth, JSON.stringify(longTitle));
    check("long title: text stays on a single line",
        longTitle.offsetHeight <= longTitle.lineHeight + 4, JSON.stringify(longTitle));

    // ── 10. The in-flow gutter centers on the heading's first text line ──
    // The gutter's top cancels the heading's padding-top
    // (--content-heading-before) and its 1.3em box matches the line-height,
    // so the badge/chevron's vertical center must coincide with the first
    // line's center. (A hardcoded 1em top used to seat it 0.3em low — the
    // top-level twin of the nested-heading overshoot fixed in MAR-158.)
    const gutterAlign = await page.evaluate(() => {
        const h = document.querySelector(".ProseMirror h1");
        const gutter = h.querySelector(
            ":scope > .heading-fold-gutter:not(.heading-fold-gutter--block)");
        const style = getComputedStyle(h);
        const firstLineCenter = h.getBoundingClientRect().top +
            parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
        const g = gutter.getBoundingClientRect();
        return {
            gutterCenter: g.top + g.height / 2,
            firstLineCenter,
            delta: Math.abs(g.top + g.height / 2 - firstLineCenter),
        };
    });
    check("the heading gutter centers on the first text line (≤1px drift)",
        gutterAlign.delta <= 1, JSON.stringify(gutterAlign));

    // ── 5. The sticky follows a body-class layout shift that resizes NOTHING ──
    // Since MAR-266 the body-class observer no longer reschedules on every
    // mutation; it compares what the sticky is positioned from. A pure
    // horizontal shift (TOC docking moves the editor column with a margin) is
    // the case the ResizeObserver cannot see, so it is the one worth pinning:
    // with the guard reading only the topbar, the sticky strands at its old
    // left while the column moves out from under it.
    await page.evaluate(() => {
        document.body.classList.remove("handles-rest-hover");
        const st = document.createElement("style");
        st.textContent = ".sticky-shift-probe .ProseMirror { transform: translateX(160px); }";
        document.head.appendChild(st);
    });
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(250);
    await page.evaluate(() => document.body.classList.add("sticky-shift-probe"));
    await page.waitForTimeout(300);
    const shifted = await page.evaluate(() => ({
        stickyLeft: Math.round(parseFloat(
            document.querySelector(".heading-sticky-title").style.left)),
        columnLeft: Math.round(
            document.querySelector(".ProseMirror").getBoundingClientRect().left),
    }));
    check("the sticky tracks a move-without-resize column shift",
        Math.abs(shifted.stickyLeft - shifted.columnLeft) <= 1, JSON.stringify(shifted));
    await page.evaluate(() => document.body.classList.remove("sticky-shift-probe"));

    // ── 11. The fold chevron rests hidden, like the in-flow chevron ──
    // The bar is a mirror: it must not offer a fold control while the heading
    // it mirrors is offering none. Baseline is VS Code's
    // `editor.showFoldingControls: "mouseover"` (no body class), and the
    // reveal is hovering the bar. "Section One" is stuck here and is foldable
    // (its section runs to "Section Two"), so the chevron is rendered.
    await page.waitForTimeout(250); // the shift probe scrolled to 400
    check("the stuck heading offers a fold chevron",
        (await page.$(".heading-sticky-toggle")) !== null);
    await page.mouse.move(500, 800); // pointer well away from the sticky
    await page.waitForTimeout(300); // opacity transition is 120ms
    const chevronRest = await page.$eval(".heading-sticky-toggle", (el) => {
        const s = getComputedStyle(el);
        return { opacity: parseFloat(s.opacity), pointerEvents: s.pointerEvents };
    });
    check("mouseover mode: the sticky chevron rests at opacity 0",
        chevronRest.opacity === 0, JSON.stringify(chevronRest));
    // Not merely invisible: an unrevealed chevron must not swallow a click
    // aimed at what sits under it.
    check("mouseover mode: the resting chevron takes no pointer events",
        chevronRest.pointerEvents === "none", JSON.stringify(chevronRest));

    // The badge, by contrast, is resident in this mode (`blockHandles:
    // "headings"`, the default) — the two controls share a gutter and must
    // not share a rest rule.
    const badgeRest = await page.$eval(".heading-sticky-marker", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("mouseover mode: the H-badge stays resident while the chevron hides",
        badgeRest > 0, `opacity=${badgeRest}`);

    const titleBox = await page.$eval(".heading-sticky-text", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
    });
    await page.mouse.move(titleBox.x, titleBox.y);
    await page.waitForTimeout(300);
    const chevronHover = await page.$eval(".heading-sticky-toggle", (el) => {
        const s = getComputedStyle(el);
        return { opacity: parseFloat(s.opacity), pointerEvents: s.pointerEvents };
    });
    check("mouseover mode: hovering the sticky title reveals the chevron",
        chevronHover.opacity > 0.9 && chevronHover.pointerEvents === "auto",
        JSON.stringify(chevronHover));

    // Collapsed is state, not chrome: a folded section keeps its chevron.
    // Stamped directly, as in section 5 above — holding a really-collapsed
    // heading stuck is not stable in this two-section fixture.
    await page.mouse.move(500, 800);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
        document.querySelector(".heading-sticky-title").dataset.collapsed = "true";
    });
    await page.waitForTimeout(300);
    const chevronCollapsed = await page.$eval(".heading-sticky-toggle", (el) =>
        parseFloat(getComputedStyle(el).opacity));
    check("mouseover mode: a collapsed sticky keeps its chevron at rest",
        chevronCollapsed === 1, `opacity=${chevronCollapsed}`);
    await page.evaluate(() => {
        document.querySelector(".heading-sticky-title").dataset.collapsed = "false";
    });

    // ── 12. The chevron follows `editor.showFoldingControls` in both extremes ──
    // "always" is the mode the new rest rule could silently break: before it,
    // the sticky chevron was unconditionally resident, so the mode was
    // satisfied by accident.
    await page.evaluate(() => document.body.classList.add("fold-controls-always"));
    await page.mouse.move(500, 800);
    await page.waitForTimeout(300);
    const alwaysRest = await page.$eval(".heading-sticky-toggle", (el) => {
        const s = getComputedStyle(el);
        return { opacity: parseFloat(s.opacity), pointerEvents: s.pointerEvents };
    });
    check("always mode: the sticky chevron is resident at rest",
        alwaysRest.opacity === 1 && alwaysRest.pointerEvents === "auto",
        JSON.stringify(alwaysRest));
    await page.evaluate(() => document.body.classList.remove("fold-controls-always"));

    await page.evaluate(() => document.body.classList.add("fold-controls-never"));
    await page.waitForTimeout(150);
    const neverDisplay = await page.$eval(".heading-sticky-toggle", (el) =>
        getComputedStyle(el).display);
    check("never mode: the sticky chevron is not rendered at all",
        neverDisplay === "none", `display=${neverDisplay}`);
    await page.evaluate(() => document.body.classList.remove("fold-controls-never"));

    // ── 13. The two settings govern the two controls independently ──
    // The chevron and the level badge share a gutter, never a rule:
    // `editor.showFoldingControls` owns the chevron, `birta.blockHandles` owns
    // the badge. Crossing them is the case that catches a rule written on the
    // shared parent — dimming the gutter reads as "both hidden" and silently
    // overrides a user's explicit "always". This is exactly how the in-flow
    // pair composes, and the bar claims to mirror it.
    // Read each control's OWN computed opacity, which is only honest because
    // nothing dims the gutter between them: opacity does not inherit, so a
    // child of a dimmed parent reports the opacity it was given, not the one
    // it renders at.
    await page.evaluate(() => {
        document.body.classList.add("fold-controls-always", "handles-rest-hover");
        // Explicit: BOTH rules carve out data-collapsed, so a stale "true"
        // left by section 11 would make the badge check pass for the wrong
        // reason. Reported below so a failure is diagnosable.
        document.querySelector(".heading-sticky-title").dataset.collapsed = "false";
    });
    await page.mouse.move(500, 800);
    await page.waitForTimeout(300);
    const crossed = await page.evaluate(() => ({
        chevron: parseFloat(getComputedStyle(
            document.querySelector(".heading-sticky-toggle")).opacity),
        badge: parseFloat(getComputedStyle(
            document.querySelector(".heading-sticky-marker")).opacity),
        gutter: parseFloat(getComputedStyle(
            document.querySelector(".heading-sticky-gutter")).opacity),
        collapsed: document.querySelector(".heading-sticky-title").dataset.collapsed,
    }));
    check("always + hover-only: the chevron obeys showFoldingControls and stays resident",
        crossed.chevron === 1, JSON.stringify(crossed));
    check("always + hover-only: the badge obeys blockHandles and hides",
        crossed.badge === 0, JSON.stringify(crossed));
    check("neither rule dims the gutter they share",
        crossed.gutter === 1, JSON.stringify(crossed));
    await page.evaluate(() => {
        document.body.classList.remove("fold-controls-always", "handles-rest-hover");
    });

    // ── 14. The chevron is reachable, and folding from the bar scrolls ──
    // Everything above measures opacity, which is not the same as usable. The
    // gutter hangs in the margin OUTSIDE the bar's own box, so a pointer
    // approaching the chevron from the left never enters the element the
    // reveal rule keys on; it works only because the gutter is itself a hit
    // surface. A rest rule that left the chevron pointer-events:none with no
    // hoverable ancestor under the cursor would pass every check above and be
    // dead to the mouse.
    await page.mouse.move(500, 800);
    await page.waitForTimeout(250);
    const geom = await page.evaluate(() => {
        const t = document.querySelector(".heading-sticky-toggle").getBoundingClientRect();
        const bar = document.querySelector(".heading-sticky-title").getBoundingClientRect();
        return { toggleRight: t.right, barLeft: bar.left, x: t.x + t.width / 2, y: t.y + t.height / 2 };
    });
    check("the chevron sits outside the bar's own box (in the margin)",
        geom.toggleRight <= geom.barLeft, JSON.stringify(geom));
    await page.mouse.move(geom.x, geom.y);
    await page.waitForTimeout(300);
    const approached = await page.$eval(".heading-sticky-toggle", (el) => {
        const s = getComputedStyle(el);
        return { opacity: parseFloat(s.opacity), pointerEvents: s.pointerEvents };
    });
    check("approaching the chevron from the margin reveals it and arms it",
        approached.opacity > 0.9 && approached.pointerEvents === "auto",
        JSON.stringify(approached));

    // The full loop: the click folds the section the bar names, and scrolls
    // that heading back into the slot the bar was occupying — which is what
    // keeps a fold from mid-section changing the heading at the top of the
    // screen out from under the reader.
    await page.mouse.click(geom.x, geom.y);
    await page.waitForTimeout(400);
    const folded = await page.evaluate(() => {
        const h = [...document.querySelectorAll(".ProseMirror h1")]
            .find((el) => el.textContent.includes("Section One"));
        const topbarBottom = document.querySelector(".editor-topbar").getBoundingClientRect().bottom;
        return {
            collapsed: h?.classList.contains("heading-fold-heading--collapsed") ?? false,
            headingTop: Math.round(h.getBoundingClientRect().top),
            topbarBottom: Math.round(topbarBottom),
            fillerVisible: [...document.querySelectorAll(".ProseMirror p")]
                .some((p) => p.textContent.includes("one filler 1.") && p.offsetParent !== null),
        };
    });
    check("clicking the sticky chevron folds the section it names",
        folded.collapsed, JSON.stringify(folded));
    check("the folded section's content is gone from the page",
        !folded.fillerVisible, JSON.stringify(folded));
    check("the fold scrolls its heading into the slot the bar was holding",
        folded.headingTop >= folded.topbarBottom &&
            folded.headingTop <= folded.topbarBottom + 24,
        JSON.stringify(folded));
}
