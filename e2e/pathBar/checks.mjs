/**
 * The path bar (components/pathBar): what a host's `pathBar` draws at the
 * window's foot, where it starts, and what a click hands back.
 *
 * In a browser rather than jsdom because two of the claims are about layout:
 * the bar's first icon stands on the formatting row's leading line, and a
 * docked drawer moves both by the same amount.
 */
export async function run({ page, check, baseUrl }) {
    const SEGMENTS = [
        { name: "iCloud Drive", path: "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs", kind: "cloud" },
        { name: "Notes", path: "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/Notes", kind: "folder" },
        { name: "Today.md", path: "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/Notes/Today.md", kind: "file" },
    ];
    const send = (msg) => page.evaluate((m) => window.postMessage(m, "*"), msg);

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const chunkLoaded = () => page.evaluate(() =>
        performance.getEntriesByType("resource").some((e) => /chunks\/pathBar-/.test(e.name)));
    check("before any pathBar message there is no bar", !(await page.$(".path-bar")));
    const loadedEarly = await chunkLoaded();

    await send({ type: "setFormattingRowExpanded", expanded: true });
    await send({ type: "pathBar", segments: SEGMENTS });
    await page.waitForSelector(".path-bar", { timeout: 5000 });
    await page.waitForTimeout(150);

    const drawn = await page.evaluate(() => {
        const bar = document.querySelector(".path-bar");
        const buttons = [...bar.querySelectorAll(".path-bar__item:not([hidden]) .path-bar__segment")];
        const firstIcon = buttons[0].querySelector(".path-bar__icon").getBoundingClientRect();
        // Where the formatting row's first control starts its content: its
        // box plus border and padding, which holds whatever the paragraph
        // label inside it says ("P" and "H1" centre differently).
        const control = document.querySelector(".tb-dock .tb-item button");
        const cs = control && getComputedStyle(control);
        const firstControl = control
            ? { left: control.getBoundingClientRect().left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) }
            : null;
        const r = bar.getBoundingClientRect();
        return {
            labels: buttons.map((b) => b.textContent),
            chevrons: bar.querySelectorAll(".path-bar__item:not([hidden]) .path-bar__chevron").length,
            current: buttons.map((b) => b.getAttribute("aria-current")),
            navLabel: bar.getAttribute("aria-label"),
            accessible: buttons.every((b) => b.tagName === "BUTTON" && b.getAttribute("aria-label")),
            bottomGap: Math.round(innerHeight - r.bottom),
            iconLeft: Math.round(firstIcon.left),
            controlLeft: firstControl ? Math.round(firstControl.left) : null,
            oneLine: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size === 1,
            // A clipped label is shorter than its own text's line box.
            unclipped: [...bar.querySelectorAll(".path-bar__label")].every((l) => l.scrollHeight <= l.clientHeight),
        };
    });
    // Both halves, so a chunk renamed out from under the pattern fails here
    // rather than passing the absence check by matching nothing at all.
    const loadedLate = await chunkLoaded();
    check("the chunk is not fetched until a host sends segments, and is fetched once one does",
        !loadedEarly && loadedLate, JSON.stringify({ loadedEarly, loadedLate }));
    check("the bar draws every segment, root first, with a chevron between each",
        JSON.stringify(drawn.labels) === JSON.stringify(["iCloud Drive", "Notes", "Today.md"]) && drawn.chevrons === 2,
        JSON.stringify(drawn));
    check("it is a labelled navigation landmark of buttons, the file marked as the current location",
        drawn.navLabel === "File path" && drawn.accessible
            && JSON.stringify(drawn.current) === JSON.stringify([null, null, "location"]),
        JSON.stringify(drawn));
    check("it sits on the window's foot, on one line, with no label clipped",
        drawn.bottomGap === 0 && drawn.oneLine && drawn.unclipped, JSON.stringify(drawn));
    check("its first icon stands on the formatting row's leading line (±2px)",
        drawn.controlLeft !== null && Math.abs(drawn.iconLeft - drawn.controlLeft) <= 2, JSON.stringify(drawn));

    // Keyboard first, since the bar is a row of buttons a reader must be able
    // to reach without a pointer.
    await page.focus(".path-bar__segment[data-kind=folder]");
    await page.keyboard.press("Enter");
    await page.locator(".path-bar__segment[data-kind=file]").click();
    const reveals = await page.evaluate(() => window.__posted.filter((m) => m.type === "revealPath").map((m) => m.path));
    check("a folder and the file each hand their own path back as revealPath",
        JSON.stringify(reveals) === JSON.stringify([SEGMENTS[1].path, SEGMENTS[2].path]), JSON.stringify(reveals));

    // ── Narrowing: fold, never overlap ────────────────────────────────
    const DEEP = [
        { name: "iCloud Drive", path: "/c", kind: "cloud" },
        { name: "Obsidian", path: "/c/o", kind: "folder" },
        { name: "Harlan", path: "/c/o/h", kind: "folder" },
        { name: "Voice Notes", path: "/c/o/h/v", kind: "folder" },
        { name: "2026-10-06 2000 - Testing.md", path: "/c/o/h/v/t.md", kind: "file" },
    ];
    await send({ type: "setFormattingRowExpanded", expanded: false });
    await send({ type: "pathBar", segments: DEEP });
    await page.waitForTimeout(150);
    const original = page.viewportSize();
    const readings = [];
    for (const width of [1000, 560, 460, 380, 300, 240, 180]) {
        await page.setViewportSize({ width, height: original.height });
        await page.waitForTimeout(120);
        readings.push(await page.evaluate((w) => {
            const items = [...document.querySelectorAll(".path-bar__item")].filter((el) => !el.hidden);
            const boxes = items.map((el) => el.getBoundingClientRect());
            const overlaps = boxes.some((b, i) => i > 0 && b.left < boxes[i - 1].right - 0.5);
            const labels = [...document.querySelectorAll(".path-bar__item:not([hidden]) .path-bar__label")];
            const list = document.querySelector(".path-bar__list").getBoundingClientRect();
            return {
                w,
                shown: items.map((el) => el.classList.contains("path-bar__item--more")
                    ? "…" : el.querySelector(".path-bar__label").textContent),
                overlaps,
                overflows: boxes.some((b) => b.right > list.right + 0.5),
                // Only the file's label may be cut short.
                truncatedNonFile: labels.slice(0, -1).some((l) => l.scrollWidth > l.clientWidth + 1),
            };
        }, width));
    }
    check("narrowing never draws one segment over another, or past the bar's end",
        readings.every((r) => !r.overlaps && !r.overflows), JSON.stringify(readings));
    check("only the file's name is ever truncated; every other visible name is whole",
        readings.every((r) => !r.truncatedNonFile), JSON.stringify(readings));
    const order = readings.map((r) => r.shown.join(" › "));
    check("the wide bar shows every segment, and the narrowest keeps the file behind the ellipsis",
        readings[0].shown.length === 5 && !readings[0].shown.includes("…")
            && JSON.stringify(readings.at(-1).shown) === JSON.stringify(["…", "2026-10-06 2000 - Testing.md"]),
        JSON.stringify(order));
    check("folding is progressive: each narrower step shows a subset of the step before, middle first",
        readings.every((r, i) => i === 0 || r.shown.filter((x) => x !== "…").every((x) => readings[i - 1].shown.includes(x)))
            && order.some((o) => o.startsWith("iCloud Drive › … ›")),
        JSON.stringify(order));

    // The ellipsis hands the host exactly what it folded, root first.
    const midWidth = readings.find((r) => r.shown[0] === "iCloud Drive" && r.shown.includes("…")).w;
    await page.setViewportSize({ width: midWidth, height: original.height });
    await page.waitForTimeout(120);
    await page.locator(".path-bar__more").click();
    const menu = await page.evaluate(() => window.__posted.filter((m) => m.type === "pathBarMenu").at(-1));
    const hiddenNames = await page.$$eval(".path-bar__item[hidden] .path-bar__label", (ls) => ls.map((l) => l.textContent));
    check("the ellipsis posts pathBarMenu with the folded segments, by name and path, root first",
        menu && JSON.stringify(menu.segments.map((x) => x.name)) === JSON.stringify(hiddenNames)
            && menu.segments.every((x) => DEEP.some((d) => d.path === x.path && d.name === x.name))
            && Number.isFinite(menu.x) && Number.isFinite(menu.y),
        JSON.stringify({ menu, hiddenNames }));
    check("the ellipsis says it opens a menu",
        await page.$eval(".path-bar__more", (b) => b.getAttribute("aria-haspopup") === "menu" && !!b.getAttribute("aria-label")));
    await page.setViewportSize(original);

    await send({ type: "pathBar", segments: [SEGMENTS[0], { ...SEGMENTS[2], name: "Renamed.md" }] });
    await page.waitForTimeout(100);
    const replaced = await page.$$eval(".path-bar", (bars) => bars.map((b) => b.textContent));
    check("new segments replace the bar rather than stacking a second one",
        replaced.length === 1 && replaced[0].includes("Renamed.md"), JSON.stringify(replaced));

    await send({ type: "pathBar", segments: null });
    await page.waitForTimeout(100);
    check("null takes the bar down", !(await page.$(".path-bar")));
}
