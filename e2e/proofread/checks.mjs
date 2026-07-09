/**
 * Proofread findings-popup end-to-end checks against the real built bundle.
 *
 * The redesign makes every style-check hit clickable (not just Harper's
 * spell/grammar), routes them all through one popup, and stacks overlapping
 * findings most-specific-first. These checks exercise that on the pure
 * webview-side style checks (grammar/spell are stubbed off in index.html):
 *   - a filler hit opens a popup with a category chip + Remove/Ignore actions
 *   - clicking a filler inside a long sentence stacks two findings
 *   - "Remove" deletes the flagged span; "Ignore" clears the finding
 */
export async function run({ page, check, baseUrl }) {
    const POPUP = ".pf-popup";

    async function load() {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /The report we prepared/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        // The first proofread pass is deferred to requestIdleCallback; wait for
        // the style decorations to actually land.
        await page.waitForSelector(".pf-style-hit", { timeout: 10000 });
        await page.waitForTimeout(150);
    }

    /** Click the filler word "really" (its own strikethrough sub-span). */
    async function clickFiller() {
        await page.locator(".milkdown .ProseMirror").getByText("really", { exact: true }).first().click();
        await page.waitForSelector(POPUP, { state: "visible", timeout: 5000 });
        await page.waitForTimeout(100);
    }

    const tags = () => page.$$eval(`${POPUP} .pf-popup-tag`, (els) => els.map((e) => e.textContent));
    const buttons = () => page.$$eval(`${POPUP} .pf-popup-item`, (els) => els.map((e) => e.textContent));
    const docText = () => page.$eval(".milkdown .ProseMirror", (el) => el.textContent ?? "");

    // ── 1. A style hit is now clickable and opens the popup ──────────
    await load();
    const flagged = await page.$$eval(".pf-style-hit", (els) => els.map((e) => e.textContent));
    check("the filler 'really' is decorated as a style hit", flagged.some((t) => /really/.test(t)), JSON.stringify(flagged));

    await clickFiller();
    check("clicking a style hit opens the findings popup", await page.locator(POPUP).isVisible());

    // ── 2. Overlapping findings stack, most-specific first ───────────
    const t = await tags();
    check("popup shows a Filler section", t.includes("Filler"), JSON.stringify(t));
    check("popup also stacks the Long sentence section", t.includes("Long sentence"), JSON.stringify(t));
    check("the filler (smaller span) is listed first", t[0] === "Filler", JSON.stringify(t));

    const b = await buttons();
    check("the filler offers a Remove action", b.includes("Remove"), JSON.stringify(b));
    check("every finding offers Ignore", b.filter((x) => x === "Ignore").length >= 2, JSON.stringify(b));
    check("a judgment-only flag (long sentence) offers no Fix/Remove beyond Ignore", !b.includes("Fix"), JSON.stringify(b));

    // ── 3. Remove deletes the flagged span and closes the popup ──────
    await page.locator(`${POPUP} .pf-popup-item`, { hasText: "Remove" }).first().click();
    await page.waitForTimeout(200);
    check("popup closes after applying an action", !(await page.locator(POPUP).isVisible()));
    check("the filler word is removed from the document", !/really/.test(await docText()), await docText());

    // ── 4. Ignore clears a finding without editing the text ──────────
    await load();
    // "every" is a filler too; use it to test Ignore leaves the text intact.
    await page.locator(".milkdown .ProseMirror").getByText("really", { exact: true }).first().click();
    await page.waitForSelector(POPUP, { state: "visible", timeout: 5000 });
    await page.locator(`${POPUP} .pf-popup-ignore`, { hasText: "Ignore" }).first().click();
    await page.waitForTimeout(250);
    check("Ignore leaves the document text unchanged", /really/.test(await docText()), await docText());
    const stillFlagged = await page.$$eval(".pf-style-hit", (els) => els.map((e) => e.textContent));
    check("Ignore clears the filler decoration", !stillFlagged.some((x) => x.trim() === "really"), JSON.stringify(stillFlagged));
}
