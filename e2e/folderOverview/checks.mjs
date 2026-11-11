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
 * folder graph off the command is reported idle and runs nothing; and the
 * Mac app's new folder tab, where the command arrives straight behind the init
 * of an empty note that the index does not hold, opens the overview and
 * Escape leaves a note that takes typing.
 */
const OVERVIEW = ".fo-surface";

/**
 * Wait until the overview has settled: drawn, holding keyboard focus (it
 * places focus once its pieces are in), and, on a host that keeps a recent
 * files list, showing its rows. Those are what every check after an opening
 * reads, so they are what is waited for.
 */
async function settled(page, { rows = true } = {}) {
    await page.waitForFunction(({ sel, rows }) => {
        const s = document.querySelector(sel);
        return !!s && !!s.querySelector(".lg-node") && s.contains(document.activeElement)
            && (!rows || s.querySelectorAll(".fo-row").length > 0);
    }, { sel: OVERVIEW, rows }, { timeout: 5000 });
}

async function openOverview(page, options) {
    await page.evaluate(() => window.__runCommand("showFolderOverview"));
    await settled(page, options);
}

/** Whether the overview closed, saying so when the wait timed out rather than leaving a bare false. */
async function closed(page) {
    try {
        await page.waitForFunction((sel) => !document.querySelector(sel), OVERVIEW, { timeout: 3000 });
        return { closed: true };
    } catch {
        return { closed: false, why: "timed out after 3s waiting for the overview to close" };
    }
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
    check("Escape closes the overview and hands focus back to the editor", escaped.closed && editorFocused,
        JSON.stringify({ escaped, editorFocused }));
    const openedOnEscape = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").length);
    check("Escape opens nothing", openedOnEscape === 0, `opens=${openedOnEscape}`);

    // ── A dot opens its note ─────────────────────────────────────────────
    await openOverview(page);
    await page.locator(`${OVERVIEW} .lg-node[data-id="deep/detail-3.md"]`).dispatchEvent("mousedown");
    const dotClosed = await closed(page);
    const dotOpened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").map((m) => m.path));
    check("a second-ring dot closes the overview and opens its note in this window",
        dotClosed.closed && JSON.stringify(dotOpened) === JSON.stringify(["deep/detail-3.md"]), JSON.stringify({ dotClosed, dotOpened }));

    // ── The hub opens too ────────────────────────────────────────────────
    await openOverview(page);
    await page.locator(`${OVERVIEW} .lg-node--self`).click();
    const hubClosed = await closed(page);
    const hubOpened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").map((m) => m.path).at(-1));
    check("the hub at the centre is a note to open, not the current one",
        hubClosed.closed && hubOpened === "index.md", JSON.stringify({ hubClosed, hubOpened }));

    // ── A recent row opens its file ──────────────────────────────────────
    await openOverview(page);
    await page.locator(`${OVERVIEW} .fo-row[data-path="topics/topic-5.md"]`).click();
    const rowClosed = await closed(page);
    const rowOpened = await page.evaluate(() => window.__posted.filter((m) => m.type === "openProjectFile").map((m) => m.path).at(-1));
    check("a recent file's row closes the overview and opens it", rowClosed.closed && rowOpened === "topics/topic-5.md",
        JSON.stringify({ rowClosed, rowOpened }));
    const asksTotal = await page.evaluate(() => window.__posted.filter((m) => m.type === "requestFolderRecents").length);
    check("every opening asks for the recent files afresh", asksTotal === 4, `asks=${asksTotal}`);

    // ── A host with no recent files list ─────────────────────────────────
    await page.goto(`${baseUrl}/index.html?recents=0`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(300);
    await openOverview(page, { rows: false });
    const bare = await page.evaluate((sel) => {
        const s = document.querySelector(sel);
        const visible = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
        return { heading: visible(s.querySelector(".fo-heading")), empty: visible(s.querySelector(".fo-empty")), nodes: s.querySelectorAll(".lg-node").length };
    }, OVERVIEW);
    check("a host that keeps no recent files list shows the graph and no recent files section",
        !bare.heading && !bare.empty && bare.nodes > 1, JSON.stringify(bare));
    await page.keyboard.press("Escape");
    const bareClosed = await closed(page);
    check("Escape closes it there too", bareClosed.closed, JSON.stringify(bareClosed));

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

    // ── A new folder tab: the command right behind the init ──────────────
    await page.goto(`${baseUrl}/index.html?newTab=1`);
    await page.waitForSelector(`${OVERVIEW} .lg-node`, { timeout: 15000 });
    await settled(page);
    const tab = await page.evaluate((sel) => ({
        centre: document.querySelector(sel)?.querySelector(".lg-node--self")?.dataset.id ?? null,
        overviews: document.querySelectorAll(sel).length,
    }), OVERVIEW);
    check("a command sent behind the init of a new tab opens one overview, on the folder's hub",
        tab.centre === "index.md" && tab.overviews === 1, JSON.stringify(tab));
    await page.keyboard.press("Escape");
    const tabEscaped = await closed(page);
    const tabFocused = await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));
    check("Escape leaves the blank note with the caret in it", tabEscaped.closed && tabFocused,
        JSON.stringify({ tabEscaped, tabFocused }));
    const updatesBefore = await page.evaluate(() => window.__posted.filter((m) => m.type === "update").length);
    check("an untouched new tab sends no content to write", updatesBefore === 0, `updates=${updatesBefore}`);
    await page.keyboard.type("First line");
    let typedWhy = null;
    try {
        await page.waitForFunction(() => window.__posted.some((m) => m.type === "update" && m.content.includes("First line")),
            null, { timeout: 3000 });
    } catch {
        typedWhy = "timed out after 3s waiting for an update carrying the typed text";
    }
    const typed = await page.evaluate(() => window.__posted.filter((m) => m.type === "update").at(-1)?.content ?? null);
    check("the first keystrokes reach the host as the note's content", typed?.includes("First line") === true,
        JSON.stringify({ typed, typedWhy }));

    // ── The start view: a host with a launcher ───────────────────────────
    await page.goto(`${baseUrl}/index.html?launcher=1`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__runCommand("showFolderOverview"));
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .fo-file`).length > 0, OVERVIEW, { timeout: 5000 });
    const start = await page.evaluate((sel) => {
        const s = document.querySelector(sel);
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        const actions = [...s.querySelectorAll(".fo-action")];
        return {
            buttons: actions.map((b) => b.textContent),
            buttonsAbove: actions.every((b) => box(b).bottom <= box(s.querySelector(".lg-stage")).top && box(b).height > 0),
            buttonsOnScreen: actions.every((b) => box(b).top >= 0 && box(b).bottom <= innerHeight),
            files: s.querySelectorAll(".fo-file").length,
            last: s.querySelector(".fo-files").lastElementChild.textContent,
            headings: [...s.querySelectorAll(".fo-heading")].map((h) => h.textContent),
            folderRowOnScreen: (() => { const r = s.querySelector(".fo-row"); return !!r && box(r).bottom <= innerHeight; })(),
        };
    }, OVERVIEW);
    check("with the buttons above it, the folder's own first file is still above the fold at a short height",
        start.folderRowOnScreen, JSON.stringify(start));
    check("over a folder the start view leads with New Note and Open… above the graph, on screen",
        start.buttons.join("|") === "New Note|Open…" && start.buttonsAbove && start.buttonsOnScreen, JSON.stringify(start));
    check("it lists six of the reader's recent files and closes the list with Open Recent…",
        start.files === 6 && start.last === "Open Recent…" && start.headings.join("|") === "In this folder|Recent",
        JSON.stringify(start));
    await page.locator(`${OVERVIEW} .fo-more`).click();
    const menuAsk = await page.evaluate(() => {
        const m = window.__posted.filter((p) => p.type === "startAction").at(-1);
        const r = document.querySelector(".fo-more")?.getBoundingClientRect();
        return { m, left: r?.left, bottom: r?.bottom };
    });
    check("Open Recent… asks the host for its menu at the row's bottom-left corner",
        menuAsk.m?.action === "openRecentMenu" && Math.abs(menuAsk.m.x - menuAsk.left) < 1 && Math.abs(menuAsk.m.y - menuAsk.bottom) < 1,
        JSON.stringify(menuAsk));
    await page.locator(`${OVERVIEW} .fo-action`, { hasText: "New Note" }).click();
    const newClosed = await closed(page);
    const newAsked = await page.evaluate(() => window.__posted.filter((p) => p.type === "startAction").at(-1)?.action);
    check("New Note puts the overview away and asks the host for a note", newClosed.closed && newAsked === "newNote",
        JSON.stringify({ newClosed, newAsked }));

    // ── The start view as a window's empty state ─────────────────────────
    await page.goto(`${baseUrl}/index.html?empty=1`);
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .fo-file`).length > 0, OVERVIEW, { timeout: 15000 });
    const empty = await page.evaluate((sel) => {
        const s = document.querySelector(sel);
        return {
            title: s.querySelector(".fs-title").textContent,
            // The two class names the Mac app's focus script reads
            // (`WebHost.focusEditor`): the pinned surface, and its first button.
            hooks: s.classList.contains("fs-surface--pinned") && s.querySelector(".fo-action")?.textContent === "New Note",
            graph: !!s.querySelector(".lg-stage"),
            close: !s.querySelector(".fs-actions__group--close") || s.querySelector(".fs-actions__group--close").hidden,
            focused: document.activeElement?.textContent ?? null,
            asked: window.__posted.map((m) => m.type).filter((t) => t === "requestFolderRecents" || t === "requestRecentFiles"),
        };
    }, OVERVIEW);
    check("a window holding no file shows the start view with no folder in it, focus on New Note",
        empty.title === "No File Open" && empty.hooks && !empty.graph && empty.close && empty.focused === "New Note"
        && empty.asked.join("|") === "requestRecentFiles", JSON.stringify(empty));
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 300);
    await page.waitForTimeout(400);
    const stillUp = await page.evaluate((sel) => !!document.querySelector(sel) && !document.querySelector(sel).classList.contains("lb-closing"), OVERVIEW);
    check("it is pinned: neither Escape nor a click on the ground puts it away", stillUp, String(stillUp));
    const band = await page.evaluate((sel) => {
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        const top = document.querySelector(sel).getBoundingClientRect().top;
        const hit = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
        // A menu the bar drops below itself, inside the bar's own stacking
        // context, as the gear's menu is: it must draw over the start view.
        const menu = document.createElement("div");
        menu.style.cssText = "position:absolute;top:100%;left:0;width:120px;height:60px";
        document.querySelector(".editor-topbar").append(menu);
        const r = menu.getBoundingClientRect();
        const menuHit = document.elementFromPoint(r.left + 10, r.top + 30) === menu;
        menu.remove();
        return { top, barBottom: bar.bottom, barTakesTheClick: !!hit?.closest(".editor-topbar"), menuHit };
    }, OVERVIEW);
    check("it starts under the top bar, so the bar's controls stay the reader's",
        band.top >= band.barBottom - 1 && band.barTakesTheClick, JSON.stringify(band));
    check("a menu the top bar drops below itself draws over the start view", band.menuHit, JSON.stringify(band));
    await page.locator(`${OVERVIEW} .fo-file`).first().click();
    const pick = await page.evaluate(() => window.__posted.filter((m) => m.type === "openRecentFile").at(-1)?.path ?? null);
    check("a recent file asks the host to open it by the path it was given", pick === "/Users/r/notes/recent-1.md", String(pick));

    check("no page errors", errors.length === 0, JSON.stringify(errors));
}
