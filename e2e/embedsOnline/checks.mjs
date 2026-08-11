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

/** Cards per kind the fixture should produce (YouTube: live + dead-thumb). */
const EXPECTED_COUNTS = {
    youtube: 2, vimeo: 1, loom: 1, figma: 1, github: 1,
    googledrive: 1, googledocs: 1, googleslides: 1, googlesheets: 1,
    googlefile: 1, miro: 1, linear: 1,
};
const TOTAL_CARDS = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);

/** Every kind the fixture carries a bare link for, and what each promises. */
const PLAYERS = [
    { kind: "youtube", playerHost: "youtube-nocookie.com/embed/", thumbnail: true, aspect: "16 / 9" },
    { kind: "vimeo", playerHost: "player.vimeo.com/video/", thumbnail: false, aspect: "16 / 9" },
    { kind: "loom", playerHost: "loom.com/embed/", thumbnail: false, aspect: "16 / 9" },
    { kind: "figma", playerHost: "embed.figma.com/design/", thumbnail: false, aspect: "4 / 3" },
    { kind: "googledrive", playerHost: "drive.google.com/file/d/", thumbnail: false, aspect: "4 / 3" },
    { kind: "googledocs", playerHost: "docs.google.com/document/d/e/", thumbnail: false, aspect: "4 / 3" },
    { kind: "googleslides", playerHost: "docs.google.com/presentation/d/e/", thumbnail: false, aspect: "16 / 9" },
    { kind: "googlesheets", playerHost: "docs.google.com/spreadsheets/d/e/", thumbnail: false, aspect: "4 / 3" },
    { kind: "miro", playerHost: "miro.com/app/live-embed/", thumbnail: false, aspect: "4 / 3" },
];
const INFO_KIND = "github";
/** The Rung 0 kinds: URL-derived info cards with no iframe path at all. */
const INFO_KINDS = [INFO_KIND, "googlefile", "linear"];
const ALL_KINDS = [...PLAYERS.map((p) => p.kind), ...INFO_KINDS];

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
/** The fixture's dead-video id: its thumbnail 404s to pin the fallback state. */
const DEAD_ID = "aaaaaaaaaaa";

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
            // The dead id's thumbnail fails like a removed video's would. A 200
            // with undecodable bytes (not a 404) so the <img> fires `error`
            // without tripping the runner's console-error check — the state
            // under test is the card's reaction, not the transport.
            if (url.pathname.includes(`/vi/${DEAD_ID}/`)) {
                return route.fulfill({ status: 200, contentType: "image/jpeg", body: Buffer.from("dead") });
            }
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
    // total) says WHICH line misbehaved when this fails. YouTube carries two
    // bare links: the live video and the dead-thumbnail one (fallback state).
    for (const kind of ALL_KINDS) {
        const n = kindsFound.filter((k) => k === kind).length;
        const want = EXPECTED_COUNTS[kind];
        check(`exactly ${want} ${kind} card(s) render`, n === want, `${n} ${kind} cards`);
    }
    check(
        "a titled [label](url) link and an unknown host render no card",
        kindsFound.length === TOTAL_CARDS,
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

    // ── Error state: a dead thumbnail degrades to the branded facade ──
    // The second YouTube card's thumbnail fails to decode (see
    // stubProviderRequests); it must show the branded fallback — mark + play —
    // never a blank frame. The swap is async (image error event): wait for it.
    const fallbackReady = await page
        .waitForFunction((sel) => {
            const dead = [...document.querySelectorAll(sel)][1];
            return !!dead && !dead.querySelector(".embed-card__thumb") &&
                !!dead.querySelector(".embed-card__brand");
        }, cardFor("youtube"), { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    const fallback = await page.evaluate((sel) => {
        const dead = [...document.querySelectorAll(sel)][1];
        return dead ? {
            hasThumb: !!dead.querySelector(".embed-card__thumb"),
            hasBrand: !!dead.querySelector(".embed-card__brand"),
            hasPlay: !!dead.querySelector(".embed-card__play"),
        } : null;
    }, cardFor("youtube"));
    check(
        "a dead thumbnail degrades to the branded facade with play intact",
        fallbackReady && !!fallback && fallback.hasBrand && fallback.hasPlay,
        JSON.stringify(fallback),
    );

    // ── The identity strip: title + URL resident, no hover required ──
    const meta = await page.evaluate((sels) => {
        const [loomSel, ytSel] = sels;
        const strip = (sel) => {
            const url = document.querySelector(`${sel} .embed-card__meta-url`);
            return url ? {
                urlText: url.textContent,
                tooltip: url.title,
                visible: getComputedStyle(url).display !== "none",
            } : null;
        };
        return { loom: strip(loomSel), yt: strip(ytSel) };
    }, [cardFor("loom"), cardFor("youtube")]);
    check(
        "the loom facade shows its URL resident (no hover)",
        !!meta.loom && meta.loom.visible && meta.loom.urlText.includes("loom.com/share/"),
        JSON.stringify(meta.loom),
    );
    check(
        "the youtube facade shows its URL resident too",
        // The strip shows the DOCUMENT's own URL (the fixture uses youtu.be),
        // not a canonicalized rewrite of it.
        !!meta.yt && meta.yt.visible && meta.yt.urlText.includes("youtu.be/"),
        JSON.stringify(meta.yt),
    );

    // ── Metadata: the title row fills with the resolved oEmbed title ──
    // The plugin's idle pass asks the (stubbed) extension once per kind:id;
    // the reply fills the title row ABOVE the URL — both stay visible.
    const titled = await page
        .waitForFunction((sel) =>
            document.querySelector(`${sel} .embed-card__meta-title`)?.textContent === "Stub title",
            cardFor("loom"), { timeout: 8000 })
        .then(() => true).catch(() => false);
    check("the loom title row fills with the resolved title", titled);
    const urlStillThere = await page.evaluate((sel) =>
        (document.querySelector(`${sel} .embed-card__meta-url`)?.textContent ?? "").includes("loom.com/share/"),
        cardFor("loom"));
    check("the URL row survives the title arriving", urlStillThere);
    for (const kind of INFO_KINDS) {
        const hasStrip = await page.evaluate((sel) =>
            !!document.querySelector(`${sel} .embed-card__meta`), cardFor(kind));
        check(`the ${kind} card asks for no metadata and shows no strip`, !hasStrip);
    }

    // ── The info cards: request-free, and no path to an iframe ──
    for (const kind of INFO_KINDS) {
        const info = await page.evaluate((sel) => {
            const card = document.querySelector(sel);
            return {
                isInfo: !!card?.classList.contains("embed-card--info"),
                hasPlay: !!card?.querySelector(".embed-card__play"),
                hasFrame: !!card?.querySelector(".embed-card__frame"),
            };
        }, cardFor(kind));
        check(`the ${kind} card is the info variant`, info.isInfo);
        check(`the ${kind} card has no activate button`, !info.hasPlay);
        check(`the ${kind} card has no player frame`, !info.hasFrame);
    }
    const infoTitles = await page.evaluate((sels) => {
        const read = (sel) => ({
            title: document.querySelector(`${sel} .embed-card__title`)?.textContent ?? null,
            detail: document.querySelector(`${sel} .embed-card__detail`)?.textContent ?? null,
        });
        return { github: read(sels.github), googlefile: read(sels.googlefile), linear: read(sels.linear) };
    }, { github: cardFor("github"), googlefile: cardFor("googlefile"), linear: cardFor("linear") });
    check(
        "the github card names owner/repo from the URL",
        infoTitles.github.title === "microsoft/vscode",
        String(infoTitles.github.title),
    );
    check(
        "the github card details the pull request from the URL",
        (infoTitles.github.detail ?? "").includes("12345"),
        String(infoTitles.github.detail),
    );
    check(
        "the ordinary Google /edit URL gets the Rung 0 card naming its product",
        infoTitles.googlefile.title === "Google Docs" &&
            infoTitles.googlefile.detail === "Not published to the web",
        JSON.stringify(infoTitles.googlefile),
    );
    check(
        "the linear card shows the issue key and the humanized slug",
        infoTitles.linear.title === "MAR-186" &&
            infoTitles.linear.detail === "embed provider roadmap",
        JSON.stringify(infoTitles.linear),
    );

    // ── At rest the stop control is really hidden (the [hidden] attribute
    // must beat the class's display — it didn't, and a do-nothing X showed) ──
    const stopHiddenAtRest = await page.evaluate((sel) => {
        const stop = document.querySelector(`${sel} .embed-card__stop`);
        return stop ? getComputedStyle(stop).display === "none" : null;
    }, cardFor("loom"));
    check("the stop control is invisible until something is playing", stopHiddenAtRest === true, String(stopHiddenAtRest));

    // ── Click semantics: the identity strip SELECTS (and destroys nothing) ──
    // The media area activates (pinned below); the text strip is the edit
    // surface — clicking it selects the card and raises the palette.
    await page.locator(`${cardFor("youtube")} .embed-card__meta`).first().click();
    await page.waitForTimeout(250);
    const afterMetaClick = await page.evaluate((sel) => ({
        cards: document.querySelectorAll(sel).length,
        selected: document.querySelector(".embed-host--selected .embed-card")?.dataset.embedKind ?? null,
        playing: !!document.querySelector(`${sel}.embed-card--playing`),
    }), CARD);
    check(
        "clicking the identity strip selects the card without activating it",
        afterMetaClick.cards === TOTAL_CARDS && afterMetaClick.selected === "youtube" && !afterMetaClick.playing,
        JSON.stringify(afterMetaClick),
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
    // The request-free cards stay request-free even after their neighbours load.
    for (const kind of INFO_KINDS) {
        const infoIframe = await page.evaluate((sel) =>
            !!document.querySelector(`${sel} iframe`), cardFor(kind));
        check(`the ${kind} card never gains an iframe`, !infoIframe);
    }

    // ── A playing card survives an edit elsewhere ──
    // The widget key is position-independent (kind:id:ordinal), so typing above
    // must not re-key — and therefore not rebuild — the cards below. Before
    // that, typing one character in the heading reset every playing iframe to
    // its facade (found 2026-07-27).
    // Locator click, not raw mouse coords: activating the players scrolled the
    // page, so the heading's viewport position is stale/off-screen by now.
    // Re-activate the two cards these checks ride on, from the top of the
    // document, so both sit inside the gutter's scroll window when the edit
    // lands. The activation marathon above scrolled the full fixture, and
    // MAR-215's windowed gutter chrome rebuilds any block that crosses the
    // window boundary — which tears down a playing embed's iframe (the widget
    // is recreated at its facade). That is a real, pre-existing defect in tall
    // documents, reproducible on the shipped five-provider table by spreading
    // the old fixture with filler prose; it is reported as its own issue. The
    // invariant THIS check pins — an edit in another block must not re-key the
    // card below it — is exercised exactly as before.
    for (const kind of ["youtube", "loom"]) {
        const play = await page.$(`${cardFor(kind)} .embed-card__play`);
        if (play) {
            await play.click();
            await page.waitForTimeout(200);
        }
    }
    await page.locator(".ProseMirror h1").first().click({ position: { x: 60, y: 10 } });
    await page.waitForTimeout(150);
    await page.keyboard.type("x");
    await page.waitForTimeout(300);
    const headingText = await page.evaluate(() => document.querySelector(".ProseMirror h1")?.textContent ?? "");
    check("typing reached the heading (the edit really happened)", headingText.includes("x"), headingText);
    const playingAfterEdit = await page.evaluate((sel) =>
        !!document.querySelector(`${sel} .embed-card__iframe`), cardFor("youtube"));
    check("a playing iframe survives typing in a paragraph above", playingAfterEdit);

    // The identity strip stays visible WHILE playing — below the frame, not an
    // in-frame overlay the player replaces.
    const stripWhilePlaying = await page.evaluate((sel) => {
        const meta = document.querySelector(`${sel} .embed-card__meta`);
        return meta ? getComputedStyle(meta).display !== "none" && getComputedStyle(meta).visibility === "visible" : false;
    }, cardFor("youtube"));
    check("the identity strip stays visible while the player runs", stripWhilePlaying);

    // ── Stop restores the facade, and the external button survived play ──
    const loomState = await page.evaluate((sel) => {
        const card = document.querySelector(sel);
        return {
            external: !!card?.querySelector(".embed-card__external"),
            stopHidden: card?.querySelector(".embed-card__stop")?.hidden ?? null,
        };
    }, cardFor("loom"));
    check("the external button survives play", loomState.external, JSON.stringify(loomState));
    check("the stop button is visible while playing", loomState.stopHidden === false, JSON.stringify(loomState));

    await page.evaluate((sel) => {
        document.querySelector(`${sel} .embed-card__stop`)?.click();
    }, cardFor("loom"));
    await page.waitForTimeout(200);
    const afterStop = await page.evaluate((sel) => {
        const card = document.querySelector(sel);
        return {
            iframe: !!card?.querySelector("iframe"),
            brand: !!card?.querySelector(".embed-card__brand"),
            play: !!card?.querySelector(".embed-card__play"),
        };
    }, cardFor("loom"));
    check(
        "stop removes the player and restores the facade",
        !afterStop.iframe && afterStop.brand && afterStop.play,
        JSON.stringify(afterStop),
    );

    // ── Keyboard traversal: every card is an arrow stop (MAR-187) ──
    // Before this model, hidden link text gave the caret nothing to land on
    // and arrows skipped every embed (sequential cards were unreachable).
    const selectedKind = () => page.evaluate(() =>
        document.querySelector(".embed-host--selected .embed-card")?.dataset.embedKind ?? null);
    await page.locator(".ProseMirror h1").first().click({ position: { x: 60, y: 10 } });
    await page.keyboard.press("End");
    await page.waitForTimeout(150);
    const walk = [];
    for (let i = 0; i < 6; i++) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(120);
        walk.push(await selectedKind());
    }
    check(
        "ArrowDown stops at every card in turn",
        JSON.stringify(walk) === JSON.stringify(["youtube", "youtube", "loom", "figma", "github", "vimeo"]),
        JSON.stringify(walk),
    );
    // One more down exits into the titled-link paragraph; ArrowUp re-selects.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    const exited = await selectedKind();
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(120);
    const reentered = await selectedKind();
    check(
        "arrows exit past the last card and re-enter it",
        exited === null && reentered === "vimeo",
        `exited: ${exited}, reentered: ${reentered}`,
    );

    // ── Backspace selects the card before deleting ──
    await page.keyboard.press("ArrowDown"); // caret back into the titled-link paragraph
    await page.waitForTimeout(120);
    await page.keyboard.press("Home").catch(() => {});
    const docBefore = await page.evaluate(() => document.querySelectorAll(".embed-card").length);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(120);
    const backspaceSelected = await selectedKind();
    const docAfter = await page.evaluate(() => document.querySelectorAll(".embed-card").length);
    check(
        "Backspace after a card selects it without deleting",
        backspaceSelected === "vimeo" && docAfter === docBefore,
        `selected: ${backspaceSelected}, cards ${docBefore}→${docAfter}`,
    );

    // ── The palette: select a card → palette; edit the URL through it ──
    const paletteVisible = await page
        .waitForSelector(".embed-palette--visible", { timeout: 5000 })
        .then(() => true).catch(() => false);
    check("selecting a card shows the editor palette", paletteVisible);
    const paletteUrl = await page.evaluate(() =>
        document.querySelector(".embed-palette__url")?.value ?? null);
    check(
        "the palette shows the card's editable URL",
        paletteUrl === "https://vimeo.com/1084537",
        String(paletteUrl),
    );

    // The whole facade is the activate target: a click on the (restored)
    // loom facade body — nowhere near the play pill — loads the player.
    await page.locator(`${cardFor("loom")} .embed-card__stage`).first().click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(250);
    const facadeActivated = await page.evaluate((sel) =>
        !!document.querySelector(`${sel} iframe`), cardFor("loom"));
    check("clicking anywhere on the facade activates the player", facadeActivated);
    await page.evaluate((sel) => {
        document.querySelector(`${sel} .embed-card__stop`)?.click();
    }, cardFor("loom"));
    await page.waitForTimeout(200);

    // Click-to-select: the loom card's identity strip.
    await page.locator(`${cardFor("loom")} .embed-card__meta`).first().click();
    await page.waitForTimeout(200);
    check("clicking a card's identity strip selects it", (await selectedKind()) === "loom");

    // Edit the URL via the palette: a new Loom id, applied with Enter.
    const newLoom = "https://www.loom.com/share/ffffffffffffffffffffffffffffffff";
    await page.evaluate((url) => {
        const input = document.querySelector(".embed-palette__url");
        input.focus();
        input.value = url;
    }, newLoom);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const editedState = await page.evaluate((url) => ({
        stillSelected: !!document.querySelector(".embed-host--selected .embed-card[data-embed-kind='loom']"),
        // The rebuilt card carries the NEW url in its identity strip.
        tooltipHasNewId: (document.querySelector(".embed-card[data-embed-kind='loom'] .embed-card__meta-url")?.title ?? "").includes("ffff"),
        posted: (window.__posted ?? []).some((m) => m.type === "update" && typeof m.content === "string" && m.content.includes(url)),
    }), newLoom);
    check(
        "a palette URL edit rewrites the link, keeps the card selected, and serializes",
        editedState.stillSelected && editedState.tooltipHasNewId && editedState.posted,
        JSON.stringify(editedState),
    );
    // Park the selection in prose so the reveal check below starts clean.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);

    // ── Metadata dedupe held across every edit above ──
    // The session store asks once per kind:id no matter how many doc changes
    // re-ran the idle pass; the palette's URL edit added ONE new id (one ask).
    const metaAsks = await page.evaluate(() =>
        (window.__posted ?? []).filter((m) => m.type === "resolveEmbedMeta").map((m) => m.url));
    const duplicates = metaAsks.filter((u, i) => metaAsks.indexOf(u) !== i);
    check(
        "each embed URL is asked for metadata exactly once per session",
        metaAsks.length >= 4 && duplicates.length === 0,
        `${metaAsks.length} asks, duplicates: ${duplicates.join(", ") || "none"}`,
    );

    // ── The card's own edit + show-as-link controls ──
    await page.locator(`${cardFor("figma")} .embed-card__edit`).first().click();
    await page.waitForTimeout(300);
    const editState = await page.evaluate(() => ({
        selected: document.querySelector(".embed-host--selected .embed-card")?.dataset.embedKind ?? null,
        focusedUrl: document.activeElement?.classList.contains("embed-palette__url") ?? false,
    }));
    check(
        "the card's edit control selects it and focuses the palette URL",
        editState.selected === "figma" && editState.focusedUrl,
        JSON.stringify(editState),
    );
    // While the palette is open it REPLACES the identity strip (visibility,
    // not display — the box holds its space so nothing jumps).
    const stripWhileEditing = await page.evaluate((sel) => {
        const meta = document.querySelector(`${sel} .embed-card__meta`);
        return meta ? getComputedStyle(meta).visibility : null;
    }, cardFor("figma"));
    check("the palette replaces the identity strip while open", stripWhileEditing === "hidden", String(stripWhileEditing));
    // The control is a toggle: a second press closes the palette.
    await page.locator(`${cardFor("figma")} .embed-card__edit`).first().click();
    await page.waitForTimeout(200);
    const paletteClosed = await page.evaluate(() =>
        !document.querySelector(".embed-palette--visible"));
    check("a second press of the edit control closes the palette", paletteClosed);
    // Park the caret in prose (Escape would escalate the NodeSelection into a
    // block-range selection, which rightly reveals the card as raw text).
    await page.locator(".ProseMirror h1").first().click({ position: { x: 60, y: 10 } });
    await page.waitForTimeout(150);

    const cardsBeforeConvert = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD);
    // Convert the dead-thumbnail youtube card (second of its kind) to a link.
    await page.evaluate(() => {
        const dead = [...document.querySelectorAll(".embed-card[data-embed-kind='youtube']")][1];
        dead?.querySelector(".embed-card__aslink")?.click();
    });
    await page.waitForTimeout(400);
    const convertState = await page.evaluate((sel) => ({
        cards: document.querySelectorAll(sel).length,
        posted: (window.__posted ?? []).some((m) => m.type === "update" && typeof m.content === "string" &&
            m.content.includes("[youtu.be/aaaaaaaaaaa](https://youtu.be/aaaaaaaaaaa)")),
    }), CARD);
    check(
        "the card's show-as-link control converts the embed to a labeled link",
        convertState.cards === cardsBeforeConvert - 1 && convertState.posted,
        JSON.stringify(convertState),
    );

    // ── And back again: the link popup re-embeds an eligible link ──
    const converted = page.locator("a", { hasText: "youtu.be/aaaaaaaaaaa" }).first();
    await converted.hover();
    const popupShown = await page
        .waitForSelector(".lp-root .lp-btn-embed", { timeout: 5000 })
        .then(() => true).catch(() => false);
    const embedBtnVisible = popupShown && await page.evaluate(() => {
        const btn = document.querySelector(".lp-root .lp-btn-embed");
        return btn ? getComputedStyle(btn).display !== "none" : false;
    });
    check("the link popup offers Show as embed for a whole-paragraph provider link", embedBtnVisible);
    if (embedBtnVisible) {
        await page.locator(".lp-root .lp-btn-embed").click();
        const cardBack = await page
            .waitForFunction((n) => document.querySelectorAll(".embed-card").length === n,
                cardsBeforeConvert, { timeout: 5000 })
            .then(() => true).catch(() => false);
        const diag = await page.evaluate(() => ({
            cards: document.querySelectorAll(".embed-card").length,
            bareRestored: (window.__posted ?? []).some((m) => m.type === "update" && typeof m.content === "string" &&
                /\n<?https:\/\/youtu\.be\/aaaaaaaaaaa>?\n/.test(m.content)),
        }));
        check("Show as embed converts the link back to a card", cardBack, JSON.stringify(diag));
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
    const revealed = await page.evaluate(() => {
        const a = [...document.querySelectorAll(".ProseMirror a")]
            .find((el) => el.textContent.includes("youtu.be"));
        return !!a && getComputedStyle(a).display !== "none";
    });
    check("the caret in the paragraph reveals the raw link", revealed);
}
