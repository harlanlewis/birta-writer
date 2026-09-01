/**
 * The table's row/column chrome under a coarse pointer (MAR-340), and the
 * mouse path it must not cost anything.
 *
 * Driven through CDP `Input.dispatchTouchEvent` so Blink's own gesture
 * recognizer runs: `touch-action` is honored, compatibility mouse events are
 * synthesized (or withheld) exactly as they are on hardware, and a gesture the
 * browser claims as a pan really does arrive as `pointercancel`. jsdom has
 * neither a layout engine nor a PointerEvent, so this is the only place any of
 * it can be checked.
 *
 * Two mechanisms are pinned here, because the table needed both and either one
 * alone leaves the chrome unreachable:
 *
 *   - Construction and reveal. The overlay is built lazily by the first
 *     pointer event that could precede a gesture, which was `pointermove`
 *     alone. A finger at rest emits pointerdown and pointerup and no move, so
 *     the grips and "+" buttons did not exist in the DOM at all after a tap.
 *   - The drag itself. Arming on `mousedown` cannot work under touch: Blink
 *     synthesizes no compatibility mouse events while a finger is dragging,
 *     only after a tap resolves. And a pointer-armed drag without
 *     `touch-action: none` is cancelled by the browser a few moves in.
 */

async function touchEmulation(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setEmulatedMedia", {
        features: [
            { name: "pointer", value: "coarse" },
            { name: "any-pointer", value: "coarse" },
            { name: "hover", value: "none" },
            { name: "any-hover", value: "none" },
        ],
    });
    const send = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
    const at = (p, id = 1) => ({ x: p.x, y: p.y, id });
    return {
        /**
         * Hand the page back to a real mouse. Touch emulation REWRITES
         * Playwright's mouse input into touch, so a mouse assertion made while
         * it is on is not about a mouse at all — it reads as a stray touch,
         * and the two mouse checks below both went red proving nothing.
         */
        disable: async () => {
            await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp.send("Emulation.setEmulatedMedia", { features: [] });
        },
        tap: async (x, y) => {
            await send("touchStart", [at({ x, y })]);
            await page.waitForTimeout(30);
            await send("touchEnd", []);
            await page.waitForTimeout(160);
        },
        /** A finger drag held OPEN at `to`: the caller inspects, then ends it. */
        drag: async (from, to, steps = 12) => {
            await send("touchStart", [at(from)]);
            for (let i = 1; i <= steps; i++) {
                await send("touchMove", [at({
                    x: from.x + ((to.x - from.x) * i) / steps,
                    y: from.y + ((to.y - from.y) * i) / steps,
                })]);
                await page.waitForTimeout(16);
            }
            await page.waitForTimeout(60);
            const settle = () => page.waitForTimeout(200);
            return {
                release: async () => { await send("touchEnd", []); await settle(); },
                /** The browser takes the gesture away mid-drag. */
                stolen: async () => { await send("touchCancel", []); await settle(); },
            };
        },
    };
}

/** The serialized doc after updates settle (updates are debounced). */
async function latestDoc(page, matcher, tries = 25) {
    for (let i = 0; i < tries; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last && matcher(last)) return last;
        await page.waitForTimeout(100);
    }
    return null;
}

const currentDoc = (page) => page.evaluate(() =>
    window.__posted.filter((m) => m.type === "update").map((m) => m.content).pop() ?? null);

/**
 * A grip that isn't there, in a shape the gesture helpers can still be handed.
 * A regression that stops the overlay being built makes every probe null, and
 * a bare `.x` on that reports as a suite CRASH rather than as the failure it
 * is — which is the difference between reading the cause off the log and
 * bisecting for it (the same defensive read e2e/touchBlocks documents).
 */
const NO_GRIP = { x: -1, y: -1, w: 0, h: 0, opacity: 0, touchAction: "", near: false };

/** Centre, size, opacity and touch-action of one row grip. */
const gripProbe = (page, row) => page.evaluate((r) => {
    const g = document.querySelector(`.mw-grip--row[data-row="${r}"]`);
    if (!g) return null;
    const b = g.getBoundingClientRect();
    const cs = getComputedStyle(g);
    return {
        x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height,
        opacity: Number(cs.opacity), touchAction: cs.touchAction,
        near: g.classList.contains("mw-near"),
    };
}, row);

const overlayCount = (page) => page.evaluate(() => ({
    grips: document.querySelectorAll(".mw-grip").length,
    inserts: document.querySelectorAll(".mw-insert").length,
    near: document.querySelectorAll(".mw-near").length,
}));

/**
 * Table bounds plus each row's first-cell centre, keyed by the row index the
 * grips use (0 is the header). Indices, not cell text: a reorder is exactly
 * what these checks perform, so text would name a moving target.
 */
const tableGeometry = (page) => page.evaluate(() => {
    const t = document.querySelector(".ProseMirror table");
    const b = t.getBoundingClientRect();
    const rows = [...t.querySelectorAll("tr")].map((tr) => {
        const c = tr.querySelector("td,th");
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: c.textContent.trim() };
    });
    return { left: b.left, top: b.top, bottom: b.bottom, right: b.right, rows };
});

export async function run({ page, check, baseUrl, skip, browserName }) {
    // Touch emulation is driven through a CDP session, and CDP is Chromium's
    // protocol: there is no WebKit equivalent Playwright exposes. So this suite
    // cannot run here at all, which is a different thing from failing, and the
    // runner prints it as a skip so a WebKit red count stays a statement about
    // the product rather than about the harness's portability.
    if (browserName !== "chromium") {
        skip("touch emulation needs a CDP session, which is Chromium-only");
        return;
    }

    const touch = await touchEmulation(page);
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".ProseMirror table", { timeout: 10000 });
    await page.waitForTimeout(700);

    const media = await page.evaluate(() => ({
        pointerCoarse: matchMedia("(pointer: coarse)").matches,
        hoverNone: matchMedia("(hover: none)").matches,
        maxTouchPoints: navigator.maxTouchPoints,
    }));
    check(
        "the page is running as a hoverless, coarse-pointer touchscreen",
        media.pointerCoarse && media.hoverNone && media.maxTouchPoints > 0,
        JSON.stringify(media),
    );

    const geo = await tableGeometry(page);

    // ── 1. Nothing is built until a gesture asks for it. This is the lazy
    //       overlay working as intended, and the baseline the next check moves.
    const atRest = await overlayCount(page);
    check("the table's overlay chrome is absent until touched",
        atRest.grips === 0 && atRest.inserts === 0, JSON.stringify(atRest));

    // ── 2. A TAP builds the overlay and reveals the chrome for the row it
    //       landed in. Revert the wrapper's `pointerdown` reveal listener and
    //       this goes red — and with it every check below, because a finger
    //       emits no pointermove and nothing else constructs the overlay.
    await touch.tap(geo.rows[1].x, geo.rows[1].y);
    await page.waitForTimeout(300);
    const built = await overlayCount(page);
    check("tapping a cell builds the table's overlay chrome",
        built.grips > 0 && built.inserts > 0, JSON.stringify(built));
    check("tapping a cell reveals the chrome nearest it", built.near > 0, JSON.stringify(built));

    // ── 3. The CSS half of the drag: without it the browser owns the gesture
    //       as a pan and check 5 goes red no matter what the JS does.
    const grip1 = await gripProbe(page, 1);
    check("a row grip opts out of browser panning",
        grip1 !== null && grip1.touchAction === "none", JSON.stringify(grip1));
    check("the tapped row's grip is visible to a finger",
        grip1 !== null && grip1.opacity > 0 && grip1.w > 0 && grip1.h > 0, JSON.stringify(grip1));

    // ── 4. The "+" is reachable: tap it and a row appears. It always ACTED
    //       under touch (its mousedown is a compatibility event Blink does
    //       synthesize for a tap) — it was invisible, which is the same thing
    //       as unreachable.
    const plus = await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".mw-insert--row.mw-near .mw-insert-btn")][0];
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, opacity: Number(cs.opacity), w: r.width };
    });
    check("the revealed row's insert button is visible to a finger",
        plus !== null && plus.opacity > 0 && plus.w > 0, JSON.stringify(plus));
    if (plus) {
        const beforeRows = await page.evaluate(() => document.querySelectorAll(".ProseMirror table tr").length);
        await touch.tap(plus.x, plus.y);
        await page.waitForTimeout(400);
        const afterRows = await page.evaluate(() => document.querySelectorAll(".ProseMirror table tr").length);
        check("tapping the insert button adds a row", afterRows === beforeRows + 1,
            `${beforeRows} -> ${afterRows}`);
        await page.keyboard.press("Meta+z");
        await page.waitForTimeout(400);
    }

    // ── 5. The gesture this ticket exists for: reorder a row by finger.
    //       Dragging body row 1's grip past row 2 swaps the two, asserted as
    //       whatever text those rows held going in rather than as fixture
    //       literals — earlier checks in this file reorder the same table.
    const geo2 = await tableGeometry(page);
    const rowsBeforeDrag = geo2.rows.map((r) => r.text);
    await touch.tap(geo2.rows[1].x, geo2.rows[1].y);
    await page.waitForTimeout(250);
    const dragGrip = (await gripProbe(page, 1)) ?? NO_GRIP;
    const session = await touch.drag(
        { x: dragGrip.x, y: dragGrip.y },
        { x: dragGrip.x, y: geo2.rows[2].y + 12 },
    );
    const midDrag = await page.evaluate(() => {
        const line = document.querySelector(".mw-drop-line");
        return {
            dragging: document.querySelector(".mw-table--dragging") !== null,
            dropLineShown: line !== null && getComputedStyle(line).display !== "none",
        };
    });
    check("a finger drag on a grip opens a live reorder with a drop line",
        midDrag.dragging && midDrag.dropLineShown, JSON.stringify(midDrag));
    await session.release();
    // Asserted on the serialized DOCUMENT, not just the DOM: a reorder that
    // never reached the file is not a reorder.
    const swapped = await latestDoc(page, (d) =>
        d.indexOf(rowsBeforeDrag[2]) < d.indexOf(rowsBeforeDrag[1]));
    check("a finger drag reorders the table's rows", swapped !== null,
        `${rowsBeforeDrag.join(",")} -> ${(await tableGeometry(page)).rows.map((r) => r.text).join(",")}`);

    // ── 6. A gesture the browser takes away abandons the reorder. Committing
    //       there would land the row wherever the finger was when the system
    //       intervened — and answering a cancel as a click would leave a whole
    //       row selected by what the user meant as a scroll.
    const geo3 = await tableGeometry(page);
    // Clear the CellSelection the successful reorder above left behind, or the
    // "did the cancel select anything" check below reads that residue instead
    // of what this gesture did.
    await page.evaluate(() => {
        const p = [...document.querySelectorAll(".ProseMirror > p")].pop();
        const r = p.getBoundingClientRect();
        return { x: r.x, y: r.y };
    });
    const outside = await page.evaluate(() => {
        const p = [...document.querySelectorAll(".ProseMirror > p")].pop();
        const r = p.getBoundingClientRect();
        return { x: r.x + 10, y: r.y + r.height / 2 };
    });
    await touch.tap(outside.x, outside.y);
    await page.waitForTimeout(200);
    check("the reorder's row selection clears on tapping away",
        (await page.evaluate(() => document.querySelectorAll(".ProseMirror .selectedCell").length)) === 0);
    await touch.tap(geo3.rows[1].x, geo3.rows[1].y);
    await page.waitForTimeout(250);
    const cancelGrip = (await gripProbe(page, 1)) ?? NO_GRIP;
    const beforeCancel = await currentDoc(page);
    const stolen = await touch.drag(
        { x: cancelGrip.x, y: cancelGrip.y },
        { x: cancelGrip.x, y: geo3.rows[2].y + 12 },
    );
    await stolen.stolen();
    const afterCancel = await currentDoc(page);
    const cancelClean = await page.evaluate(() => ({
        dragging: document.querySelector(".mw-table--dragging") !== null,
        dropLine: getComputedStyle(document.querySelector(".mw-drop-line")).display === "none",
        ghost: getComputedStyle(document.querySelector(".mw-drag-ghost")).display === "none",
        stuckGrips: document.querySelectorAll(".mw-grip--dragging").length,
        selectedCells: document.querySelectorAll(".ProseMirror .selectedCell").length,
    }));
    check("a stolen gesture abandons the reorder without moving anything",
        afterCancel === beforeCancel && !cancelClean.dragging &&
        cancelClean.dropLine && cancelClean.ghost && cancelClean.stuckGrips === 0,
        JSON.stringify(cancelClean));
    check("a stolen gesture does not select the row it was dragging",
        cancelClean.selectedCells === 0, String(cancelClean.selectedCells));

    // ── 7. The mouse path costs nothing. Same affordance, same code, and the
    //       hover reveal that was always there still works.
    //
    //       On a genuinely un-emulated page: with touch emulation on,
    //       Chromium rewrites Playwright's mouse input as touch, so every
    //       assertion here would be a second touch test wearing a mouse label.
    //       A reload is needed too — the page must be laid out for the pointer
    //       it is about to be driven with.
    await touch.disable();
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".ProseMirror table", { timeout: 10000 });
    await page.waitForTimeout(700);
    const mouseMedia = await page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        hoverNone: matchMedia("(hover: none)").matches,
    }));
    check("the page is back to a fine pointer that hovers",
        !mouseMedia.coarse && !mouseMedia.hoverNone, JSON.stringify(mouseMedia));

    const geoM = await tableGeometry(page);
    // Two steps, because a reveal keyed to pointermove needs the pointer to
    // actually move: a single jump from nowhere is one event at the
    // destination, which is not what hovering a table looks like.
    await page.mouse.move(geoM.rows[1].x + 60, geoM.rows[1].y + 25);
    await page.mouse.move(geoM.rows[1].x, geoM.rows[1].y);
    await page.waitForTimeout(300);
    const mouseGrip = (await gripProbe(page, 1)) ?? NO_GRIP;
    check("a mouse hover still reveals the row's grip",
        mouseGrip !== null && mouseGrip.opacity > 0, JSON.stringify(mouseGrip));
    const geoM2 = await tableGeometry(page);
    const rowsBeforeMouse = geoM2.rows.map((r) => r.text);
    await page.mouse.move(mouseGrip.x, mouseGrip.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(mouseGrip.x, mouseGrip.y + ((geoM2.rows[2].y + 12 - mouseGrip.y) * i) / 10);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();
    // The same swap invariant as the finger drag, read off the rendered rows
    // rather than the posted document: this half runs on a RELOADED page, so
    // `window.__posted` was emptied and a document-level assertion here would
    // be measuring the reload rather than the drag.
    let mouseRows = [];
    for (let i = 0; i < 25; i++) {
        mouseRows = (await tableGeometry(page)).rows.map((r) => r.text);
        if (mouseRows[1] === rowsBeforeMouse[2] && mouseRows[2] === rowsBeforeMouse[1]) break;
        await page.waitForTimeout(100);
    }
    check("a mouse drag still reorders the table's rows",
        mouseRows[1] === rowsBeforeMouse[2] && mouseRows[2] === rowsBeforeMouse[1],
        `${rowsBeforeMouse.join(",")} -> ${mouseRows.join(",")}`);
}
