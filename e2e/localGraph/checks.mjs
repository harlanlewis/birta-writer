/**
 * The Backlinks and Graph tabs against the REAL bundle (MAR-479, MAR-481):
 * what jsdom cannot measure, because it has no layout. The folder index is
 * the harness page's own, answered to the page's `requestFolderIndex`.
 *
 * Covers: the page asks for the index once, and only once the sidebar shows;
 * both tabs appear for a note the index connects; Backlinks lists the notes
 * that name this one; the graph's stage is square and inside the drawer, every
 * node lies inside the stage, and no two first-ring labels overlap at the
 * drawer's own width; a node opens its note and this note opens nothing; Two
 * steps adds the outer ring and every added node still lies inside the stage;
 * the lazy chunk loads without an error on the page.
 */
async function switchTab(page, name) {
    const select = page.locator(".toc-tabs--select .toc-tabs-select");
    if (await select.count()) {
        await select.dispatchEvent("mousedown");
        await page.locator(".toc-tabs-menu__item", { hasText: name }).first().dispatchEvent("mousedown");
    } else {
        await page.locator(".toc-tab", { hasText: name }).first().dispatchEvent("mousedown");
    }
    await page.waitForTimeout(150);
}

/** Every pair of rects that overlaps by more than a pixel either way. */
function overlaps(rects) {
    const out = [];
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w > 1 && h > 1) { out.push([a.text, b.text]); }
        }
    }
    return out;
}

export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); } });

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    await page.waitForTimeout(500);

    // ── The ask ──────────────────────────────────────────────────────────
    const asks = await page.evaluate(() => window.__posted.filter((m) => m.type === "requestFolderIndex").length);
    check("the open sidebar asks the host for the folder index exactly once", asks === 1, `asks=${asks}`);

    const shown = await page.evaluate(() => Object.fromEntries(
        [...document.querySelectorAll(".toc-tab")].map((t) => [t.textContent, !t.hidden])));
    check("the Backlinks and Graph tabs appear for a note the index connects",
        shown["Backlinks"] === true && shown["Graph"] === true, JSON.stringify(shown));

    // ── Backlinks ────────────────────────────────────────────────────────
    await switchTab(page, "Backlinks");
    const backlinks = await page.$$eval(".review-list--backlinks .review-item__label", (els) => els.map((e) => e.textContent));
    check("Backlinks lists the six notes that name this one",
        backlinks.length === 6 && backlinks.includes("Quarterly planning review") && !backlinks.includes("Weekly active users"),
        JSON.stringify(backlinks));

    // ── The graph's geometry, at the drawer's own width ──────────────────
    await switchTab(page, "Graph");
    await page.waitForSelector(".review-list--graph .lg-node", { timeout: 5000 });
    const geo = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
        const panel = r(document.querySelector(".toc-panel"));
        const stage = r(document.querySelector(".lg-stage"));
        const nodes = [...document.querySelectorAll(".lg-node")].map((n) => ({
            id: n.dataset.id,
            ring1: !n.classList.contains("lg-node--self") && !!n.querySelector(".lg-label"),
            dot: r(n.querySelector(".lg-dot")),
            label: n.querySelector(".lg-label") ? { ...r(n.querySelector(".lg-label")), text: n.querySelector(".lg-label").textContent } : null,
            named: !!n.getAttribute("aria-label"),
        }));
        // Where each line ends, in page pixels, against the dots it joins.
        const svg = document.querySelector(".lg-lines").getBoundingClientRect();
        const dotOf = (id) => r(document.querySelector(`.lg-node[data-id="${CSS.escape(id)}"] .lg-dot`));
        const misses = [...document.querySelectorAll(".lg-line")].flatMap((l) => {
            const px = (v, axis) => (axis === "x" ? svg.left + (v / 100) * svg.width : svg.top + (v / 100) * svg.height);
            const ends = [[l.dataset.from, +l.getAttribute("x1"), +l.getAttribute("y1")], [l.dataset.to, +l.getAttribute("x2"), +l.getAttribute("y2")]];
            return ends.filter(([id, x, y]) => {
                const d = dotOf(id);
                return Math.abs(px(x, "x") - (d.left + d.right) / 2) > 1.5 || Math.abs(px(y, "y") - (d.top + d.bottom) / 2) > 1.5;
            }).map(([id]) => id);
        });
        return { panel, stage, nodes, misses, lines: document.querySelectorAll(".lg-line").length };
    });
    check("the stage is square", Math.abs(geo.stage.width - geo.stage.height) < 2 && geo.stage.width > 120,
        JSON.stringify(geo.stage));
    check("the stage fits inside the drawer", geo.stage.left >= geo.panel.left - 1 && geo.stage.right <= geo.panel.right + 1,
        JSON.stringify({ stage: geo.stage, panel: geo.panel }));
    // This note, twelve neighbours and one dangling reference.
    check("the first ring draws this note, its twelve neighbours and the dangling reference",
        geo.nodes.length === 14 && geo.lines === 13, `nodes=${geo.nodes.length} lines=${geo.lines}`);
    const outside = geo.nodes.filter((n) => n.dot.left < geo.stage.left - 1 || n.dot.right > geo.stage.right + 1
        || n.dot.top < geo.stage.top - 1 || n.dot.bottom > geo.stage.bottom + 1).map((n) => n.id);
    check("every node's dot lies inside the stage", outside.length === 0, JSON.stringify(outside));
    check("every line ends at the centre of the dots it joins", geo.misses.length === 0, JSON.stringify(geo.misses));
    const drawnLabels = geo.nodes.filter((n) => n.label && n.label.width > 0);
    const labelClash = overlaps(drawnLabels.map((n) => n.label));
    check("no two drawn labels overlap at the drawer's width", labelClash.length === 0, JSON.stringify(labelClash));
    const ring1Labelled = geo.nodes.filter((n) => n.ring1);
    check("at least half the first ring keeps its label on the drawing",
        drawnLabels.length - 1 >= Math.ceil(ring1Labelled.length / 2), `${drawnLabels.length - 1} of ${ring1Labelled.length}`);
    check("a node whose label was crowded out is still named", geo.nodes.every((n) => n.named), "");
    const labelOut = drawnLabels.filter((n) => (n.label.left < geo.panel.left - 1 || n.label.right > geo.panel.right + 1))
        .map((n) => n.label.text);
    check("no label runs out of the drawer", labelOut.length === 0, JSON.stringify(labelOut));

    // ── Opening ──────────────────────────────────────────────────────────
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.locator('.lg-node[data-id="notes/self.md"]').click();
    await page.locator('.lg-node[data-id="people/alex.md"]').click();
    await page.locator('.lg-node[data-id^="dangling:"]').click({ force: true });
    const opened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openFile").map((m) => m.path));
    check("a neighbour opens relative to this note, and this note and a dangling reference open nothing",
        JSON.stringify(opened) === JSON.stringify(["../people/alex.md"]), JSON.stringify(opened));

    // ── Two steps ────────────────────────────────────────────────────────
    await page.locator('.review-list--graph .review-seg[data-depth="2"]').dispatchEvent("mousedown");
    await page.waitForTimeout(100);
    const far = await page.evaluate(() => {
        const stage = document.querySelector(".lg-stage").getBoundingClientRect();
        const nodes = [...document.querySelectorAll(".lg-node")];
        return {
            count: nodes.length,
            ids: nodes.map((n) => n.dataset.id),
            outside: nodes.filter((n) => {
                const d = n.querySelector(".lg-dot").getBoundingClientRect();
                return d.left < stage.left - 1 || d.right > stage.right + 1 || d.top < stage.top - 1 || d.bottom > stage.bottom + 1;
            }).map((n) => n.dataset.id),
        };
    });
    check("Two steps adds the four notes two references away", far.count === 18 && far.ids.includes("people/sam.md"),
        JSON.stringify({ count: far.count }));
    check("and every node of the outer ring still lies inside the stage", far.outside.length === 0, JSON.stringify(far.outside));

    check("no page errors while building and drawing the graph", errors.length === 0, JSON.stringify(errors));
}
