/**
 * URL embeds with the network master switch ON — verified against the REAL
 * bundle, one line per provider in the table. The sibling notesFeatures suite
 * pins the OFF case (nothing renders, nothing is requested); everything below
 * only exists once a card is on screen, so none of it is reachable there:
 *
 *   - every bare provider link on its own line renders a card of ITS OWN kind,
 *     and the raw <a> is hidden behind it;
 *   - a TITLED link and a bare link to an unknown host render nothing (the
 *     trigger is text === href on a recognized provider, which is also what
 *     keeps unfurl and embeds from cancelling each other);
 *   - the facade each provider promises is the one that renders: YouTube
 *     fetches a thumbnail, Loom and Figma show a local branded mark and fetch
 *     NOTHING until you click, and GitHub is a request-free info card with no
 *     play button and no code path to an iframe;
 *   - clicking a card leaves it in place, and clicking activate swaps that
 *     card's facade for the provider's own player URL. Note the click pair
 *     passes with or without the card's mousedown guard — the browser will not
 *     put a caret inside a contenteditable="false" widget, so reveal-on-caret
 *     never fires on a card click. It is pinned as the behavior users depend
 *     on, NOT as a guard regression test; the guard itself is pinned by unit
 *     tests;
 *   - putting the caret in the paragraph still reveals the raw link to edit.
 *
 * Assertions are keyed off `data-embed-kind`, never off a card COUNT — the
 * previous version asserted `cardCount === 1` to prove the titled link stays
 * plain, which was correct for a single-provider world but made adding the
 * second provider fail the suite. Adding a provider now means one line in
 * index.html plus (if it is a player) one row in PLAYERS below.
 */

const CARD = ".embed-card";
const HOST = ".embed-host";

/** Every kind the fixture carries a bare link for, and what each promises. */
const PLAYERS = [
    { kind: "youtube", playerHost: "youtube-nocookie.com/embed/", thumbnail: true, aspect: "16 / 9" },
    { kind: "loom", playerHost: "loom.com/embed/", thumbnail: false, aspect: "16 / 9" },
    { kind: "figma", playerHost: "embed.figma.com/design/", thumbnail: false, aspect: "4 / 3" },
];
const INFO_KIND = "github";
const ALL_KINDS = [...PLAYERS.map((p) => p.kind), INFO_KIND];

/** `.embed-card[data-embed-kind="…"]`, the per-provider handle. */
const cardFor = (kind) => `${CARD}[data-embed-kind="${kind}"]`;

/**
 * Stub every off-origin request. The suite asserts what the editor ASKS for —
 * the thumbnail `src`, the player `src` it swaps in — never what a provider
 * answers, so the real fetch buys nothing and costs determinism: the fixture's
 * Loom/Figma ids are synthetic and 404, and even the real YouTube ids make the
 * runner's "no page errors" check depend on the network being up and those
 * URLs still resolving. Requests still leave the editor exactly as in
 * production; they just terminate here.
 */
async function stubProviderRequests(page) {
    // A 1×1 transparent GIF — enough for an <img> to decode without a network.
    const PIXEL = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
    );
    await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1" || url.protocol === "data:") {
            return route.continue();
        }
        const type = route.request().resourceType();
        if (type === "image") {
            return route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL });
        }
        return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" });
    });
}

export async function run({ page, check, baseUrl }) {
    await stubProviderRequests(page);
    await page.goto(baseUrl);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    // The first embed pass is armed on idle after paint, and the card builder is
    // a lazy chunk — wait for the cards themselves rather than a fixed delay.
    // One pass builds all of them, so waiting for the last kind is enough.
    const appeared = await page
        .waitForFunction(
            (kinds) => kinds.every((k) => document.querySelector(`.embed-card[data-embed-kind="${k}"]`)),
            ALL_KINDS,
            { timeout: 10000 },
        )
        .then(() => true)
        .catch(() => false);

    const kindsFound = await page.evaluate((sel) =>
        [...document.querySelectorAll(sel)].map((el) => el.dataset.embedKind), CARD);
    check(
        "every bare provider link renders a card of its own kind",
        appeared,
        `expected ${ALL_KINDS.join(", ")} — got ${kindsFound.join(", ") || "none"}`,
    );
    if (!appeared) { return; }

    // One card per bare provider link and no more: the titled link and the
    // unknown-host link must both stay plain. Counting by kind (not a bare
    // total) says WHICH line misbehaved when this fails.
    for (const kind of ALL_KINDS) {
        const n = kindsFound.filter((k) => k === kind).length;
        check(`exactly one ${kind} card renders`, n === 1, `${n} ${kind} cards`);
    }
    check(
        "a titled [label](url) link and an unknown host render no card",
        kindsFound.length === ALL_KINDS.length,
        `${kindsFound.length} cards: ${kindsFound.join(", ")}`,
    );

    // The raw link is hidden behind every card (CSS on the host node decoration).
    const rawShown = await page.evaluate((sel) =>
        [...document.querySelectorAll(`${sel} a`)]
            .filter((a) => getComputedStyle(a).display !== "none")
            .map((a) => a.textContent), HOST);
    check("the raw link is hidden behind every card", rawShown.length === 0, rawShown.join(", "));

    // ── Each facade is the one its provider promises ──
    for (const { kind, thumbnail, aspect } of PLAYERS) {
        const facade = await page.evaluate((sel) => {
            const card = document.querySelector(sel);
            const thumb = card?.querySelector(".embed-card__thumb");
            return {
                hasThumb: !!thumb,
                thumbSrc: thumb?.getAttribute("src") ?? null,
                hasBrand: !!card?.querySelector(".embed-card__brand"),
                hasPlay: !!card?.querySelector(".embed-card__play"),
                aspect: card?.style.getPropertyValue("--embed-aspect").trim() ?? null,
            };
        }, cardFor(kind));

        check(`the ${kind} card has an activate button`, facade.hasPlay);
        check(
            `the ${kind} card carries its provider's aspect`,
            facade.aspect === aspect,
            `--embed-aspect: ${facade.aspect}`,
        );
        if (thumbnail) {
            check(
                `the ${kind} facade is a fetched thumbnail`,
                facade.hasThumb && /ytimg\.com/.test(facade.thumbSrc ?? ""),
                String(facade.thumbSrc),
            );
        } else {
            // The offline promise: a facade with no thumbnail requests nothing
            // at render, so the branded mark must be what renders instead.
            check(
                `the ${kind} facade is branded and fetches nothing`,
                facade.hasBrand && !facade.hasThumb,
                `brand: ${facade.hasBrand}, thumb: ${facade.hasThumb}`,
            );
        }
    }

    // ── The GitHub info card: request-free, and no path to an iframe ──
    const info = await page.evaluate((sel) => {
        const card = document.querySelector(sel);
        return {
            isInfo: !!card?.classList.contains("embed-card--info"),
            hasPlay: !!card?.querySelector(".embed-card__play"),
            hasFrame: !!card?.querySelector(".embed-card__frame"),
            title: card?.querySelector(".embed-card__title")?.textContent ?? null,
            detail: card?.querySelector(".embed-card__detail")?.textContent ?? null,
        };
    }, cardFor(INFO_KIND));
    check("the github card is the info variant", info.isInfo);
    check("the github card has no activate button", !info.hasPlay);
    check("the github card has no player frame", !info.hasFrame);
    check("the github card names owner/repo from the URL", info.title === "microsoft/vscode", String(info.title));
    check(
        "the github card details the pull request from the URL",
        (info.detail ?? "").includes("12345"),
        String(info.detail),
    );

    // ── The click guard ──
    // Click a card's facade area, away from either button.
    const box = await page.locator(`${cardFor("youtube")} .embed-card__frame`).first().boundingBox()
        .catch(() => null) ?? await page.locator(cardFor("youtube")).first().boundingBox();
    await page.mouse.click(box.x + 8, box.y + 8);
    await page.waitForTimeout(250);
    const survived = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD);
    check(
        "clicking the card does not destroy it",
        survived === ALL_KINDS.length,
        `${survived} cards after click`,
    );

    // ── Activate swaps in that provider's player, and only that card's ──
    for (const { kind, playerHost } of PLAYERS) {
        const playBtn = await page.$(`${cardFor(kind)} .embed-card__play`);
        if (!playBtn) { continue; }
        await playBtn.click();
        await page.waitForTimeout(250);
        const iframeSrc = await page.evaluate((sel) => {
            const f = document.querySelector(`${sel} .embed-card__iframe`);
            return f ? f.getAttribute("src") : null;
        }, cardFor(kind));
        check(
            `activating the ${kind} card swaps in its own player`,
            !!iframeSrc && iframeSrc.includes(playerHost),
            String(iframeSrc),
        );
    }
    // The request-free card stays request-free even after its neighbours load.
    const infoIframe = await page.evaluate((sel) =>
        !!document.querySelector(`${sel} iframe`), cardFor(INFO_KIND));
    check("the github card never gains an iframe", !infoIframe);

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
    const revealed = await page.evaluate(() => {
        const a = [...document.querySelectorAll(".ProseMirror a")]
            .find((el) => el.textContent.includes("youtu.be"));
        return !!a && getComputedStyle(a).display !== "none";
    });
    check("the caret in the paragraph reveals the raw link", revealed);
}
