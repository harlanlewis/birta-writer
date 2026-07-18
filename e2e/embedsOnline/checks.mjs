/**
 * URL embeds with the network master switch ON — verified against the REAL
 * bundle. The sibling notesFeatures suite pins the OFF case (nothing renders,
 * nothing is requested); everything below only exists once the card is on
 * screen, so none of it is reachable there:
 *
 *   - a bare provider link on its own line renders a card, and the raw <a> is
 *     hidden behind it;
 *   - a TITLED link to the same video renders nothing (the trigger is
 *     text === href, which is also what keeps unfurl and embeds from
 *     cancelling each other);
 *   - clicking the card leaves it in place, and clicking play then swaps the
 *     facade for the privacy-mode iframe. Note this pair passes with or without
 *     the card's mousedown guard — the browser will not put a caret inside a
 *     contenteditable="false" widget, so reveal-on-caret never fires on a card
 *     click. It is pinned as the behavior users depend on, NOT as a guard
 *     regression test; the guard itself is pinned by unit tests;
 *   - putting the caret in the paragraph still reveals the raw link to edit.
 */

const CARD = ".embed-card";
const HOST = ".embed-host";

export async function run({ page, check, baseUrl }) {
    await page.goto(baseUrl);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    // The first embed pass is armed on idle after paint, and the card builder is
    // a lazy chunk — wait for the card itself rather than a fixed delay.
    const appeared = await page
        .waitForSelector(CARD, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
    check("a bare provider link renders a card with network on", appeared, "no .embed-card");
    if (!appeared) { return; }

    // Exactly one card: the titled link to the same video must not get one.
    const cardCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD);
    check("a titled [label](url) link renders no card", cardCount === 1, `${cardCount} cards`);

    // The raw link is hidden behind the card (CSS on the host node decoration).
    const rawHidden = await page.evaluate((sel) => {
        const a = document.querySelector(`${sel} a`);
        return !a || getComputedStyle(a).display === "none";
    }, HOST);
    check("the raw link is hidden behind the card", rawHidden);

    // ── The click guard ──
    // Click the card's thumbnail area, away from either button.
    const box = await page.locator(`${CARD}__frame`).first().boundingBox()
        .catch(() => null) ?? await page.locator(CARD).first().boundingBox();
    await page.mouse.click(box.x + 8, box.y + 8);
    await page.waitForTimeout(250);
    const survived = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD);
    check("clicking the card does not destroy it", survived === 1, `${survived} cards after click`);

    // ── Play swaps in the player ──
    const playBtn = await page.$(".embed-card__play");
    check("the card has a play button", !!playBtn);
    if (playBtn) {
        await playBtn.click();
        await page.waitForTimeout(250);
        const iframeSrc = await page.evaluate(() => {
            const f = document.querySelector(".embed-card__iframe");
            return f ? f.getAttribute("src") : null;
        });
        check(
            "play swaps the facade for the nocookie player",
            !!iframeSrc && iframeSrc.includes("youtube-nocookie.com/embed/"),
            String(iframeSrc),
        );
    }

    // ── Reveal-on-caret still works ──
    // Click into the paragraph text region: the card drops and the link shows.
    await page.evaluate(() => {
        const p = [...document.querySelectorAll(".ProseMirror p")]
            .find((el) => el.querySelector("a"));
        const range = document.createRange();
        range.setStart(p, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        p.dispatchEvent(new Event("focus", { bubbles: true }));
        document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForTimeout(250);
    const revealed = await page.evaluate((sel) => {
        const a = [...document.querySelectorAll(".ProseMirror a")]
            .find((el) => el.textContent.includes("youtu.be"));
        return !!a && getComputedStyle(a).display !== "none";
    }, HOST);
    check("the caret in the paragraph reveals the raw link", revealed);
}
