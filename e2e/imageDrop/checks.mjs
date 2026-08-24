/**
 * Dropping an image file from outside the window (editing/fileDrop.ts) —
 * the real-layout truths jsdom can't reach:
 *   - the accent drop line appears while an image drag is over the editor,
 *     snapped to the block boundary nearest the pointer,
 *   - the image lands AT that boundary, not at the caret,
 *   - the line re-aims after the page scrolls mid-drag,
 *   - resting near the bottom edge auto-scrolls, with no further drag events,
 *   - crossing between elements doesn't clear the line; leaving does,
 *   - a drag that ends with nothing announcing it still takes the line down:
 *     released over another application, or released here on something that
 *     declines it,
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
        const ext = mime === "image/svg+xml" ? "svg" : mime.startsWith("image/") ? "png" : "md";
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

    /**
     * Park "bravo" in the middle of the viewport and return its fresh rect.
     * Every aiming check points at `bravo.top + 4`, which must sit in the
     * auto-scroll DEAD BAND — inside the top zone (toolbar bottom → +80px) the
     * rAF loop scrolls the page between measurements and the line legitimately
     * moves under them. Re-run this after any scroll, since the rect is
     * viewport-relative.
     */
    const centerBravo = async () => {
        await page.$$eval(".ProseMirror > p", (els) => {
            const el = els.find((e) => e.textContent.includes("bravo"));
            el.scrollIntoView({ block: "center" });
        });
        await page.waitForTimeout(100);
        return paragraphRect(page, "bravo");
    };

    let bravo = await centerBravo();

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
    // The pointer hasn't moved, so it now sits over whatever scrolled under
    // it — the line must track the boundary nearest that point NOW. Both
    // samples in ONE round-trip, for the same reason the edge-scroll check
    // below does it: separate evaluates compare two different moments.
    const scrolled = await page.evaluate((y) => {
        const el = document.querySelector(".block-drag-indicator");
        const line = el && getComputedStyle(el).display !== "none"
            ? el.getBoundingClientRect().top
            : null;
        const tops = [...document.querySelectorAll(".ProseMirror > *")]
            .map((n) => n.getBoundingClientRect().top);
        const nearest = tops.reduce(
            (best, t) => (Math.abs(t - y) < Math.abs(best - y) ? t : best), tops[0]);
        return { line, nearest };
    }, bravo.top + 4);
    check("drop line re-aims after a mid-drag scroll",
        scrolled.line !== null && Math.abs(scrolled.line - (scrolled.nearest - 1)) <= 2,
        JSON.stringify({ ...scrolled, bravoAfterScroll }));
    bravo = await centerBravo();

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
    bravo = await centerBravo();

    // ── 4. Crossing between elements keeps the line; leaving clears it ──
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    await fireDrag(page, "dragleave", bravo.x, bravo.top + 4, { intoSibling: true });
    check("a dragleave that is only a crossing keeps the line up",
        (await indicator(page)) !== null);
    await fireDrag(page, "dragleave", bravo.x, bravo.top + 4);
    check("a dragleave that leaves the document clears the line",
        (await indicator(page)) === null);

    // ── 4b. A drag that ends with nothing announcing it ──
    // The line outliving its drag was a real report, and there are two ways
    // in. Neither is reachable from the drag events alone, which is why both
    // are checked here rather than in jsdom.
    //
    // First: released over another application. `dragend` fires in the
    // document the drag STARTED in, which for a file from Finder is nowhere;
    // a `dragleave` on the way out is the only notice there is, and where it
    // does not arrive, or does not read as a departure, nothing else ever
    // says the drag is over. A mouse move is the proof, because a drag
    // session swallows them.
    await fireDrag(page, "dragenter", bravo.x, bravo.top + 4);
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    check("the drop line is up before the drag is abandoned",
        (await indicator(page)) !== null);
    await page.mouse.move(bravo.x, bravo.top + 20);
    check("a drag abandoned with no dragleave clears on the next mouse move",
        (await indicator(page)) === null);

    // Second: released HERE, on something that does not take it. The commit
    // path clears the aim, and it only runs for a drop ProseMirror handles,
    // so a release the editor declines used to leave the line up with no
    // dragleave and no dragend behind it. Aimed with an image drag and
    // released with a payload the editor refuses, which is the shape of it.
    await fireDrag(page, "dragenter", bravo.x, bravo.top + 4);
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4);
    check("the drop line is up before the declined drop",
        (await indicator(page)) !== null);
    await fireDrag(page, "drop", bravo.x, bravo.top + 4, { mime: "text/markdown" });
    check("a drop the editor declines still clears the line",
        (await indicator(page)) === null);

    // ── 5. The drop lands at the aimed-at boundary, not at the caret ──
    // Put the caret somewhere else first: the old behavior inserted there.
    // Clicking the document's first paragraph scrolls the page up to it, so
    // re-park bravo afterwards — the caret stays where the click put it.
    await page.locator(".ProseMirror > p").first().click();
    await page.waitForTimeout(100);
    bravo = await centerBravo();
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

    // ── 9. An .svg file drops like any other image (MAR-402) ──
    // Nothing SVG-specific was ever written on this path: `image/svg+xml`
    // simply satisfies the `image/*` filter and the extension's mimeToExt
    // already maps it. That makes this the check the claim rests on, because
    // the code reads as if it works whether or not it does — the payload has
    // to be driven through a real drop to find out.
    //
    // Last, after the undo, so it disturbs none of the counts above.
    bravo = await centerBravo();
    await fireDrag(page, "dragenter", bravo.x, bravo.top + 4, { mime: "image/svg+xml" });
    await fireDrag(page, "dragover", bravo.x, bravo.top + 4, { mime: "image/svg+xml" });
    check("an .svg drag aims like any other image", (await indicator(page)) !== null);
    await fireDrag(page, "drop", bravo.x, bravo.top + 4, { mime: "image/svg+xml" });

    // The stub answers with the extension's own mime-derived extension, so a
    // path ending `.svg` is the tell that the payload's type survived the trip.
    const svgDoc = await latestDoc(page, (c) => c.includes("img/dropped.svg"));
    check("a dropped .svg is saved and inserted at the drop point",
        // Above bravo, below the earlier single drop that survived the undo.
        svgDoc !== null
            && /!\[\]\(img\/dropped\.jpeg\)\s+!\[\]\(img\/dropped\.svg\)\s+bravo/.test(svgDoc),
        JSON.stringify(svgDoc?.slice(svgDoc.indexOf("alpha"), svgDoc.indexOf("charlie"))));
    const svgImg = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror img:not(.ProseMirror-separator)")]
            .map((i) => i.getAttribute("src") ?? "")
            .filter((s) => s.endsWith(".svg")).length);
    check("and it renders as an image node", svgImg === 1, `svg imgs=${svgImg}`);
}
