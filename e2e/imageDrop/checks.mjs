/**
 * Dropping an image file from outside the window (editing/fileDrop.ts) —
 * the real-layout truths jsdom can't reach:
 *   - the accent drop line appears while an image drag is over the editor,
 *     snapped to the block boundary nearest the pointer,
 *   - the image lands AT that boundary, not at the caret,
 *   - the line re-aims after the page scrolls mid-drag,
 *   - resting near the bottom edge auto-scrolls, with no further drag events,
 *   - crossing between elements doesn't clear the line; leaving does,
 *   - a non-image file drag is left alone entirely,
 *   - a drag carrying SEVERAL images lands all of them, in drag order, as one
 *     undo step (MAR-281) — a real multi-file DataTransfer through a real drop
 *     event, which is the layer the singular-detection bug lived in.
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
 *
 * `tags` are the payloads' leading bytes: the harness page turns each into a
 * distinct saved path, so a multi-file drop's result is order-legible. One tag
 * is one file, so `tags: [2, 3, 4]` is a three-file drag.
 */
async function fireDrag(page, type, x, y, { mime = "image/png", intoSibling = false, tags = [1] } = {}) {
    return page.evaluate(({ type, x, y, mime, intoSibling, tags }) => {
        const dt = new DataTransfer();
        const ext = mime.startsWith("image/") ? "png" : "md";
        for (const tag of tags) {
            dt.items.add(new File([new Uint8Array([tag, 2, 3])], `photo${tag}.${ext}`, { type: mime }));
        }
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
    }, { type, x, y, mime, intoSibling, tags });
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

    // ── 6. Several files dropped at once all land, in drag order (MAR-281) ──
    // The bug: detection was singular, so this inserted ONE image and threw the
    // other two away silently. The harness page answers the three saves in
    // REVERSE drag order (see index.html), so an implementation that inserts
    // each file as it resolves gets the order wrong and fails here — which a
    // stub answering in order could not distinguish.
    const charlie = await paragraphRect(page, "charlie");
    await fireDrag(page, "dragenter", charlie.x, charlie.top + 4, { tags: [2, 3, 4] });
    await fireDrag(page, "dragover", charlie.x, charlie.top + 4, { tags: [2, 3, 4] });
    await fireDrag(page, "drop", charlie.x, charlie.top + 4, { tags: [2, 3, 4] });

    const multiDoc = await latestDoc(page, (c) => c.includes("img/dropped-4.jpeg"));
    check("all three dropped images are inserted",
        multiDoc !== null
            && ["dropped-2", "dropped-3", "dropped-4"].every((n) => multiDoc.includes(n)),
        JSON.stringify(multiDoc));
    check("the three land in drag order, not in the order their saves resolved",
        multiDoc !== null
            && /!\[\]\(img\/dropped-2\.jpeg\)[\s\S]*!\[\]\(img\/dropped-3\.jpeg\)[\s\S]*!\[\]\(img\/dropped-4\.jpeg\)/
                .test(multiDoc),
        JSON.stringify(multiDoc));
    check("they land as three separate blocks at the drop point, above charlie",
        multiDoc !== null
            && /!\[\]\(img\/dropped-2\.jpeg\)\s+!\[\]\(img\/dropped-3\.jpeg\)\s+!\[\]\(img\/dropped-4\.jpeg\)\s+charlie/
                .test(multiDoc),
        JSON.stringify(multiDoc));

    // Four images in the document now: the single drop above, plus these three.
    // `:not(.ProseMirror-separator)` matters — ProseMirror renders its own
    // <img> artifacts into contenteditable and a bare selector counts them.
    const rendered = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror img:not(.ProseMirror-separator)").length);
    check("every dropped image is rendered, none duplicated", rendered === 4, `imgs=${rendered}`);

    // ── 7. A non-image file drag is not ours ──
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
    // Four from the drops above (one single + one batch of three) and no more.
    check("a dropped non-image file inserts nothing",
        (afterMd.match(/!\[/g) ?? []).length === 4, JSON.stringify(afterMd));

    // ── 8. One gesture, one undo step ──
    // Last, because it rolls the document back. This pins the user-visible
    // behavior through the REAL keymap, which the unit tests can't reach — but
    // it is a pin, not a discriminator: these saves resolve well inside
    // ProseMirror's history grouping window, so per-file inserts would collapse
    // into one step here too (measured against a per-file mutant, which fails
    // the ordering checks above and passes this one). The straddling case lives
    // in webview/__tests__/imageMultiUpload.test.ts, where the clock is ours.
    await page.locator(".ProseMirror > p").first().click();
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    const undone = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror img:not(.ProseMirror-separator)").length);
    check("one undo removes the whole three-image batch, leaving the earlier drop",
        undone === 1, `imgs after undo=${undone}`);
}
