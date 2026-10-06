/**
 * Following a link. A plain click on a link places the caret (a wikilink
 * reveals its source) and pins the link's popup; Cmd+click follows it. What
 * only a real event can show: the modifier path runs from a capture-phase
 * mousedown ahead of ProseMirror's own, so a unit test calling a prop never
 * reaches it. This suite pins the page half for every link kind: the message
 * and its payload, and that the gesture neither edits nor pins anything. The
 * host half is the host's: `LinkTargetTests` and `BridgeTests` in mac/Tests.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector("a.wiki-link", { timeout: 5000 });

    const reset = () => page.evaluate(() => { window.__posted = []; });
    const opens = () => page.evaluate(() => window.__posted.filter((m) => m.type === "openFile" || m.type === "openUrl"));
    const center = (selector, index = 0) => page.evaluate(([sel, i]) => {
        const el = document.querySelectorAll(sel)[i];
        if (!el) return null;
        const r = (el.querySelector(".wiki-link-render") ?? el).getBoundingClientRect();
        return { x: r.x + Math.min(r.width / 2, 20), y: r.y + r.height / 2 };
    }, [selector, index]);
    const editing = () => page.evaluate(() => document.querySelectorAll(".wiki-link--editing").length);
    const popupShown = () => page.evaluate(() => {
        const p = document.querySelector(".lp-root");
        if (!p) return false;
        const cs = getComputedStyle(p);
        return cs.display !== "none" && cs.visibility !== "hidden" && p.getBoundingClientRect().height > 0;
    });
    const docText = () => page.evaluate(() => document.querySelector(".ProseMirror").textContent);
    const parkCaret = async () => {
        await page.keyboard.press("Escape");
        const omega = await page.evaluate(() => {
            const p = Array.from(document.querySelectorAll(".ProseMirror p")).find((el) => el.textContent === "Omega");
            const r = p.getBoundingClientRect();
            return { x: r.x + 5, y: r.y + r.height / 2 };
        });
        await page.mouse.click(omega.x, omega.y);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
    };
    const before = await docText();

    const targets = [
        { name: "a local Markdown link", sel: ".ProseMirror a[href^='notes/']", i: 0,
          want: { type: "openFile", path: "notes/Notable%20Todo.md" } },
        { name: "a wikilink", sel: "a.wiki-link", i: 0,
          want: { type: "openFile", path: "2025-04-10 Thursday April 10", wiki: true } },
        { name: "a wikilink to a heading, through its alias", sel: "a.wiki-link", i: 1,
          want: { type: "openFile", path: "Plan#Next Steps", wiki: true } },
        { name: "an external link", sel: ".ProseMirror a[href^='https:']", i: 0,
          want: { type: "openUrl", url: "https://example.com/article" } },
        { name: "a reference link", sel: ".ProseMirror a[data-type='link-ref']", i: 0,
          want: { type: "openFile", path: "other.md#12" } },
    ];

    let reached = 0;
    for (const t of targets) {
        // The caret parked away from every link first, so a reveal or a
        // popup left from the previous case cannot be read as this one's.
        await parkCaret();
        await reset();

        const at = await center(t.sel, t.i);
        check(`${t.name} is on the page`, at !== null, t.sel);
        if (!at) continue;
        reached++;

        await page.keyboard.down("Meta");
        await page.mouse.click(at.x, at.y);
        await page.keyboard.up("Meta");
        await page.waitForTimeout(150);
        const posted = await opens();
        const match = posted.length === 1
            && Object.entries(t.want).every(([k, v]) => posted[0][k] === v)
            && (t.want.wiki || posted[0].wiki === undefined);
        check(`Cmd+click on ${t.name} follows it`, match, JSON.stringify(posted));
        const revealed = await editing();
        check(`Cmd+click on ${t.name} reveals no wikilink source`, revealed === 0, String(revealed));
        check(`Cmd+click on ${t.name} pins no popup`, !(await popupShown()));
    }
    check("every link kind was reached", reached === targets.length, `${reached}/${targets.length}`);

    // A plain click keeps the editing convention: it opens nothing.
    await parkCaret();
    await reset();
    const wiki = await center("a.wiki-link", 0);
    await page.mouse.click(wiki.x, wiki.y);
    await page.waitForTimeout(150);
    check("a plain click on a wikilink follows nothing", (await opens()).length === 0, JSON.stringify(await opens()));
    check("a plain click on a wikilink reveals its source for editing", (await editing()) === 1, String(await editing()));

    await parkCaret();
    await reset();
    const local = await center(".ProseMirror a[href^='notes/']", 0);
    await page.mouse.click(local.x, local.y);
    await page.waitForTimeout(300);
    check("a plain click on a Markdown link follows nothing", (await opens()).length === 0, JSON.stringify(await opens()));
    check("a plain click on a Markdown link shows its popup", await popupShown());

    check("no gesture changed the document", (await docText()) === before);
}
