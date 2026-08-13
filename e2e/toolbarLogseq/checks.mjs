/**
 * The Logseq status badge (MAR-132), in a real browser.
 *
 * The wiring is unit-tested (webview/__tests__/toolbarLogseq.test.ts). What
 * only a real browser can answer is what the badge LOOKS like: jsdom has no
 * layout engine, so it cannot say the badge is actually painted, that it reads
 * as a chip rather than as the drift warning beside it, or that it sits where
 * the design says it sits. Those are the claims here.
 */
export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // `attached`, not the default `visible`: at rest the badge is built and
    // hidden, which is the first thing this suite asserts.
    await page.waitForSelector('[data-item-id="logseq"]', { state: "attached", timeout: 10000 });

    const badge = '[data-item-id="logseq"]';
    const drift = '[data-item-id="syncConflict"]';

    /** Painted size + resolved paint of the badge button. */
    const paint = () =>
        page.$eval(`${badge} button`, (el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
                w: Math.round(r.width),
                h: Math.round(r.height),
                x: Math.round(r.x),
                text: el.textContent,
                bg: cs.backgroundColor,
                color: cs.color,
                radius: cs.borderTopLeftRadius,
                fontSize: cs.fontSize,
            };
        });
    const visible = (sel) =>
        page.$eval(sel, (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
        });
    const setLogseq = async (reason) => {
        await page.evaluate((r) => window.postMessage({ type: "logseqState", reason: r }, "*"), reason);
        await page.waitForTimeout(80);
    };
    /** Hover the badge and read the tooltip the shared component paints. */
    const tooltipText = async () => {
        await page.hover(`${badge} button`);
        await page.waitForTimeout(120);
        return page.$eval(".custom-tooltip", (el) => el.textContent.trim()).catch(() => null);
    };

    // ── 1. At rest: nothing. A default install must not see this at all ──
    check("at rest the badge takes no space", (await visible(badge)) === false);

    // ── 2. A graph reason paints it ──
    await setLogseq("graph");
    check("a logseqState reason paints the badge", (await visible(badge)) === true);
    const p = await paint();
    check("it reads as the word, not a glyph", p.text === "Logseq", JSON.stringify(p));
    check("it is actually laid out (a real width and height)", p.w > 30 && p.h > 12, JSON.stringify(p));
    check("it is painted as a chip, not left transparent", p.bg !== "rgba(0, 0, 0, 0)", p.bg);
    check("it carries a corner radius from the token scale", p.radius !== "0px", p.radius);

    // ── 3. It must NOT read as the warning beside it ──
    // The drift badge is the one thing on this bar that genuinely warns; a mode
    // indicator wearing the same paint would cry wolf.
    await page.evaluate(() =>
        window.postMessage({ type: "syncConflict", state: "conflict" }, "*"),
    );
    await page.waitForTimeout(80);
    check("with both up, the drift badge is visible too", (await visible(drift)) === true);
    const driftBg = await page.$eval(`${drift} button`, (el) => getComputedStyle(el).backgroundColor);
    check("the two badges do not share a ground", driftBg !== p.bg, `drift=${driftBg} logseq=${p.bg}`);

    // ── 4. Geography: a warning outranks a mode indicator ──
    const order = await page.$$eval(".tb-zone--right > .tb-item", (els) =>
        els
            .filter((e) => e.getBoundingClientRect().width > 0)
            .map((e) => e.getAttribute("data-item-id")),
    );
    check(
        "the drift warning sits ahead of the mode badge",
        order.indexOf("syncConflict") < order.indexOf("logseq") && order.indexOf("logseq") >= 0,
        JSON.stringify(order),
    );
    await page.evaluate(() => window.postMessage({ type: "syncConflict", state: "none" }, "*"));
    await page.waitForTimeout(80);

    // ── 5. Each reason explains itself, on one unchanged drawing ──
    const seen = {};
    const drawings = new Set();
    for (const reason of ["graph", "content", "forced"]) {
        await setLogseq(reason);
        seen[reason] = await tooltipText();
        const now = await paint();
        drawings.add(`${now.bg}|${now.color}|${now.radius}|${now.text}`);
        await page.mouse.move(0, 0);
        await page.waitForTimeout(60);
    }
    check("graph explains itself", !!seen.graph && seen.graph.includes("graph"), JSON.stringify(seen));
    check("content explains itself", !!seen.content && seen.content !== seen.graph, JSON.stringify(seen));
    check("forced explains itself", !!seen.forced && seen.forced !== seen.content, JSON.stringify(seen));
    check("one drawing across all three reasons", drawings.size === 1, JSON.stringify([...drawings]));

    // ── 6. Clicking asks for the setting that governs it ──
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.click(`${badge} button`);
    await page.waitForTimeout(80);
    const posted = await page.evaluate(() => window.__posted);
    check(
        "clicking asks the extension for birta.logseq",
        posted.some((m) => m.type === "openSettings" && m.query === "birta.logseq"),
        JSON.stringify(posted),
    );

    // ── 7. Withdrawal: a null reason takes it away again ──
    await setLogseq(null);
    check("a null reason withdraws the badge", (await visible(badge)) === false);

    check("no page errors", errors.length === 0, errors.join("; "));
}
