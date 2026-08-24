/**
 * A name in a `=>` equation that reads two ways — the engine refuses to guess
 * and offers each reading instead. Two kinds of name, one seam: a FUNCTION the
 * world cannot agree on (`log`), and a UNIT whose meaning the legacy case-fold
 * would decide (`ML`, the millilitre to the fold and the megalitre to the
 * catalog). They are checked in the same file because they must behave
 * identically; a second mechanism for units would show up here as a difference.
 *
 * Real-browser truths jsdom can't reach:
 *   - the menu renders one row PER READING, each showing the number that
 *     reading answers, so the choice is made against the values,
 *   - Tab (capture-phase, via the caret-suggest controller) picks the
 *     pre-highlighted row, and ArrowDown moves to the other one,
 *   - a pick rewrites the EXPRESSION as well as writing the answer, so the
 *     serialized markdown reads `log10(100) => 2` or `500 milliliter in l =>
 *     0.5` — an equation that can only be read one way wherever it is pasted,
 *   - an unambiguous expression still gets the ordinary single-row menu, and
 *     so does a fold-only spelling like `KM`, which has no second reading.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });

    const lastUpdate = () => page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length > 0 ? updates[updates.length - 1].content : null;
    });
    // Updates are debounced — poll until the serialized doc satisfies
    // `predicate`, or time out returning the latest for logging.
    const waitForUpdate = async (predicate) => {
        for (let i = 0; i < 30; i++) {
            const doc = await lastUpdate();
            if (predicate(doc)) { return doc; }
            await page.waitForTimeout(100);
        }
        return lastUpdate();
    };
    /** The menu's rows as `{ label, hint }`, or null when no menu is open. */
    const menuRows = () => page.$$eval(".fm-suggest-menu .fm-suggest-item", (els) =>
        els.map((el) => ({
            label: el.querySelector(".fm-suggest-item__label")?.textContent ?? el.textContent,
            hint: el.querySelector(".fm-suggest-item__hint")?.textContent ?? null,
            focused: el.classList.contains("fm-suggest-item--focused"),
        })),
    ).catch(() => null);
    /** Type an expression at the end of `paragraph` and wait for the menu. */
    const typeInto = async (paragraph, text) => {
        await page.click(`.ProseMirror p:has-text('${paragraph}')`);
        await page.keyboard.press("End");
        await page.keyboard.type(text, { delay: 12 });
        await page.waitForTimeout(450); // 200ms suggest debounce + margin
    };

    // ── 1. `log(100) =>` offers both readings, never an answer of its own ──
    await typeInto("first", " log(100) =>");
    let rows = await menuRows();
    check("an ambiguous `log` offers one row per reading",
        rows?.length === 2 && rows[0].label === "log10" && rows[1].label === "ln",
        JSON.stringify(rows));
    check("each reading shows the number IT would answer",
        rows?.[0]?.hint === "2" && rows?.[1]?.hint?.startsWith("4.60517"),
        JSON.stringify(rows));
    const footer = await page.$eval(".fm-suggest-menu .fm-suggest-footer", (el) => el.textContent)
        .catch(() => "");
    check("the menu names the ambiguity and says how to confirm",
        footer.includes("log") && footer.includes("Tab"), footer);

    // Tab confirms the pre-highlighted first row — and must rewrite the CALL,
    // not just append a number.
    await page.keyboard.press("Tab");
    let doc = await waitForUpdate((d) => d?.includes("=>") && d.includes("log10"));
    check("picking a reading rewrites the equation itself, answer included",
        doc?.includes("log10(100) => 2") && !/(^|[^0-9a-z])log\(/i.test(doc),
        JSON.stringify(doc?.split("\n").find((l) => l.includes("=>"))));

    // ── 2. ArrowDown reaches the other reading, which answers differently ──
    await typeInto("second", " log(100) =>");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(80);
    rows = await menuRows();
    check("ArrowDown moves the highlight to the second reading",
        rows?.[1]?.focused === true && rows?.[0]?.focused === false,
        JSON.stringify(rows));
    await page.keyboard.press("Tab");
    doc = await waitForUpdate((d) => d?.includes("ln(100) =>"));
    check("the natural-log reading writes ln and its own answer",
        doc?.includes("ln(100) => 4.60517"),
        JSON.stringify(doc?.split("\n").find((l) => l.includes("ln("))));

    // ── 3. An unambiguous expression is untouched by any of this ──
    await typeInto("third", " log10(1000) =>");
    rows = await menuRows();
    check("an explicit name still gets the ordinary single-row answer",
        rows?.length === 1 && rows[0].label === "3",
        JSON.stringify(rows));
    await page.keyboard.press("Tab");
    doc = await waitForUpdate((d) => d?.includes("log10(1000) => 3"));
    check("confirming it writes the answer and nothing else",
        doc?.includes("log10(1000) => 3"),
        JSON.stringify(doc?.split("\n").find((l) => l.includes("1000"))));

    // ── 4. A unit name the case-fold would decide asks the same way ────────
    // Same menu, same footer, same Tab, same rewrite — because it is the same
    // seam, not a second one. `ML` is the millilitre to the legacy fold and
    // the megalitre to the catalog, a 10^9 difference that looks like an
    // answer either way, which is exactly why it must be asked rather than
    // picked.
    await typeInto("fourth", " 500 ML in l =>");
    rows = await menuRows();
    check("an ambiguous UNIT offers one row per reading",
        rows?.length === 2 && rows[0].label === "milliliter" && rows[1].label === "megaliter",
        JSON.stringify(rows));
    check("each unit reading shows the number IT would answer",
        rows?.[0]?.hint === "0.5" && rows?.[1]?.hint !== rows?.[0]?.hint,
        JSON.stringify(rows));
    const unitFooter = await page.$eval(".fm-suggest-menu .fm-suggest-footer", (el) => el.textContent)
        .catch(() => "");
    check("the footer names the unit, not a hardcoded function name",
        unitFooter.includes("ML") && unitFooter.includes("Tab"), unitFooter);

    await page.keyboard.press("Tab");
    doc = await waitForUpdate((d) => d?.includes("milliliter"));
    check("picking a unit reading rewrites the equation, answer included",
        doc?.includes("500 milliliter in l => 0.5") && !doc.includes("500 ML in"),
        JSON.stringify(doc?.split("\n").find((l) => l.includes("milliliter"))));

    // ── 5. The other reading, which is the whole point of asking ───────────
    await typeInto("fifth", " 500 ML in l =>");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(80);
    await page.keyboard.press("Tab");
    doc = await waitForUpdate((d) => d?.includes("megaliter"));
    check("the megalitre reading writes its own, very different answer",
        doc?.includes("500 megaliter in l => 500000000"),
        JSON.stringify(doc?.split("\n").find((l) => l.includes("megaliter"))));

    // ── 6. A fold-only spelling is NOT a question ──────────────────────────
    // The large majority of capitalised spellings have no competing reading —
    // `KM` resolves to nothing without the fold — so they must still answer
    // straight out. A version that asked about these would be unusable.
    await typeInto("sixth", " 3 KM in m =>");
    rows = await menuRows();
    check("a fold-only spelling still gets the ordinary single-row answer",
        rows?.length === 1 && rows[0].label === "3000",
        JSON.stringify(rows));
}
