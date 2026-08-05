/**
 * The table overlay is built on the first gesture that could need it, not at
 * mount (MAR-317). This is the browser half of that guarantee, and it exists
 * because jsdom cannot answer the questions that matter here.
 *
 * `webview/__tests__/tableView.test.ts` already pins the same behaviour by
 * dispatching a `pointermove` at the wrapper. That proves the handler does the
 * right thing when it is called; it cannot prove the handler is the one the
 * browser calls, because dispatching directly at the element bypasses hit
 * testing and listener ordering entirely (AGENTS.md: anything depending on
 * which listener wins needs a real event). Nor can jsdom answer whether a grip
 * lands anywhere visible, since every rect it reports is 0×0.
 *
 * So the three checks here are deliberately the ones jsdom cannot fake: a real
 * pointer moved to real coordinates, computed opacity from a real style
 * resolution, and a keyboard path driven with the pointer parked off the table.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror table", { timeout: 10000 });
    await page.waitForTimeout(300);

    const grips = () => page.evaluate(() => document.querySelectorAll(".mw-grip").length);
    const inserts = () => page.evaluate(() => document.querySelectorAll(".mw-insert").length);
    const tableCount = () => page.evaluate(() => document.querySelectorAll(".ProseMirror table").length);

    check("fixture renders both tables", (await tableCount()) === 2, `tables=${await tableCount()}`);

    // ── 1. Nothing built at mount ──
    // The claim the launch win rests on. If this ever goes non-zero the
    // deferral has been undone, whatever the unit tests say.
    const mountGrips = await grips();
    const mountInserts = await inserts();
    check("a table nobody has pointed at builds no grips", mountGrips === 0, `grips=${mountGrips}`);
    check("…and no insert bars", mountInserts === 0, `inserts=${mountInserts}`);

    // ── 2. A real pointer over the first table builds it, visibly ──
    const firstBox = await page.evaluate(() => {
        const w = document.querySelectorAll(".mw-table")[0];
        const r = w.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, count: document.querySelectorAll(".mw-table").length };
    });
    check("fixture renders two table wrappers", firstBox.count === 2, `wrappers=${firstBox.count}`);

    await page.mouse.move(firstBox.x, firstBox.y);
    await page.waitForTimeout(400); // build + the 0.12s opacity transition

    const afterHover = await grips();
    check("moving a real pointer over a table builds its grips", afterHover > 0, `grips=${afterHover}`);

    // Built is not the same as revealed, and jsdom cannot see the difference at
    // all. The reveal is proximity-based, so most grips stay at rest even with
    // the pointer on the table — take the brightest rather than an arbitrary
    // one, which is what made the first draft of this check fail against a
    // perfectly good product.
    const opacity = await page.evaluate(() =>
        Math.max(-1, ...[...document.querySelectorAll(".mw-grip")]
            .map((g) => parseFloat(getComputedStyle(g).opacity))));
    check("a revealed grip is actually visible (opacity > 0)", opacity > 0, `maxOpacity=${opacity}`);

    // The grip has to land on the table, not at the origin — the failure a
    // deferred build would produce if it skipped its synchronous reposition.
    const placed = await page.evaluate(() => {
        const w = document.querySelectorAll(".mw-table")[0].getBoundingClientRect();
        return [...document.querySelectorAll(".mw-grip")].some((g) => {
            const r = g.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= w.top - 40 && r.bottom <= w.bottom + 40;
        });
    });
    check("a built grip is positioned against its own table", placed);

    // ── 3. The second table stays unbuilt ──
    // Deferral is per table, so revealing one must not pay for the rest.
    const perTable = await page.evaluate(() => {
        const w = document.querySelectorAll(".mw-table");
        return [...w].map((el) => el.querySelectorAll(".mw-grip").length);
    });
    check("a table the pointer never reached stays unbuilt", perTable[1] === 0, JSON.stringify(perTable));

    // ── 4. The keyboard path, with the pointer parked off every table ──
    // Shift+arrow makes a CellSelection with no pointer involved, and the grip
    // highlight is the only chrome meant to show for it. Park first: a click
    // hovers what it travels over, which would make this vacuous.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);

    // The caret has to reach the second table WITHOUT the pointer ever being
    // over it. Clicking its cell does not work and the first draft of this
    // check did exactly that: page.mouse.click puts the pointer on the target,
    // which reveals the table on the way in and builds the overlay before a key
    // is pressed — the check then passes while proving nothing. So click the
    // paragraph BETWEEN the tables (over no table at all) and walk the caret
    // down into the table with the keyboard.
    const between = await page.evaluate(() => {
        const p = [...document.querySelectorAll(".ProseMirror p")]
            .find((el) => el.textContent.includes("text between the tables"));
        const r = p.getBoundingClientRect();
        return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(between.x, between.y);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowDown"); // caret crosses into the second table
    await page.waitForTimeout(150);

    const beforeKeys = (await page.evaluate(() =>
        document.querySelectorAll(".mw-table")[1].querySelectorAll(".mw-grip").length));
    check("the second table is still unbuilt with the caret inside it", beforeKeys === 0, `grips=${beforeKeys}`);
    // Guard against the whole keyboard section going vacuous: if the caret
    // never made it into the table, Shift+ArrowDown proves nothing about a
    // CellSelection.
    const caretInside = await page.evaluate(() => {
        const t = document.querySelectorAll(".ProseMirror table")[1];
        const s = window.getSelection();
        return !!(s && s.anchorNode && t.contains(s.anchorNode));
    });
    check("…and the caret really is inside it (else the keys below prove nothing)", caretInside);

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(300);

    const keyboard = await page.evaluate(() => {
        const t = document.querySelectorAll(".mw-table")[1];
        return {
            grips: t.querySelectorAll(".mw-grip").length,
            active: t.querySelectorAll(".mw-grip--active").length,
        };
    });
    check("a keyboard cell selection builds the overlay with no pointer",
        keyboard.grips > 0, JSON.stringify(keyboard));
    check("…and lights the grip for the selected row", keyboard.active > 0, JSON.stringify(keyboard));

    // The runner adds its own "no page errors" check from a real pageerror
    // listener; a second one asked of the page would read an undefined global
    // and pass forever.
}
