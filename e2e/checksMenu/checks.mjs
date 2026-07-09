/**
 * Checks-dropdown end-to-end checks against the real built bundle.
 *
 * The style sub-checks now live in a container nested under the "Check style"
 * master and are shown only while it's on: toggling Check Style off collapses
 * the menu to just the three masters (spelling / grammar / style); toggling it
 * back on restores the full grouped list.
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

    const labels = () => page.$$eval(`${MENU} .tb-check-label`, (els) => els.map((e) => e.textContent));
    const rowCount = () => page.$$eval(`${MENU} .tb-check-item`, (els) => els.length);
    const hasChildren = () => page.locator(`${MENU} .tb-checks-children`).count().then((n) => n > 0);
    const clickRow = async (label) => {
        await page.locator(`${MENU} .tb-check-item`, { hasText: label }).first().click();
        await page.waitForTimeout(150);
    };

    // ── 1. Default (Check Style on): masters + grouped sub-checks ─────
    await load();
    await openMenu();
    let l = await labels();
    check("the three masters are present", ["Check spelling", "Check grammar", "Check style"].every((x) => l.includes(x)), JSON.stringify(l));
    check("style sub-checks are shown while Check Style is on", l.includes("Fillers") && l.includes("Long sentences"), JSON.stringify(l));
    check("sub-checks live in the nested children container", await hasChildren());
    check("full menu has all 15 check rows", (await rowCount()) === 15, String(await rowCount()));

    // ── 2. Toggle Check Style OFF → collapses to just the 3 masters ───
    await clickRow("Check style");
    l = await labels();
    check("Check Style off hides every style sub-check", !l.includes("Fillers") && !l.includes("Passive voice"), JSON.stringify(l));
    check("Check Style off leaves exactly the 3 masters", (await rowCount()) === 3, String(await rowCount()));
    check("the nested children container is detached when off", !(await hasChildren()));
    check("the three masters remain after collapsing", ["Check spelling", "Check grammar", "Check style"].every((x) => l.includes(x)), JSON.stringify(l));

    // ── 3. Toggle Check Style back ON → sub-checks return ────────────
    await clickRow("Check style");
    l = await labels();
    check("re-enabling Check Style restores the sub-checks", l.includes("Fillers") && l.includes("Curly punctuation"), JSON.stringify(l));
    check("re-enabling restores all 15 rows", (await rowCount()) === 15, String(await rowCount()));
}
