/**
 * The closed vocabulary on the `=` path: call names and constants compute,
 * variables do not. Real-browser truths jsdom can't reach:
 *   - a call-bearing equation raises the ordinary answer menu, and
 *     capture-phase Tab accepts it into the document,
 *   - a constant glyph typed straight into prose does the same,
 *   - with `birta.calc.autoInsert` on, the answer arrives from the INPUT RULE
 *     on the typed `=` — dispatch a unit test cannot exercise, since calling
 *     the handler directly skips the rule that decides whether it runs,
 *   - a name outside the vocabulary raises nothing at all, which is the
 *     property that keeps prose safe,
 *   - the serialized markdown carries the equation and a plain-text answer,
 *     with nothing calc-specific left behind.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });

    const lastUpdate = () => page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length > 0 ? updates[updates.length - 1].content : null;
    });
    const waitForUpdate = async (predicate) => {
        for (let i = 0; i < 30; i++) {
            const doc = await lastUpdate();
            if (predicate(doc)) { return doc; }
            await page.waitForTimeout(100);
        }
        return lastUpdate();
    };
    const menuRows = () => page.$$eval(".fm-suggest-menu .fm-suggest-item", (els) =>
        els.map((el) => ({
            label: el.querySelector(".fm-suggest-item__label")?.textContent ?? el.textContent,
            hint: el.querySelector(".fm-suggest-item__hint")?.textContent ?? null,
        })),
    ).catch(() => null);
    const typeInto = async (paragraph, text) => {
        await page.click(`.ProseMirror p:has-text('${paragraph}')`);
        await page.keyboard.press("End");
        await page.keyboard.type(text, { delay: 12 });
        await page.waitForTimeout(450); // 200ms suggest debounce + margin
    };

    // ── 1. A call carries the run: the answer is offered, Tab accepts it ──
    await typeInto("first", " 3+log10(100)=");
    let rows = await menuRows();
    check("a call-bearing equation offers its answer",
        rows?.length >= 1 && rows[0].label === "5", JSON.stringify(rows));
    await page.keyboard.press("Tab");
    let doc = await waitForUpdate((d) => d?.includes("3+log10(100)= 5"));
    check("Tab writes the answer as plain text after the equation",
        doc?.includes("first 3+log10(100)= 5"), doc);

    // ── 2. A constant glyph, typed into prose ──
    await typeInto("second", " π^2=");
    rows = await menuRows();
    check("a constant glyph computes too",
        rows?.[0]?.label === "9.869604", JSON.stringify(rows));
    await page.keyboard.press("Tab");
    doc = await waitForUpdate((d) => d?.includes("π^2= 9.869604"));
    check("the accepted answer round-trips as ordinary markdown",
        doc?.includes("second π^2= 9.869604") && !doc.includes("calc"), doc);

    // ── 3. A name outside the vocabulary raises nothing ──
    // No Escape here: Escape is the block-selection gesture, and a selected
    // block would be REPLACED by the next step's typing.
    await typeInto("third", " total + 2 =");
    rows = await menuRows();
    check("a variable name offers nothing — prose stays prose",
        rows === null || rows.length === 0, JSON.stringify(rows));
    doc = await waitForUpdate((d) => d?.includes("third total + 2 ="));
    check("the refused equation stays in the document verbatim, unanswered",
        doc?.includes("third total + 2 =") && !/total \+ 2 = ?\d/.test(doc), doc);

    // ── 4. Auto-insert: the input rule answers the moment `=` is typed ──
    await page.evaluate(() => { window.__i18n.calcAutoInsert = true; });
    await typeInto("fourth", " sqrt(16)+1=");
    doc = await waitForUpdate((d) => d?.includes("sqrt(16)+1= 5"));
    check("the input rule inserts the answer on the typed `=`, with no menu",
        doc?.includes("fourth sqrt(16)+1= 5"), doc);
    rows = await menuRows();
    check("auto-insert leaves no menu behind",
        rows === null || rows.length === 0, JSON.stringify(rows));

    const errors = await page.evaluate(() => window.__pageErrors ?? []);
    check("no page errors", errors.length === 0, JSON.stringify(errors));
}
