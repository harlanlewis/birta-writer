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
}
