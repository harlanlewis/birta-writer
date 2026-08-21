/**
 * The gutter handle under a coarse pointer (MAR-340) — the one place the
 * touch story can be checked at all, because jsdom has neither a layout
 * engine nor a PointerEvent, and Blink's touch-to-mouse compatibility layer
 * (which decides what a tap turns into) exists in no other harness we run.
 *
 * The gesture is driven through CDP `Input.dispatchTouchEvent`, so Blink's
 * real gesture recognizer runs: touch-action is honored, compatibility mouse
 * events are synthesized (or withheld) exactly as they are on hardware, and
 * `pointercancel` fires where a real finger would lose the gesture to a pan.
 *
 * What this cannot establish, and no emulation can: that a 26px handle is
 * hittable under a fingertip that covers it, what the on-screen keyboard does
 * to the viewport when the caret lands, and how a platform's own long-press
 * (Windows touch raises `contextmenu`) interleaves with the drag.
 */

/** Touch emulation plus the two gestures this suite needs. */
async function touchEmulation(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    // The media features a hoverless touchscreen reports. Nothing in the
    // product reads them today; they are set so this suite is the place a
    // future coarse-pointer rule would be exercised rather than assumed.
    await cdp.send("Emulation.setEmulatedMedia", {
        features: [
            { name: "pointer", value: "coarse" },
            { name: "any-pointer", value: "coarse" },
            { name: "hover", value: "none" },
            { name: "any-hover", value: "none" },
        ],
    });
    const send = (type, touchPoints) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
    const at = (p, id = 1) => ({ x: p.x, y: p.y, id });
    return {
        tap: async (x, y) => {
            await send("touchStart", [at({ x, y })]);
            await page.waitForTimeout(30);
            await send("touchEnd", []);
            await page.waitForTimeout(120);
        },
        /**
         * A finger drag held OPEN at `to`: the caller inspects the live
         * session, then releases, cancels, or lands a second finger.
         */
        drag: async (from, to, steps = 12) => {
            await send("touchStart", [at(from)]);
            for (let i = 1; i <= steps; i++) {
                await send("touchMove", [at({
                    x: from.x + ((to.x - from.x) * i) / steps,
                    y: from.y + ((to.y - from.y) * i) / steps,
                })]);
                await page.waitForTimeout(16);
            }
            const settle = async () => page.waitForTimeout(120);
            return {
                release: async () => { await send("touchEnd", []); await settle(); },
                /** The browser takes the gesture away mid-drag. */
                stolen: async () => { await send("touchCancel", []); await settle(); },
                /** A second finger arrives and sweeps elsewhere while the
                 * first still holds the handle. */
                secondFinger: async (sweepTo) => {
                    await send("touchStart", [at(to), at(sweepTo, 2)]);
                    await send("touchMove", [at(to), at({ x: sweepTo.x, y: sweepTo.y - 20 }, 2)]);
                    await settle();
                },
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

/** Centre, size and resting opacity of the gutter marker inside `text`'s block. */
function markerProbe(page, text) {
    return page.evaluate((t) => {
        const block = [...document.querySelectorAll(".ProseMirror > *")]
            .find((el) => el.textContent.includes(t));
        const m = block?.querySelector(".heading-fold-marker");
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            opacity: Number(getComputedStyle(m).opacity),
            touchAction: getComputedStyle(m).touchAction,
        };
    }, text);
}

function blockPoint(page, text, where) {
    return page.evaluate(({ t, w }) => {
        const el = [...document.querySelectorAll(".ProseMirror > p")]
            .find((e) => e.textContent.includes(t));
        const r = el.getBoundingClientRect();
        return w === "bottom"
            ? { x: r.x + r.width / 2, y: r.bottom - 2 }
            : { x: r.x + 20, y: r.y + r.height / 2 };
    }, { t: text, w: where ?? "inside" });
}

export async function run({ page, check, baseUrl }) {
    const touch = await touchEmulation(page);
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector('.heading-fold-marker[data-key="P"]', { timeout: 10000 });
    await page.waitForTimeout(500);

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

    // ── 1. The handle carries the touch-action that makes a finger drag
    //       possible at all: remove it and the drag checks below go red.
    const rest = await markerProbe(page, "Beta paragraph.");
    check("the gutter handle opts out of browser panning", rest.touchAction === "none", JSON.stringify(rest));

    // ── 2. Reaching the handle: a tap on the block reveals it. This is
    //       Blink's touch-compat hover, not a rule of ours — pinned here
    //       because the whole touch path depends on it being true.
    check("the handle rests invisible with nothing touched", rest.opacity === 0, String(rest.opacity));
    const betaBody = await blockPoint(page, "Beta paragraph.");
    await touch.tap(betaBody.x, betaBody.y);
    const revealed = await markerProbe(page, "Beta paragraph.");
    check("tapping a block reveals its handle", revealed.opacity > 0, String(revealed.opacity));

    // ── 3. Tapping the handle opens the block menu, and a menu row is
    //       operable by tap (the rows' hover only moves the highlight).
    await touch.tap(revealed.x, revealed.y);
    const menu = await page.$(".block-menu");
    check("tapping the handle opens the block menu", menu !== null);
    const dupRow = await page.evaluate(() => {
        const row = [...document.querySelectorAll(".block-menu-item")]
            .find((r) => /duplicate/i.test(r.textContent));
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check("the menu offers a Duplicate row", dupRow !== null);
    await touch.tap(dupRow.x, dupRow.y);
    const duplicated = await latestDoc(page, (d) => d.split("Beta paragraph.").length === 3);
    check("tapping a menu row runs its action", duplicated !== null);
    // Undo the duplicate so the drag check below reads a known document.
    await page.keyboard.press("Meta+z");
    await latestDoc(page, (d) => d.split("Beta paragraph.").length === 2);

    // ── 4. The gesture this ticket exists for: drag the handle by finger.
    const handle = await markerProbe(page, "Beta paragraph.");
    const gammaBottom = await blockPoint(page, "Gamma paragraph.", "bottom");
    const session = await touch.drag({ x: handle.x, y: handle.y }, gammaBottom);
    // The indicator is created lazily by the first session, so a drag the
    // browser stole leaves no element at all — read it defensively, or this
    // reports as a suite crash instead of the failure it is.
    const midDrag = await page.evaluate(() => {
        const line = document.querySelector(".block-drag-indicator");
        return {
            hasIndicatorElement: line !== null,
            indicatorShown: line !== null && getComputedStyle(line).display !== "none",
            dragging: document.body.classList.contains("block-dragging"),
        };
    });
    check(
        "a finger drag opens a live session with a drop line",
        midDrag.indicatorShown && midDrag.dragging,
        JSON.stringify(midDrag),
    );
    await session.release();
    const reordered = await latestDoc(page, (d) => d.indexOf("Gamma") < d.indexOf("Beta"));
    check("a finger drag reorders the document", reordered !== null);

    // ── 5. The drag must not leave residue: no menu from the release, and
    //       the click-suppression flag cleared so the NEXT tap still works.
    check("the finger drag did not also open the block menu", (await page.$(".block-menu")) === null);
    const flagCleared = await page.evaluate(() =>
        [...document.querySelectorAll(".heading-fold-marker")].every((m) => !m.dataset.dragged));
    check("the drag's click-suppression flag is cleared on release", flagCleared);
    const after = await markerProbe(page, "Beta paragraph.");
    await touch.tap(after.x, after.y);
    check("the handle is tappable again after a drag", (await page.$(".block-menu")) !== null);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // ── 6. A gesture the browser takes away (pointercancel) abandons the
    //       drag. Committing there would land the block wherever the finger
    //       happened to be when the system intervened.
    const beforeCancel = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").map((m) => m.content).pop());
    const alpha = await markerProbe(page, "Alpha paragraph.");
    const stolenSession = await touch.drag({ x: alpha.x, y: alpha.y }, gammaBottom);
    await stolenSession.stolen();
    const afterCancel = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").map((m) => m.content).pop());
    const cancelClean = await page.evaluate(() => ({
        dragging: document.body.classList.contains("block-dragging"),
        indicator: getComputedStyle(document.querySelector(".block-drag-indicator")).display === "none",
    }));
    check(
        "a stolen gesture abandons the drag without moving anything",
        afterCancel === beforeCancel && !cancelClean.dragging && cancelClean.indicator,
        JSON.stringify(cancelClean),
    );
    // A cancel produces no pointerup, so the click-suppression flag has to be
    // released by the cancel itself. Asserted on the flag rather than on a
    // following tap: the tap survives the leak (its own pointerup clears the
    // stranded one-shot), so only the flag itself distinguishes the two.
    const strandedFlags = await page.evaluate(() =>
        [...document.querySelectorAll(".heading-fold-marker")].filter((m) => m.dataset.dragged).length);
    check("a stolen gesture strands no click-suppression flag", strandedFlags === 0, String(strandedFlags));
    const alphaAgain = await markerProbe(page, "Alpha paragraph.");
    await touch.tap(alphaAgain.x, alphaAgain.y);
    check("the handle is tappable again after a stolen gesture", (await page.$(".block-menu")) !== null);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // ── 7. A second finger must not steer a drag the first one started. It
    //       arrives near the TOP of the document and sweeps there; the block
    //       must still land where finger ONE is aiming, at the bottom.
    //
    //       Only the targeting half is asserted. Which pointer's release ends
    //       the session cannot be driven here: CDP's touchEnd point list does
    //       not reliably keep one finger down while lifting the other, so the
    //       release always reads as the primary's. That half of the guard is
    //       unexercised, and this check must not be read as covering it.
    const alphaHandle = await markerProbe(page, "Alpha paragraph.");
    const gammaAim = await blockPoint(page, "Gamma paragraph.", "bottom");
    const twoFinger = await touch.drag({ x: alphaHandle.x, y: alphaHandle.y }, gammaAim);
    await twoFinger.secondFinger({ x: gammaAim.x, y: 80 });
    await twoFinger.release();
    const landedAtFingerOne = await latestDoc(page, (d) => d.indexOf("Alpha") > d.indexOf("Gamma"));
    const finalDoc = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update").map((m) => m.content).pop());
    check("a second finger does not steer the drag", landedAtFingerOne !== null, JSON.stringify(finalDoc));
}
