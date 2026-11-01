/**
 * The folder overview against the REAL bundle (MAR-488): what jsdom cannot
 * measure, because it has no layout, and the command route a host menu takes.
 *
 * Covers: nothing is asked for and nothing opens until the command runs; the
 * command opens the overview over the page, centred on the folder's hub (not
 * the open note), asking for the recent files once; the drawing and the recent
 * files both fit the window at a short height, the list under the drawing and
 * above the fold; focus lands on the first recent file; Escape closes it and
 * hands focus back to the editor; a dot and a row each close it and open their
 * note; a host with no recent files list shows no section for one; with the
 * folder graph off the command is reported idle and runs nothing.
 */
const OVERVIEW = ".fo-surface";

async function openOverview(page) {
    await page.evaluate(() => window.__runCommand("showFolderOverview"));
    await page.waitForSelector(`${OVERVIEW} .lg-node`, { timeout: 5000 });
    await page.waitForTimeout(100);
}

async function closed(page) {
    await page.waitForFunction((sel) => !document.querySelector(sel), OVERVIEW, { timeout: 3000 }).catch(() => {});
    return page.evaluate((sel) => !document.querySelector(sel), OVERVIEW);
}

export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); } });

    // A short window: the case where the drawing could push the list down.
    await page.setViewportSize({ width: 900, height: 560 });
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(400);

    // ── On demand only ───────────────────────────────────────────────────
    const before = await page.evaluate((sel) => ({
        surface: !!document.querySelector(sel),
        recents: window.__posted.filter((m) => m.type === "requestFolderRecents").length,
    }), OVERVIEW);
    check("nothing opens and no recent files are asked for until the command runs",
        !before.surface && before.recents === 0, JSON.stringify(before));

    // ── The command ──────────────────────────────────────────────────────
    await openOverview(page);
    const drawn = await page.evaluate((sel) => {
        const s = document.querySelector(sel);
        return {
            centre: s.querySelector(".lg-node--self")?.dataset.id,
            nodes: s.querySelectorAll(".lg-node").length,
            rows: [...s.querySelectorAll(".fo-row")].map((r) => r.dataset.path),
            asks: window.__posted.filter((m) => m.type === "requestFolderRecents").length,
            title: s.querySelector(".fs-title")?.textContent,
        };
    }, OVERVIEW);
    check("the overview centres on the folder's hub, not the open note", drawn.centre === "index.md", JSON.stringify(drawn));
    // The hub, its twelve namers, and two steps out the four details and the
    // open note (which names a topic, not the hub).
    check("two rings are drawn around it", drawn.nodes === 1 + 12 + 4 + 1, `nodes=${drawn.nodes}`);
    check("the recent files are listed in the host's order",
        JSON.stringify(drawn.rows) === JSON.stringify(["notes/standup.md", "deep/detail-2.md", "topics/topic-5.md", "loose.txt"]),
        JSON.stringify(drawn.rows));
    check("opening asks for the recent files once", drawn.asks === 1, `asks=${drawn.asks}`);
    check("the title names the folder", drawn.title === "Folder: vault", drawn.title);

    const geo = await page.evaluate((sel) => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
        const s = document.querySelector(sel);
        const stage = r(s.querySelector(".lg-stage"));
        const rows = [...s.querySelectorAll(".fo-row")].map(r);
        const dots = [...s.querySelectorAll(".lg-dot")].map(r);
        return { stage, rows, dots, vh: innerHeight, vw: innerWidth, active: document.activeElement?.dataset?.path ?? null };
    }, OVERVIEW);
    check("the drawing is a square inside the window",
        Math.abs(geo.stage.width - geo.stage.height) < 2 && geo.stage.width > 100 && geo.stage.bottom <= geo.vh && geo.stage.right <= geo.vw,
        JSON.stringify(geo.stage));
    const lastRow = geo.rows[geo.rows.length - 1];
    check("every recent file sits under the drawing and above the fold of a short window",
        geo.rows.length === 4 && geo.rows[0].top >= geo.stage.bottom - 1 && lastRow.bottom <= geo.vh,
        JSON.stringify({ stageBottom: geo.stage.bottom, firstTop: geo.rows[0]?.top, lastBottom: lastRow?.bottom, vh: geo.vh }));
    check("every dot lies inside the drawing",
        geo.dots.every((d) => d.left >= geo.stage.left - 8 && d.right <= geo.stage.right + 8 && d.top >= geo.stage.top - 8 && d.bottom <= geo.stage.bottom + 8),
        `dots=${geo.dots.length}`);
    check("focus lands on the first recent file", geo.active === "notes/standup.md", String(geo.active));

    // ── Escape ───────────────────────────────────────────────────────────
    await page.keyboard.press("Escape");
    const escaped = await closed(page);
    const editorFocused = await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));
    check("Escape closes the overview and hands focus back to the editor", escaped && editorFocused,
        JSON.stringify({ escaped, editorFocused }));
    const openedOnEscape = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").length);
    check("Escape opens nothing", openedOnEscape === 0, `opens=${openedOnEscape}`);

    // ── A dot opens its note ─────────────────────────────────────────────
    await openOverview(page);
    await page.locator(`${OVERVIEW} .lg-node[data-id="deep/detail-3.md"]`).dispatchEvent("mousedown");
    const dotClosed = await closed(page);
    const dotOpened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").map((m) => m.path));
    check("a second-ring dot closes the overview and opens its note in this window",
        dotClosed && JSON.stringify(dotOpened) === JSON.stringify(["deep/detail-3.md"]), JSON.stringify({ dotClosed, dotOpened }));

    // ── The hub opens too ────────────────────────────────────────────────
    await openOverview(page);
    await page.locator(`${OVERVIEW} .lg-node--self`).click();
    await closed(page);
    const hubOpened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").map((m) => m.path).at(-1));
    check("the hub at the centre is a note to open, not the current one", hubOpened === "index.md", String(hubOpened));

    // ── A recent row opens its file ──────────────────────────────────────
    await openOverview(page);
    await page.locator(`${OVERVIEW} .fo-row[data-path="topics/topic-5.md"]`).click();
    const rowClosed = await closed(page);
    const rowOpened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").map((m) => m.path).at(-1));
    check("a recent file's row closes the overview and opens it", rowClosed && rowOpened === "topics/topic-5.md",
        JSON.stringify({ rowClosed, rowOpened }));
    const asksTotal = await page.evaluate(() => window.__posted.filter((m) => m.type === "requestFolderRecents").length);
    check("every opening asks for the recent files afresh", asksTotal === 4, `asks=${asksTotal}`);

    // ── A host with no recent files list ─────────────────────────────────
    await page.goto(`${baseUrl}/index.html?recents=0`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(300);
    await openOverview(page);
    const bare = await page.evaluate((sel) => {
        const s = document.querySelector(sel);
        const visible = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
        return { heading: visible(s.querySelector(".fo-heading")), empty: visible(s.querySelector(".fo-empty")), nodes: s.querySelectorAll(".lg-node").length };
    }, OVERVIEW);
    check("a host that keeps no recent files list shows the graph and no recent files section",
        !bare.heading && !bare.empty && bare.nodes > 1, JSON.stringify(bare));
    await page.keyboard.press("Escape");
    await closed(page);

    // ── The folder graph off ─────────────────────────────────────────────
    await page.goto(`${baseUrl}/index.html?graph=0`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.postMessage({ type: "requestPaletteCommands" }, "*"));
    await page.waitForTimeout(150);
    const offered = await page.evaluate(() => {
        const answer = window.__posted.filter((m) => m.type === "paletteCommands").at(-1);
        return answer ? { listed: answer.items.some((c) => c.id === "showFolderOverview"), idle: answer.idle?.includes("showFolderOverview") } : null;
    });
    check("with the folder graph off the command is not offered and is reported idle, so a host menu dims it",
        offered !== null && offered.listed === false && offered.idle === true, JSON.stringify(offered));
    await page.evaluate(() => window.__runCommand("showFolderOverview"));
    await page.waitForTimeout(300);
    const offOpened = await page.evaluate((sel) => !!document.querySelector(sel), OVERVIEW);
    check("and running it anyway opens nothing", !offOpened, String(offOpened));

    check("no page errors", errors.length === 0, JSON.stringify(errors));
}
