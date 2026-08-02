/**
 * Checks-dropdown end-to-end checks against the real built bundle.
 *
 * The style sub-checks now live in a container nested under the "Check style"
 * master and are shown only while it's on: toggling Check Style off collapses
 * the menu to just the three masters (spelling / grammar / style); toggling it
 * back on restores the full grouped list.
 *
 * Leading the menu, above all of that, is "Highlight notes" — the in-text
 * editor-note highlight, a SIBLING of the Proofreading gate rather than one of
 * the things it governs. So it must survive the gate being turned off, and it
 * must stay first: the checks collapsing and returning below it is the visible
 * form of the two being independent. (The order check also pins the arrangement
 * the gate's `appendChild` re-attach depends on — see toolbarChecksNotes.test.ts.)
 */
export async function run({ page, check, baseUrl }) {
    const MENU = ".tb-checks-menu";

    async function load() {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForSelector('button[aria-label="Checks"]', { timeout: 10000 });
        await page.waitForTimeout(150);
    }

    /** Open the Checks menu via keyboard (hover is flaky headless). */
    async function openMenu() {
        await page.locator('button[aria-label="Checks"]').focus();
        await page.keyboard.press("ArrowDown");
        await page.waitForSelector(`${MENU}`, { state: "visible", timeout: 5000 });
        await page.waitForTimeout(100);
    }

    // Rows are on/off switches (createSwitchItem) since 338f8c9; the menu also
    // gained a 16th row — the master "Proofreading" gate above the body — and a
    // 17th, "Highlight notes", leading the menu as that gate's sibling.
    const labels = () => page.$$eval(`${MENU} .tb-switch-item-label`, (els) => els.map((e) => e.textContent));
    const rowCount = () => page.$$eval(`${MENU} .tb-switch-item`, (els) => els.length);
    const hasChildren = () => page.locator(`${MENU} .tb-checks-children`).count().then((n) => n > 0);
    const clickRow = async (label) => {
        await page.locator(`${MENU} .tb-switch-item`, { hasText: label }).first().click();
        await page.waitForTimeout(150);
    };

    // ── 1. Default (Check Style on): masters + grouped sub-checks ─────
    await load();
    await openMenu();
    let l = await labels();
    check("the three masters are present", ["Check spelling", "Check grammar", "Check style"].every((x) => l.includes(x)), JSON.stringify(l));
    check("style sub-checks are shown while Check Style is on", l.includes("Fillers") && l.includes("Long sentences"), JSON.stringify(l));
    check("sub-checks live in the nested children container", await hasChildren());
    check("full menu has all 17 rows (notes + gate + 15 checks)", (await rowCount()) === 17, String(await rowCount()));
    check("the notes highlight leads the menu, above the gate",
        JSON.stringify(l.slice(0, 2)) === JSON.stringify(["Highlight notes", "Proofreading"]), JSON.stringify(l));

    // ── 2. Toggle Check Style OFF → collapses to gate + 3 masters ─────
    await clickRow("Check style");
    l = await labels();
    check("Check Style off hides every style sub-check", !l.includes("Fillers") && !l.includes("Passive voice"), JSON.stringify(l));
    check("Check Style off leaves notes + the gate + 3 masters", (await rowCount()) === 5, String(await rowCount()));
    check("the nested children container is detached when off", !(await hasChildren()));
    check("the three masters remain after collapsing", ["Check spelling", "Check grammar", "Check style"].every((x) => l.includes(x)), JSON.stringify(l));

    // ── 3. Toggle Check Style back ON → sub-checks return ────────────
    await clickRow("Check style");
    l = await labels();
    check("re-enabling Check Style restores the sub-checks", l.includes("Fillers") && l.includes("Curly punctuation"), JSON.stringify(l));
    check("re-enabling restores all 17 rows", (await rowCount()) === 17, String(await rowCount()));

    // ── 4. Master gate OFF → menu collapses to the notes row + the gate ──
    // The note highlight is the writer's own content, not a finding, so the
    // proofreading gate must not take it away with the checks.
    await clickRow("Proofreading");
    l = await labels();
    check("gate off collapses the checks away", (await rowCount()) === 2, String(await rowCount()));
    check("gate off leaves the notes switch and the gate", JSON.stringify(l) === JSON.stringify(["Highlight notes", "Proofreading"]), JSON.stringify(l));

    // ── 5. Gate back ON → prior mix restored, IN ORDER ───────────────
    await clickRow("Proofreading");
    l = await labels();
    check("gate back on restores all 17 rows", (await rowCount()) === 17, String(await rowCount()));
    check("the notes highlight still leads after the gate cycles", l[0] === "Highlight notes", JSON.stringify(l));

    // ── 6. The notes switch flips itself, independent of the gate ────
    const notesState = () => page.$eval(`${MENU} .tb-switch-item`, (el) => el.getAttribute("aria-checked"));
    check("the notes highlight ships on", (await notesState()) === "true", await notesState());
    await clickRow("Highlight notes");
    check("clicking the notes switch turns it off", (await notesState()) === "false", await notesState());
    check("turning the highlight off leaves every other row alone", (await rowCount()) === 17, String(await rowCount()));
    await clickRow("Highlight notes");
    check("clicking it again turns it back on", (await notesState()) === "true", await notesState());
}
