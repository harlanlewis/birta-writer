/**
 * The sticky heading's ancestor trail (MAR-31), against the production bundle:
 * what jsdom cannot see. Scrolling into a nested section stacks the section's
 * ancestors above the stuck title in chrome type; the gutter's badge stays
 * level with the title row rather than the trail; a crumb click scrolls its
 * heading under the topbar; on a narrow pane the crumbs ellipsise on one
 * line rather than wrapping or overflowing; a top-level section has no
 * trail; and the trail steps aside while the docked outline is open.
 */
export async function run({ page, check, baseUrl }) {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(400);

    const stickyState = () => page.$eval(".heading-sticky-title", (el) => {
        const trail = el.querySelector(".heading-sticky-trail");
        const crumbs = Array.from(el.querySelectorAll(".heading-sticky-crumb"));
        const title = el.querySelector(".heading-sticky-text");
        const marker = el.querySelector(".heading-sticky-marker");
        const rect = (n) => { const r = n?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } : null; };
        return {
            hidden: el.hidden,
            title: title?.textContent ?? null,
            trailVisible: !!trail && getComputedStyle(trail).display !== "none",
            crumbs: crumbs.map((c) => c.textContent),
            crumbRects: crumbs.map((c) => rect(c)),
            trailRect: rect(trail),
            titleRect: rect(title),
            markerRect: rect(marker),
            stickyRect: rect(el),
        };
    });
    const scrollToHeading = async (text) => {
        await page.evaluate((t) => {
            const h = Array.from(document.querySelectorAll(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3"))
                .find((el) => el.textContent.includes(t));
            const y = h.getBoundingClientRect().top + window.scrollY;
            window.scrollTo(0, y + 260);
        }, text);
        await page.waitForTimeout(250);
    };

    // ── 1. Inside the H3 section: two crumbs above the title, chrome type ──
    await scrollToHeading("Current subsection");
    let s = await stickyState();
    check("the sticky shows the current subsection", !s.hidden && s.title === "Current subsection", JSON.stringify(s));
    check("the trail lists the ancestors root first",
        JSON.stringify(s.crumbs) === JSON.stringify([
            "Root chapter with a fairly long title that will need to ellipsise on a narrow pane",
            "Parent section",
        ]), JSON.stringify(s.crumbs));
    check("the trail sits above the title", s.trailVisible && s.trailRect.bottom <= s.titleRect.top + 1, JSON.stringify({ trail: s.trailRect, title: s.titleRect }));
    check("the trail is smaller than the title", s.trailRect.height < s.titleRect.height, JSON.stringify({ trail: s.trailRect.height, title: s.titleRect.height }));
    const markerMid = (s.markerRect.top + s.markerRect.bottom) / 2;
    check("the badge stays level with the title row, not the trail",
        markerMid > s.titleRect.top - 2 && markerMid < s.titleRect.bottom + 2,
        JSON.stringify({ markerMid, title: s.titleRect }));
    // The bar's backdrop covers the gutter column beside the TRAIL row too:
    // a point in that column, level with the trail, hits the bar (its
    // pseudo-element backdrop reports the bar), not a document element
    // scrolling under it.
    const underTrail = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? (el.closest(".heading-sticky-title") ? "sticky" : el.className || el.tagName) : "none";
    }, { x: s.stickyRect.left - 40, y: s.trailRect.top + 2 });
    check("the gutter column beside the trail is masked by the bar", underTrail === "sticky", underTrail);
    check("the sticky reserves its full painted height",
        Math.abs(parseFloat(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-sticky-heading-height"))) - s.stickyRect.height) < 2,
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-sticky-heading-height")));

    // ── 2. A crumb click scrolls its heading under the topbar ──
    await page.evaluate(() => {
        Array.from(document.querySelectorAll(".heading-sticky-crumb"))
            .find((c) => c.textContent === "Parent section").click();
    });
    await page.waitForTimeout(300);
    const parentTop = await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll(".ProseMirror h2")).find((el) => el.textContent.includes("Parent section"));
        const topbar = document.querySelector(".editor-topbar").getBoundingClientRect().bottom;
        return { top: h.getBoundingClientRect().top, topbar };
    });
    check("clicking a crumb scrolls that heading just below the topbar",
        parentTop.top >= parentTop.topbar - 1 && parentTop.top < parentTop.topbar + 60, JSON.stringify(parentTop));
    check("the caret landed in the clicked heading",
        await page.evaluate(() => {
            const sel = getSelection();
            const h = Array.from(document.querySelectorAll(".ProseMirror h2")).find((el) => el.textContent.includes("Parent section"));
            return !!sel.anchorNode && h.contains(sel.anchorNode);
        }));

    // ── 3. A top-level section has no trail; the bar is one row ──
    await scrollToHeading("Second chapter");
    s = await stickyState();
    check("a top-level section shows no trail", s.title === "Second chapter" && s.crumbs.length === 0 && s.trailRect === null, JSON.stringify(s));

    // ── 4. Narrow pane: crumbs ellipsise on one line ──
    await page.setViewportSize({ width: 420, height: 600 });
    await scrollToHeading("Current subsection");
    s = await stickyState();
    check("narrow pane: the trail is still one line",
        s.trailVisible && s.crumbRects.every((r) => Math.abs(r.top - s.crumbRects[0].top) < 2), JSON.stringify(s.crumbRects));
    check("narrow pane: the crumbs stay inside the bar",
        s.crumbRects.every((r) => r.right <= s.stickyRect.right + 1 && r.left >= s.stickyRect.left - 1), JSON.stringify({ crumbs: s.crumbRects, sticky: s.stickyRect }));
    const ellipsised = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".heading-sticky-crumb")).some((c) => c.scrollWidth > c.clientWidth + 1));
    check("narrow pane: at least one crumb is clipped with an ellipsis rather than wrapping", ellipsised);
    await page.setViewportSize({ width: 1000, height: 600 });

    // ── 5. The docked outline open: the trail steps aside ──
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "toggleToc" }, "*"));
    await page.waitForTimeout(400);
    await scrollToHeading("Current subsection");
    s = await stickyState();
    const tocOpen = await page.evaluate(() => document.body.classList.contains("toc-open"));
    check("the docked outline opened", tocOpen);
    check("with the docked outline open the trail is hidden and the title stays",
        tocOpen && !s.trailVisible && s.title === "Current subsection", JSON.stringify(s));

    // ── 6. The OVERLAID outline: the bar is clipped at the panel's edge ──
    // The bar spans the heading's own box, which in overlay mode runs under the
    // panel; the panel is opaque and covers the document there, and it cannot
    // be layered over the bar (it sits below the document popups, and the bar
    // above the drag veil), so the bar is clipped instead. Left with only its
    // z-index the bar painted over the tab strip, blanking it (a stuck heading
    // is the normal state of a scrolled document, so this was the panel's
    // resting look rather than an edge case).
    // Each probe point is chosen from which side the panel is on, so that every
    // assertion below has exactly one right answer: a point that lands under
    // the panel whichever way the clip went would agree with a bar that was
    // never clipped at all.
    const overlayState = () => page.evaluate(() => {
        const box = (n) => { const b = n?.getBoundingClientRect(); return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null; };
        const barBox = box(document.querySelector(".heading-sticky-title"));
        const tabsBox = box(document.querySelector(".toc-tabs"));
        const panelBox = box(document.querySelector(".toc-panel"));
        const at = (x, y) => {
            const el = document.elementFromPoint(x, y);
            return el ? (el.closest(".heading-sticky-title") ? "bar" : el.closest(".toc-panel") ? "panel" : "other") : "none";
        };
        const panelLeads = panelBox.left + panelBox.right < barBox.left + barBox.right;
        return {
            mode: document.body.className,
            barBox, tabsBox, panelBox, panelLeads,
            // The strip the panel puts at its own top: the row the unclipped
            // bar blanked.
            overTabs: at((tabsBox.left + tabsBox.right) / 2, (tabsBox.top + tabsBox.bottom) / 2),
            // Well clear of the panel on the bar's own side, so only the bar
            // can answer.
            overBar: at(panelLeads ? barBox.right - 20 : barBox.left + 20, barBox.top + 8),
            // The gutter backdrop is painted OUTSIDE the bar's box, to its left
            // and half an em past each end, and the clip must not cut it off.
            // Only askable with the panel on the far side.
            overGutter: panelLeads ? null : at(barBox.left - 40, barBox.top + 4),
            // Below the bar's own box, in the band the backdrop reaches into:
            // the clip's block ends have to carry that outset, and a clip
            // squared off at the box would leave document text showing here.
            underGutter: panelLeads ? null : at(barBox.left - 40, barBox.bottom + 4),
        };
    });

    await page.setViewportSize({ width: 900, height: 640 });
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => document.body.classList.contains("toc-overlay-open")))) {
        await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "toggleToc" }, "*"));
        await page.waitForTimeout(500);
    }
    await scrollToHeading("Current subsection");
    let o = await overlayState();
    check("the outline overlays at this width", o.mode.includes("toc-overlay-open"), o.mode);
    check("left-docked overlay: the bar is clipped off the panel's tab strip",
        o.panelLeads && o.overTabs === "panel", JSON.stringify(o));
    check("left-docked overlay: the bar keeps the column beside the panel",
        o.overBar === "bar", JSON.stringify(o));

    // Right-docked: the clip has to find the other edge, and the bar's gutter
    // is out from under the panel where it can be asked about.
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "swapTocSide" }, "*"));
    await page.waitForTimeout(500);
    await scrollToHeading("Current subsection");
    o = await overlayState();
    check("right-docked overlay: the bar is clipped off the panel's tab strip",
        !o.panelLeads && o.overTabs === "panel", JSON.stringify(o));
    check("right-docked overlay: the bar keeps its own side and its gutter backdrop",
        o.overBar === "bar" && o.overGutter === "bar", JSON.stringify(o));
    check("right-docked overlay: the clip keeps the backdrop's outset past the bar's own box",
        o.underGutter === "bar", JSON.stringify(o));

    // Closing it releases the clip: the bar spans the heading again.
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "toggleToc" }, "*"));
    await page.waitForTimeout(600);
    await scrollToHeading("Current subsection");
    const released = await page.evaluate(() => {
        const bar = document.querySelector(".heading-sticky-title");
        const b = bar.getBoundingClientRect();
        const el = document.elementFromPoint(b.right - 4, b.top + 8);
        return { clip: bar.style.clipPath, atRightEdge: el?.closest(".heading-sticky-title") ? "bar" : "other" };
    });
    check("closing the outline releases the clip", released.clip === "" && released.atRightEdge === "bar",
        JSON.stringify(released));
}
