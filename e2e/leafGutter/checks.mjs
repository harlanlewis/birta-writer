/**
 * Leaf-atom gutter markers (MAR-350) — real-browser truths for the hr and the
 * mdx block, whose gutter widget is the block's NEXT SIBLING (a nodeSize-1
 * node has no content position) and is anchored back onto the block by CSS
 * anchor positioning. jsdom has no layout, so everything here is what only
 * Chromium can answer:
 *   - geometry: the marker sits centered on the rule's line, and its right
 *     edge is the same 10px clear of the block's left edge every other
 *     marker keeps (e2e/paragraphGutter is the calibration net),
 *   - hover: invisible at rest, revealed by hovering the rule, full contrast
 *     on the marker itself, and mousing rule → marker keeps it alive,
 *   - the block menu opens from the marker, and Duplicate / Move Down /
 *     Delete act on the rule,
 *   - dragging the marker moves the rule,
 *   - a rule inside a folded section hides with it (the sibling gutter has
 *     to be hidden by its own rule),
 *   - the mdx block gets the same marker, seated on its label line.
 */

const DOC = "Alpha paragraph.\n\n---\n\nBeta paragraph.\n\nGamma paragraph.\n";
const HR_HOST = ".ProseMirror > hr.block-gutter-host--leaf";
const HR_GUTTER = `${HR_HOST} + .heading-fold-gutter--leaf`;
const HR_MARKER = `${HR_GUTTER} .heading-fold-marker`;

/** The serialized doc after updates settle (updates are debounced). */
async function latestDoc(page, matcher, tries = 30) {
    for (let i = 0; i < tries; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last && matcher(last)) return last;
        await page.waitForTimeout(100);
    }
    return null;
}

const settle = (page) =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function open(page, baseUrl, doc, format = "markdown") {
    const q = new URLSearchParams({ doc, format });
    await page.goto(`${baseUrl}/index.html?${q}`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => performance.getEntriesByName("mdw:editor-painted").length > 0,
        { timeout: 20000 },
    );
    await settle(page);
    // Park the pointer away from any block so nothing is hovered.
    await page.mouse.move(900, 850);
    await page.waitForTimeout(100);
}

const rect = (page, sel) => page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
});
const opacity = (page, sel) => page.$eval(sel, (el) => parseFloat(getComputedStyle(el).opacity));

/** Click a block-menu row by its label text; returns whether it was found. */
async function clickMenuItem(page, label) {
    return page.evaluate((label) => {
        const rows = [...document.querySelectorAll(".block-menu .block-menu-item")];
        const row = rows.find((r) => r.querySelector(".block-menu-item-label")?.textContent?.trim() === label);
        if (!row) return false;
        row.click();
        return true;
    }, label);
}

export async function run({ page, check, baseUrl }) {
    // ── 1. Placement: sibling gutter, anchored onto the rule ──
    await open(page, baseUrl, DOC);
    const hasGutter = await page.$(HR_GUTTER);
    check("the hr's gutter is its next sibling, stamped --leaf", hasGutter !== null);
    const hr = await rect(page, HR_HOST);
    const gutter = await rect(page, HR_GUTTER);
    const marker = await rect(page, HR_MARKER);
    check("leaf gutter spans the rule's own box (anchor positioning resolved)",
        Math.abs(gutter.y - hr.y) < 1 && Math.abs(gutter.h - hr.h) < 1,
        `hr=${JSON.stringify(hr)} gutter=${JSON.stringify(gutter)}`);
    // The line is painted through the middle of the 3em band.
    check("marker is centered on the rule's line",
        Math.abs(marker.cy - hr.cy) <= 2, `marker.cy=${marker.cy} hr.cy=${hr.cy}`);
    // Calibration net: the P marker of the paragraph above keeps the same
    // column, so the two markers align to within a pixel.
    const pMarker = await rect(page, ".ProseMirror > p .heading-fold-marker--paragraph");
    check("marker sits in the same gutter column as the paragraph's P marker",
        Math.abs(marker.right - pMarker.right) <= 1 && Math.abs(marker.x - pMarker.x) <= 1,
        `hr marker right=${marker.right} P right=${pMarker.right}`);

    // ── 2. Hover reveal ──
    check("idle: hr marker invisible", (await opacity(page, HR_MARKER)) === 0);
    await page.mouse.move(hr.cx, hr.cy);
    await page.waitForTimeout(120);
    await page.mouse.move(hr.cx + 1, hr.cy);
    await page.waitForTimeout(60);
    const revealed = await opacity(page, HR_MARKER);
    check("hovering the rule reveals its marker at resting contrast", revealed > 0.5 && revealed < 0.9, `opacity=${revealed}`);
    // Travel rule → marker across the gap; the marker must stay alive and
    // arrive at full contrast.
    await page.mouse.move(hr.x + 4, marker.cy);
    await page.waitForTimeout(60);
    await page.mouse.move(marker.cx, marker.cy, { steps: 20 });
    await page.waitForTimeout(120);
    check("traveling rule → marker lands at full contrast", (await opacity(page, HR_MARKER)) === 1);
    check("hovered marker names the block", await page.$eval(HR_MARKER, (el) => el.dataset.pill) === "Horizontal Rule");

    // ── 3. The block menu opens from the marker and acts on the rule ──
    await page.mouse.click(marker.cx, marker.cy);
    await settle(page);
    const menuOpen = await page.evaluate(() => {
        const menu = document.querySelector(".block-menu");
        const anchor = document.querySelector(".heading-fold-marker--menu-open");
        return {
            open: !!menu,
            pill: anchor?.dataset.pill ?? null,
            labels: menu ? [...menu.querySelectorAll(".block-menu-item-label")].map((l) => l.textContent.trim()) : [],
        };
    });
    check("clicking the marker opens the block menu anchored to it",
        menuOpen.open && menuOpen.pill === "Horizontal Rule", JSON.stringify(menuOpen));
    check("the rule's menu carries the block actions",
        ["Duplicate", "Move Down", "Delete"].every((l) => menuOpen.labels.includes(l)), JSON.stringify(menuOpen.labels));
    check("Duplicate row found", await clickMenuItem(page, "Duplicate"));
    const dup = await latestDoc(page, (d) => (d.match(/^---$/gm) ?? []).length === 2);
    check("Duplicate from the marker duplicates the rule", dup !== null, dup ?? "no update with two rules");
    await settle(page);

    // Move Down on the FIRST rule: it passes the second rule (below both
    // there is still Beta), so the marker on the first rule must act on it.
    await page.mouse.move(900, 850);
    let hrs = await page.$$eval(HR_HOST, (els) => els.length);
    check("two rules render two leaf gutters", hrs === 2 && (await page.$$eval(HR_GUTTER, (els) => els.length)) === 2);
    const first = await rect(page, HR_HOST);
    await page.mouse.move(first.cx, first.cy);
    await page.waitForTimeout(100);
    const m1 = await rect(page, HR_MARKER);
    await page.mouse.move(m1.cx, m1.cy, { steps: 6 });
    await page.mouse.click(m1.cx, m1.cy);
    await settle(page);
    check("Move Down row found", await clickMenuItem(page, "Move Down"));
    const moved = await latestDoc(page, (d) => d.indexOf("Beta paragraph.") < d.lastIndexOf("---") && d.indexOf("---") < d.indexOf("Beta paragraph."));
    check("Move Down from the marker moves the rule below Beta", moved !== null, moved ?? "no update");
    await settle(page);

    // Delete the last rule (now below Beta).
    await page.mouse.move(900, 850);
    const lastHr = await page.$$eval(HR_HOST, (els) => {
        const r = els[els.length - 1].getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    await page.mouse.move(lastHr.cx, lastHr.cy);
    await page.waitForTimeout(100);
    const m2 = await page.$$eval(HR_MARKER, (els) => {
        const r = els[els.length - 1].getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    await page.mouse.move(m2.cx, m2.cy, { steps: 6 });
    await page.mouse.click(m2.cx, m2.cy);
    await settle(page);
    check("Delete row found", await clickMenuItem(page, "Delete"));
    const deleted = await latestDoc(page, (d) => (d.match(/^---$/gm) ?? []).length === 1);
    check("Delete from the marker deletes the rule", deleted !== null, deleted ?? "no update with one rule");

    // ── 4. Drag: the marker moves the rule ──
    await open(page, baseUrl, DOC);
    const hr2 = await rect(page, HR_HOST);
    await page.mouse.move(hr2.cx, hr2.cy);
    await page.waitForTimeout(100);
    const m3 = await rect(page, HR_MARKER);
    await page.mouse.move(m3.cx, m3.cy, { steps: 6 });
    const gamma = await page.$$eval(".ProseMirror > p", (els) => {
        const r = els[els.length - 1].getBoundingClientRect();
        return { cx: r.x + r.width / 2, bottom: r.bottom };
    });
    await page.mouse.down();
    await page.mouse.move(m3.cx + 10, m3.cy + 10);
    await page.mouse.move(gamma.cx, gamma.bottom - 2, { steps: 8 });
    await page.waitForTimeout(100);
    const indicator = await page.$eval(".block-drag-indicator", (el) => getComputedStyle(el).display !== "none");
    check("dragging the rule's marker shows the drop indicator", indicator);
    const dragged = await opacity(page, HR_MARKER);
    check("the dragged leaf marker keeps full contrast off its block", dragged === 1, `opacity=${dragged}`);
    await page.mouse.up();
    const reordered = await latestDoc(page, (d) => d.indexOf("Gamma paragraph.") < d.indexOf("---"));
    check("dropping below Gamma moves the rule there", reordered !== null, reordered ?? "no update");
    check("the drag did not open the block menu", (await page.$(".block-menu")) === null);

    // ── 4b. A rule nested in a callout: seated on ITS line, clear of the bar ──
    // The per-wrapper calibrations (`.callout .heading-fold-gutter--block`)
    // reach a nested leaf gutter by descent; the leaf rule must outrank them
    // or the marker rides the callout's title line.
    await open(page, baseUrl, "> [!NOTE]\n> Inside.\n>\n> ---\n>\n> More.\n\nOutside.\n");
    const nestedHr = await rect(page, ".ProseMirror .callout hr.block-gutter-host--leaf");
    const nestedMarker = await rect(page, ".ProseMirror .callout hr.block-gutter-host--leaf + .heading-fold-gutter--leaf .heading-fold-marker");
    const calloutBox = await rect(page, ".ProseMirror > .callout");
    check("nested rule's marker is centered on the nested rule's own line",
        Math.abs(nestedMarker.cy - nestedHr.cy) <= 2, `marker.cy=${nestedMarker.cy} hr.cy=${nestedHr.cy}`);
    check("nested rule's marker sits clear of the callout's accent bar (in the margin)",
        nestedMarker.right < calloutBox.x, `marker.right=${nestedMarker.right} callout.x=${calloutBox.x}`);
    await page.mouse.move(nestedHr.cx, nestedHr.cy);
    await page.waitForTimeout(120);
    await page.mouse.move(nestedHr.cx + 1, nestedHr.cy);
    await page.waitForTimeout(60);
    const nestedRevealed = await page.$eval(
        ".ProseMirror .callout hr.block-gutter-host--leaf + .heading-fold-gutter--leaf .heading-fold-marker",
        (el) => parseFloat(getComputedStyle(el).opacity));
    const calloutOwn = await page.$eval(
        ".ProseMirror > .callout > .callout-body > .heading-fold-gutter--block .heading-fold-marker",
        (el) => parseFloat(getComputedStyle(el).opacity)).catch(() => null);
    check("hovering the nested rule reveals ITS marker, not the callout's",
        nestedRevealed > 0.5 && (calloutOwn === null || calloutOwn === 0), `nested=${nestedRevealed} callout=${calloutOwn}`);

    // ── 5. A folded section hides the rule AND its sibling gutter ──
    await open(page, baseUrl, "# Section\n\nBody.\n\n---\n\nMore.\n\n# Next\n\nTail.\n");
    // The chevron is opacity-0 until its heading is hovered; a synthetic
    // click on the button is the same protocol path as the pointer's.
    await page.$eval(".ProseMirror h1 .heading-fold-toggle", (el) => el.click());
    await settle(page);
    const folded = await page.evaluate(() => {
        const hr = document.querySelector(".ProseMirror > hr");
        const gutter = hr?.nextElementSibling;
        return {
            hrHidden: hr ? getComputedStyle(hr).display === "none" : null,
            gutterHidden: gutter ? getComputedStyle(gutter).display === "none" : null,
        };
    });
    check("folding the section hides the rule and its gutter together",
        folded.hrHidden === true && folded.gutterHidden === true, JSON.stringify(folded));

    // ── 6. The mdx block: same marker, seated on its label ──
    const MDX = "# Doc\n\nProse.\n\n<Chart data={1} color=\"#fff\" />\n\nAfter.\n";
    await open(page, baseUrl, MDX, "mdx");
    const MDX_HOST = ".ProseMirror > .mdx-block.block-gutter-host--leaf";
    const MDX_GUTTER = `${MDX_HOST} + .heading-fold-gutter--leaf`;
    check("the mdx block's gutter is its next sibling, stamped --leaf", (await page.$(MDX_GUTTER)) !== null);
    const label = await rect(page, `${MDX_HOST} .mdx-block-label`);
    const mdxMarker = await rect(page, `${MDX_GUTTER} .heading-fold-marker`);
    const mdxHost = await rect(page, MDX_HOST);
    check("mdx marker is seated on the block's label line",
        Math.abs(mdxMarker.cy - label.cy) <= 3, `marker.cy=${mdxMarker.cy} label.cy=${label.cy} host=${JSON.stringify(mdxHost)}`);
    const pM = await rect(page, ".ProseMirror > p .heading-fold-marker--paragraph");
    check("mdx marker keeps the shared gutter column",
        Math.abs(mdxMarker.right - pM.right) <= 1, `mdx right=${mdxMarker.right} P right=${pM.right}`);
    await page.mouse.move(mdxHost.cx, mdxHost.cy);
    await page.waitForTimeout(120);
    await page.mouse.move(mdxHost.cx + 1, mdxHost.cy);
    await page.waitForTimeout(60);
    const mdxRevealed = await opacity(page, `${MDX_GUTTER} .heading-fold-marker`);
    check("hovering the mdx block reveals its marker", mdxRevealed > 0.5 && mdxRevealed < 0.9, `opacity=${mdxRevealed}`);
    await page.mouse.move(mdxMarker.cx, mdxMarker.cy, { steps: 10 });
    await page.mouse.click(mdxMarker.cx, mdxMarker.cy);
    await settle(page);
    const mdxMenu = await page.evaluate(() => ({
        open: !!document.querySelector(".block-menu"),
        pill: document.querySelector(".heading-fold-marker--menu-open")?.dataset.pill ?? null,
    }));
    check("the mdx block's marker opens the block menu", mdxMenu.open && mdxMenu.pill === "MDX", JSON.stringify(mdxMenu));
    check("Delete row found (mdx)", await clickMenuItem(page, "Delete"));
    const mdxDeleted = await latestDoc(page, (d) => !d.includes("<Chart"));
    check("Delete from the mdx marker removes the island", mdxDeleted !== null, mdxDeleted ?? "no update");
}
