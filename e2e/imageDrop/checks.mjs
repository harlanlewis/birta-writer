/**
 * Dropping an image file from outside the window (editing/fileDrop.ts) —
 * the real-layout truths jsdom can't reach:
 *   - the accent drop line appears while an image drag is over the editor,
 *     snapped to the block boundary nearest the pointer,
 *   - the image lands AT that boundary, not at the caret,
 *   - the line re-aims after the page scrolls mid-drag,
 *   - resting near the bottom edge auto-scrolls, with no further drag events,
 *   - crossing between elements doesn't clear the line; leaving does,
 *   - a non-image file drag is left alone entirely.
 *
 * Out of reach here, and deliberately not asserted: VS Code's own
 * whole-editor drop overlay lives in the workbench, not the webview. This
 * page has no workbench, so nothing it checks can speak to that.
 */

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

/**
 * Fire a native drag event at a viewport point with a real DataTransfer.
 * Chromium builds both for us, so this is the genuine event shape the
 * production listeners see — only the OS is simulated.
 */
async function fireDrag(page, type, x, y, { mime = "image/png", intoSibling = false } = {}) {
    return page.evaluate(({ type, x, y, mime, intoSibling }) => {
        const dt = new DataTransfer();
        const name = mime.startsWith("image/") ? "photo.png" : "notes.md";
        dt.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: mime }));
        const target = document.elementFromPoint(x, y) ?? document.body;
        const event = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            dataTransfer: dt,
            // An element being entered — what Chromium reports on a dragleave
            // that is merely a crossing rather than a departure.
            relatedTarget: intoSibling ? (target.nextElementSibling ?? document.body) : null,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
    }, { type, x, y, mime, intoSibling });
}

/** The drop line's own geometry, or null when it isn't showing. */
async function indicator(page) {
    return page.evaluate(() => {
        const el = document.querySelector(".block-drag-indicator");
        if (!el || getComputedStyle(el).display === "none") return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, width: r.width };
    });
}

/** Top/bottom of the top-level paragraph containing `text`. */
async function paragraphRect(page, text) {
    return page.$$eval(".ProseMirror > p", (els, t) => {
        const el = els.find((e) => e.textContent.includes(t));
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, x: r.x + r.width / 2 };
    }, text);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(400);

    const bravo = await paragraphRect(page, "bravo");

    // ── 1. The drag is claimed on dragenter, and shows the line ──
    // Claimed over the TOOLBAR, deliberately: inside the editable region
    // Chromium's own editing code prevents the event too, so a check there
    // would pass with our listener removed. The toolbar is chrome — nothing
    // else claims it — so this is the honest test that we did.
    const enterPrevented = await fireDrag(page, "dragenter", bravo.x, 10);
    check("dragenter with an image file is claimed, so a drop can fire in the webview",
        enterPrevented);
    check("no drop line while the drag is over chrome", (await indicator(page)) === null);
    await fireDrag(page, "dragleave", bravo.x, 10);

    await fireDrag(page, "dragenter", bravo.x, bravo.top + 4);
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    const line = await indicator(page);
    check("drop line shows while an image drag is over the editor", line !== null,
        JSON.stringify(line));
    check("drop line sits at the boundary above the pointer's paragraph",
        line !== null && Math.abs(line.top - (bravo.top - 1)) <= 2,
        JSON.stringify({ line, bravoTop: bravo.top }));
    check("drop line spans the editor width", line !== null && line.width > 100,
        JSON.stringify(line));

    // ── 2. Scrolling mid-drag re-aims the line ──
    // Boundary geometry is viewport-relative; a wheel scroll during a drag
    // moves every block out from under a cached measurement.
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(50);
    const bravoAfterScroll = await paragraphRect(page, "bravo");
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    const scrolledLine = await indicator(page);
    // The pointer hasn't moved, so it now sits over whatever scrolled under
    // it — the line must track the boundary nearest that point NOW.
    const nearestNow = await page.evaluate((y) => {
        const tops = [...document.querySelectorAll(".ProseMirror > *")]
            .map((el) => el.getBoundingClientRect().top);
        return tops.reduce((best, t) => (Math.abs(t - y) < Math.abs(best - y) ? t : best), tops[0]);
    }, bravo.top + 4);
    check("drop line re-aims after a mid-drag scroll",
        scrolledLine !== null && Math.abs(scrolledLine.top - (nearestNow - 1)) <= 2,
        JSON.stringify({ scrolledLine, nearestNow, bravoAfterScroll }));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);

    // ── 3. Resting in the edge zone auto-scrolls ──
    // One dragover near the bottom edge and then NO further events: drag
    // events are movement-driven, so this only advances if the rAF loop is
    // driving it. That is the case that matters — you hold still at the edge
    // and wait for the document to come to you.
    const viewport = await page.evaluate(() => window.innerHeight);
    await fireDrag(page, "dragover", bravo.x, viewport - 8);
    await page.waitForTimeout(400);
    const scrolledBy = await page.evaluate(() => window.scrollY);
    check("resting at the bottom edge auto-scrolls with no further drag events",
        scrolledBy > 100, `scrollY=${scrolledBy}`);
    // Both samples in ONE round-trip: the page is still scrolling, so reading
    // the line and the boundary in separate evaluates compares two different
    // moments and drifts by a frame of travel.
    const aimWhileScrolling = await page.evaluate((y) => {
        const el = document.querySelector(".block-drag-indicator");
        const line = el && getComputedStyle(el).display !== "none"
            ? el.getBoundingClientRect().top
            : null;
        const tops = [...document.querySelectorAll(".ProseMirror > *")]
            .map((n) => n.getBoundingClientRect().top);
        const nearest = tops.reduce(
            (best, t) => (Math.abs(t - y) < Math.abs(best - y) ? t : best), tops[0]);
        return { line, nearest };
    }, viewport - 8);
    check("the drop line keeps aiming at the content scrolling under the pointer",
        aimWhileScrolling.line !== null
            && Math.abs(aimWhileScrolling.line - (aimWhileScrolling.nearest - 1)) <= 2,
        JSON.stringify(aimWhileScrolling));

    // Leaving the edge zone stops it.
    await fireDrag(page, "dragover", bravo.x, Math.round(viewport / 2));
    await page.waitForTimeout(200);
    const restedAt = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(300);
    const stillRestedAt = await page.evaluate(() => window.scrollY);
    check("leaving the edge zone stops the auto-scroll",
        restedAt === stillRestedAt, `${restedAt} -> ${stillRestedAt}`);
    await fireDrag(page, "dragleave", bravo.x, Math.round(viewport / 2));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);

    // ── 4. Crossing between elements keeps the line; leaving clears it ──
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    await fireDrag(page, "dragleave", bravo.x, bravo.top + 4, { intoSibling: true });
    check("a dragleave that is only a crossing keeps the line up",
        (await indicator(page)) !== null);
    await fireDrag(page, "dragleave", bravo.x, bravo.top + 4);
    check("a dragleave that leaves the document clears the line",
        (await indicator(page)) === null);

    // ── 5. The drop lands at the aimed-at boundary, not at the caret ──
    // Put the caret somewhere else first: the old behavior inserted there.
    await page.locator(".ProseMirror > p").first().click();
    await page.waitForTimeout(100);
    await fireDrag(page, "dragenter", bravo.x, bravo.top + 4);
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    const dropPrevented = await fireDrag(page, "drop", bravo.x, bravo.top + 4);
    check("drop with an image file is claimed", dropPrevented);

    const doc = await latestDoc(page, (c) => c.includes("img/dropped.jpeg"));
    check("dropped image is inserted at the drop point, not at the caret",
        doc !== null && /alpha\s+!\[\]\(img\/dropped\.jpeg\)\s+bravo/.test(doc),
        JSON.stringify(doc));
    check("drop line is gone after the drop", (await indicator(page)) === null);

    // ── 6. A non-image file drag is not ours ──
    // (defaultPrevented is not the tell here: Chromium's own editing code
    // claims drag events over a contenteditable region regardless of us.
    // The observable difference is that nothing aims and nothing lands.)
    await fireDrag(page, "dragenter", bravo.x, bravo.top + 4, { mime: "text/markdown" });
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4, { mime: "text/markdown" });
    check("no drop line for a non-image drag", (await indicator(page)) === null);
    await fireDrag(page, "drop", bravo.x, bravo.top + 4, { mime: "text/markdown" });
    await page.waitForTimeout(400);
    const afterMd = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").map((m) => m.content).pop());
    check("a dropped non-image file inserts nothing",
        (afterMd.match(/!\[/g) ?? []).length === 1, JSON.stringify(afterMd));
}
