/**
 * Stale/broken living-calc answer cues (MAR-206) — real-browser truths jsdom
 * can't reach:
 *   - the cue decorations actually paint on the right numbers, and ONLY there
 *     (clean, constant-only, and `=` equations stay bare),
 *   - clicking a cue opens the findings popup with the promised actions,
 *   - [Update] / [Remove answer] write plain text through to the serialized
 *     markdown (the strongest fidelity check: nothing calc-specific leaks),
 *   - [Ignore] silences without touching the text,
 *   - an externalUpdate (a raw-editor edit) raises a cue WITHOUT the editor
 *     rewriting the synced content.
 */

/** The cue span whose text content is exactly `text`, or null. */
async function cueWithText(page, text) {
    return page.evaluateHandle((t) => {
        const spans = [...document.querySelectorAll(".calc-cue")];
        return spans.find((s) => s.textContent === t) ?? null;
    }, text);
}

/** Everything a check needs to read off the popup, captured in one page-side
 * pass so a dismissal can't land between two reads. */
const SNAPSHOT = `(() => {
    const popup = document.querySelector(".pf-popup");
    if (!popup) { return null; }
    const groups = [...popup.querySelectorAll(".pf-popup-group")];
    if (groups.length === 0) { return null; }
    return {
        tags: groups.map((g) => g.querySelector(".pf-popup-tag")?.textContent ?? ""),
        messages: groups.map((g) => g.querySelector(".pf-popup-message")?.textContent ?? ""),
        items: [...popup.querySelectorAll(".pf-popup-item")].map((b) => b.textContent),
    };
})()`;

/**
 * Click the cue carrying `text` and return a snapshot of the popup it opens,
 * or null. Retries the whole gesture, because the popup does not reliably
 * survive being opened: `proofread/popup.ts` closes it on ANY scroll (a
 * capture-phase `scroll` listener on `window`) and on any outside click, and
 * the document keeps scrolling for its own reasons — a decoration pass, the
 * scroll restore after the externalUpdate step. So the element can appear and
 * then vanish before a check reads it, at which point `$eval` throws and
 * `$$eval` quietly returns `[]`. Both of this suite's intermittent failures
 * were that, one round-trip apart.
 *
 * The snapshot is taken inside the same page evaluation that confirms the
 * popup is open, so there is no window between "it is there" and "read it".
 * Reopening is safe: the popup is a singleton that each open replaces.
 */
async function openCuePopup(page, text, tries = 4) {
    for (let attempt = 0; attempt < tries; attempt++) {
        const cue = (await cueWithText(page, text)).asElement();
        if (!cue) {
            await page.waitForTimeout(150);
            continue;
        }
        await cue.click();
        const snapshot = await page
            .waitForFunction(SNAPSHOT, undefined, { timeout: 1500 })
            .then((handle) => handle.jsonValue())
            .catch(() => null);
        if (snapshot) { return snapshot; }
    }
    return null;
}

/**
 * Open the cue's popup and press one of its buttons, retrying the whole
 * gesture. The button is found and clicked in ONE evaluation so nothing can
 * dismiss the popup between the two, and a dismissal before that simply costs
 * another attempt — waiting on the button alone could only wait for a popup
 * that was never coming back.
 */
async function actOnCue(page, text, label, tries = 4) {
    for (let attempt = 0; attempt < tries; attempt++) {
        const cue = (await cueWithText(page, text)).asElement();
        if (!cue) {
            await page.waitForTimeout(150);
            continue;
        }
        await cue.click();
        const clicked = await page
            .waitForFunction((l) => {
                const btn = [...document.querySelectorAll(".pf-popup-item")]
                    .find((b) => b.textContent === l);
                if (!btn) { return false; }
                btn.click();
                return true;
            }, label, { timeout: 1500 })
            .then(() => true)
            .catch(() => false);
        if (clicked) { return true; }
    }
    return false;
}

/** The last serialized markdown the webview posted (the autosave payload). */
async function lastPostedContent(page) {
    return page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length ? updates[updates.length - 1].content : null;
    });
}

export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // Cues settle in on idle after paint — that gating is deterministic only
    // under fake timers (calcStaleDeferred.test.ts pins it); in a real idle
    // browser the idle callback can legitimately fire within milliseconds of
    // mount, so no pre-idle assertion here.
    await page.waitForSelector(".calc-cue", { timeout: 10000 });
    await page.waitForTimeout(400);

    // ── Which numbers are cued, and as what ──
    const cues = await page.$$eval(".calc-cue", (els) =>
        els.map((el) => ({
            text: el.textContent,
            stale: el.classList.contains("calc-cue--stale"),
            broken: el.classList.contains("calc-cue--broken"),
        })),
    );
    check("exactly the four mismatched outside-premise answers are cued",
        cues.length === 4, JSON.stringify(cues));
    check("z*2 => 15 is stale (tint, no strike)",
        cues.some((c) => c.text === "15" && c.stale && !c.broken), JSON.stringify(cues));
    check("w+1 => 9 is stale",
        cues.some((c) => c.text === "9" && c.stale && !c.broken), JSON.stringify(cues));
    check("y*3 => 9 is broken (tint + strike)",
        cues.some((c) => c.text === "9" && c.broken), JSON.stringify(cues));
    const bodyText = await page.evaluate(() => document.body.textContent);
    check("clean, constant-only, and `=` equations carry no cue",
        bodyText.includes("2+3 => 99") && bodyText.includes("3+4 = 99")
        && !cues.some((c) => c.text === "99" || c.text === "8"),
        JSON.stringify(cues));

    // ── [Update] on the stale z*2 => 15 ──
    const stalePopup = await openCuePopup(page, "15");
    check("stale popup: tag + fresh value in the message",
        stalePopup?.tags[0] === "Stale" && stalePopup.messages[0].includes("20"),
        JSON.stringify(stalePopup));
    check("[Update] is pressed", await actOnCue(page, "15", "Update"), "never reached the button");
    await page.waitForTimeout(400);
    const afterUpdate = await lastPostedContent(page);
    check("[Update] writes the fresh value into the serialized markdown",
        afterUpdate !== null && afterUpdate.includes("z\\*2 => 20"),
        JSON.stringify(afterUpdate?.split("\n").find((l) => l.includes("z"))));
    check("[Update] leaves every other line untouched",
        afterUpdate !== null && afterUpdate.includes("x\\*2 => 8")
        && afterUpdate.includes("w+1 => 9") && afterUpdate.includes("3+4 = 99"),
        "diff leaked beyond the clicked answer");
    const cuesAfterUpdate = await page.$$eval(".calc-cue", (els) => els.map((el) => el.textContent));
    check("[Update] clears its cue instantly", !cuesAfterUpdate.includes("20"),
        JSON.stringify(cuesAfterUpdate));

    // ── [Ignore] on the stale w+1 => 9 ──
    check("[Ignore] is pressed", await actOnCue(page, "9", "Ignore"), "never reached the button");
    await page.waitForTimeout(300);
    const afterIgnore = await page.$$eval(".calc-cue--stale", (els) => els.map((el) => el.textContent));
    check("[Ignore] silences the equation without touching the text",
        !afterIgnore.includes("9") && (await lastPostedContent(page)).includes("w+1 => 9"),
        JSON.stringify(afterIgnore));

    // ── [Remove answer] on the broken y*3 => 9 ──
    const brokenCue = await cueWithText(page, "9");
    check("the broken cue remains after the stale ones are handled",
        (await brokenCue.asElement()?.evaluate((el) => el.classList.contains("calc-cue--broken"))) === true,
        "broken cue missing");
    const brokenPopup = await openCuePopup(page, "9");
    check("broken popup names the missing definition",
        brokenPopup?.messages.some((m) => m.includes("'y'")) === true, JSON.stringify(brokenPopup));
    check("[Remove answer] is pressed",
        await actOnCue(page, "9", "Remove answer"), "never reached the button");
    await page.waitForTimeout(400);
    const afterRemove = await lastPostedContent(page);
    check("[Remove answer] leaves the withdrawal shape `expr =>`",
        afterRemove !== null && afterRemove.includes("y\\*3 =>") && !afterRemove.includes("y\\*3 => 9"),
        JSON.stringify(afterRemove?.split("\n").find((l) => l.includes("y"))));

    // ── An external (raw-editor) edit raises a cue without a rewrite ──
    await page.evaluate(() => {
        const changed = window.__doc.replace("x = 4", "x = 5");
        window.postMessage({ type: "externalUpdate", content: changed + "\n", syncVersion: 2 }, "*");
    });
    await page.waitForFunction(
        () => [...document.querySelectorAll(".calc-cue--stale")].some((el) => el.textContent === "8"),
        { timeout: 5000 },
    );
    const syncedLine = await page.evaluate(() =>
        [...document.querySelectorAll(".milkdown p")]
            .map((p) => p.textContent).find((t) => t.includes("x*2")));
    check("the synced answer is cued but NOT rewritten (the file is the author's)",
        syncedLine === "x*2 => 8", JSON.stringify(syncedLine));

    // ── Popup merge: a cue inside a long-sentence proofread flag ──
    // Both plugins decorate the same span and drive the same singleton popup;
    // clicking the number must show ONE popup stacking cue findings first,
    // then the proofread findings — not whichever handler ran last.
    const overlapCue = await cueWithText(page, "7");
    check("the cue inside the flagged sentence exists", overlapCue.asElement() !== null, "no cue on 7");
    const overlapPopup = await openCuePopup(page, "7");
    check("one popup stacks the cue AND the overlapping proofread finding, cue first",
        (overlapPopup?.tags.length ?? 0) >= 2 && overlapPopup.tags[0] === "Stale",
        JSON.stringify(overlapPopup));
    await page.keyboard.press("Escape");

    check("no page errors", errors.length === 0, errors.join("; "));
}
