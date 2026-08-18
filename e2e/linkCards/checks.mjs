/**
 * Link cards (MAR-185) end-to-end, against the production bundle with the
 * master switch and the link-card default ON, and the host's page fetch
 * stubbed. What can only be seen here: the cards render on the idle arm, the
 * host is asked once per URL, the reply fills title and description as text,
 * the provider link keeps its provider card, the mid-prose URL never cards,
 * the block menu's per-link choice repaints, "open" routes through the host,
 * and the document sent to the host never changes through any of it.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // The card pass is armed on idle after first paint, and the metadata
    // queue on a second idle; give both room.
    await page.waitForSelector(".embed-card--link", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);

    const cards = () => page.$$eval(".embed-card", (els) => els.map((el) => ({
        kind: el.dataset.embedKind,
        site: el.querySelector(".embed-card__site")?.textContent ?? null,
        title: el.querySelector(".embed-card__title")?.textContent ?? null,
        description: el.querySelector(".embed-card__description")?.textContent ?? null,
        html: el.querySelector(".embed-card__title")?.innerHTML ?? null,
    })));
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

    // ── 1. What rendered ──
    let all = await cards();
    const links = all.filter((c) => c.kind === "linkCard");
    check("two lone links (bare and labelled) rendered as link cards", links.length === 2, JSON.stringify(all));
    check("the YouTube link kept its provider card", all.some((c) => c.kind === "youtube"), JSON.stringify(all.map((c) => c.kind)));
    check("the mid-prose URL is not a card", all.length === 3, JSON.stringify(all.map((c) => c.kind)));

    // ── 2. The host was asked once per URL, and the reply filled the card as text ──
    const asks = await posted("resolveLinkCard");
    check("the host was asked once per link", asks.length === 2 && new Set(asks.map((m) => m.url)).size === 2, JSON.stringify(asks));
    const article = links.find((c) => c.site === "example.com");
    check("the example.com card shows the reply's title and description",
        article?.title === "An Article <b>Title</b>" && article?.description === "What the page says about itself.", JSON.stringify(article));
    check("the title is literal text, never markup", article?.html === "An Article &lt;b&gt;Title&lt;/b&gt;", article?.html);
    const labelled = links.find((c) => c.site === "example.org");
    check("a labelled link with no usable page metadata keeps its label as the title and no description",
        labelled?.title === "an article" && labelled?.description === null, JSON.stringify(labelled));

    // ── 3. Open routes through the host ──
    await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll(".embed-card--link"))
            .find((el) => el.querySelector(".embed-card__site")?.textContent === "example.com");
        card.querySelector(".embed-card__external").click();
    });
    await page.waitForTimeout(100);
    const opened = await posted("openUrl");
    check("the open control asks the host to open the page", opened.some((m) => m.url === "https://example.com/some/article"), JSON.stringify(opened));

    // ── 3b. Cmd+click on the card body opens the page; a plain click selects it ──
    const cardBox = await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll(".embed-card--link"))
            .find((el) => el.querySelector(".embed-card__site")?.textContent === "example.org");
        const r = card.querySelector(".embed-card__text").getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const openedBefore = (await posted("openUrl")).length;
    // page.mouse.click takes no modifiers; hold the key around it.
    await page.keyboard.down("Meta");
    await page.mouse.click(cardBox.x, cardBox.y);
    await page.keyboard.up("Meta");
    await page.waitForTimeout(100);
    const openedAfter = await posted("openUrl");
    check("Cmd+click on the card body asks the host to open the page",
        openedAfter.length === openedBefore + 1 && openedAfter.at(-1).url === "https://example.org/labelled", JSON.stringify(openedAfter));
    await page.mouse.click(cardBox.x, cardBox.y);
    await page.waitForTimeout(100);
    check("a plain click selects the card rather than opening it",
        (await posted("openUrl")).length === openedAfter.length
        && await page.$eval(".ProseMirror", (pm) => pm.querySelector(".embed-host--selected") !== null));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // ── 4. The block menu's per-link choice repaints without a document change ──
    const updatesBefore = (await posted("update")).length;
    const marker = await page.evaluate(() => {
        // Hover the labelled card's paragraph to reveal its marker, then read
        // the marker's centre.
        const host = Array.from(document.querySelectorAll(".ProseMirror > p.embed-host"))
            .find((p) => p.querySelector(".embed-card__site")?.textContent === "example.org");
        const el = host?.querySelector(".heading-fold-marker");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check("the labelled card's paragraph carries a gutter marker", marker !== null);
    await page.mouse.move(marker.x, marker.y);
    await page.waitForTimeout(120);
    await page.mouse.click(marker.x, marker.y);
    await page.waitForTimeout(150);
    const rows = await page.$$eval(".block-menu .block-menu-item-label", (els) => els.map((el) => el.textContent));
    check("the menu offers Show as Link for a carded link", rows.includes("Show as Link"), JSON.stringify(rows));
    await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll(".block-menu .block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Show as Link");
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    all = await cards();
    check("after Show as Link, only one link card remains and the labelled link is a plain link again",
        all.filter((c) => c.kind === "linkCard").length === 1
        && await page.$$eval(".ProseMirror a", (els) => els.some((a) => a.textContent === "an article" && getComputedStyle(a).display !== "none")),
        JSON.stringify(all));
    check("no document update was sent for a presentation choice", (await posted("update")).length === updatesBefore);

    // Reopen the same paragraph's menu: it now offers Show as Card, and picking it cards again.
    const marker2 = await page.evaluate(() => {
        const p = Array.from(document.querySelectorAll(".ProseMirror > p"))
            .find((el) => el.textContent === "an article");
        const el = p?.querySelector(".heading-fold-marker");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check("the plain link paragraph carries a marker", marker2 !== null);
    await page.mouse.move(marker2.x, marker2.y);
    await page.waitForTimeout(120);
    await page.mouse.click(marker2.x, marker2.y);
    await page.waitForTimeout(150);
    const rows2 = await page.$$eval(".block-menu .block-menu-item-label", (els) => els.map((el) => el.textContent));
    check("the menu now offers Show as Card", rows2.includes("Show as Card"), JSON.stringify(rows2));
    await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll(".block-menu .block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Show as Card");
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    all = await cards();
    check("Show as Card brings the card back", all.filter((c) => c.kind === "linkCard").length === 2, JSON.stringify(all));
    check("the host was not asked again for a page it already answered", (await posted("resolveLinkCard")).length === 2);
    check("still no document update", (await posted("update")).length === updatesBefore);
}
