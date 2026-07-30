/**
 * Find-in-selection scope shade (MAR-106).
 *
 * The scope is painted with the CSS Custom Highlight API, which jsdom does
 * not implement at all (`supportsHighlights()` is false there), so this is
 * the only place the behavior is observable: the registry entry, the range it
 * actually covers, and — the regression that matters — that the shade
 * survives a query with NO matches, which is exactly when the user needs to
 * see why their matches disappeared.
 *
 * The suite asserts the registry rather than pixels: `::highlight()` paint is
 * not readable from getComputedStyle, but the registered Range is what the
 * paint is derived from, and its `toString()` proves it covers the right text.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });

    const settle = () =>
        page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Precondition: without the API the whole feature no-ops, and every check
    // below would fail for the wrong reason.
    check(
        "the CSS Custom Highlight API is available",
        await page.evaluate(() => typeof CSS !== "undefined" && "highlights" in CSS),
    );

    /** The text the scope highlight currently covers, or null when unset. */
    const scopeText = () =>
        page.evaluate(() => {
            const highlight = CSS.highlights.get("find-scope");
            return highlight ? [...highlight].map((r) => r.toString()).join("|") : null;
        });
    /** Whether the lazily-injected `::highlight()` rules are in the document. */
    const highlightRulesPresent = () =>
        page.evaluate(() => Boolean(document.getElementById("find-highlight-styles")));
    const matchCount = () => page.$eval(".find-bar__count", (el) => el.textContent);
    const barVisible = () =>
        page.$eval(".find-bar", (el) => el.classList.contains("find-bar--visible"));
    const inSelectionBtn = '.find-bar__btn[aria-label="Find in Selection"]';

    /** Select a whole paragraph by its text, the way a triple-click does. */
    async function selectParagraph(text) {
        const handle = await page.$(`.ProseMirror p:text-is("${text}")`);
        await handle.click({ clickCount: 3 });
        await settle();
    }

    /** Replace the find query, driving the real input listener. */
    async function typeQuery(query) {
        await page.click(".find-bar__row:not(.find-bar__row--replace) .find-bar__input");
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(query);
        await settle();
        // The input handler debounces its rescan.
        await page.waitForTimeout(250);
    }

    // ── Toggling the scope on shades the captured range ──
    await selectParagraph("Alpha needle here.");
    check("nothing is shaded before the scope exists", (await scopeText()) === null);
    // The paint rules are injected on first use, never shipped in the eager
    // stylesheet: an unused `::highlight()` rule costs per-element style recalc
    // on every launch (webview/components/findBar/highlightStyles.ts). A launch
    // that never searches must not carry them.
    check("a launch that never searched carries no highlight rules", !(await highlightRulesPresent()));

    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "openFind" }, "*"));
    await page.waitForSelector(".find-bar--visible", { timeout: 5000 });
    check("the find bar opened", await barVisible());
    check("opening the bar alone shades nothing", (await scopeText()) === null);

    await page.click(inSelectionBtn);
    await settle();
    check(
        "toggling Find in Selection shades exactly the captured paragraph",
        (await scopeText()) === "Alpha needle here.",
        String(await scopeText()),
    );
    check(
        "the first shade brings the highlight rules with it",
        await highlightRulesPresent(),
    );

    // ── The shade explains a filtered result ──
    await typeQuery("needle");
    check(
        "a word present in both paragraphs reports only the in-scope match",
        (await matchCount()) === "1/1",
        String(await matchCount()),
    );
    check(
        "the shade stays put while the scoped search runs",
        (await scopeText()) === "Alpha needle here.",
        String(await scopeText()),
    );

    await typeQuery("zzzznotpresent");
    check("a query with no matches reports none", (await matchCount()) !== "1/1");
    check(
        "the shade survives a query with no matches",
        (await scopeText()) === "Alpha needle here.",
        String(await scopeText()),
    );

    // ── Dropping the scope drops the shade ──
    await page.click(inSelectionBtn);
    await settle();
    check("toggling Find in Selection off clears the shade", (await scopeText()) === null);

    // ── Scoping WHILE nothing matches ──
    // The regression this pins: the paint must happen before the "no ranges"
    // early return in updateHighlights. Move it after, and this — the one
    // moment the user most needs the scope explained, since every match has
    // just disappeared — is the case that never paints.
    await selectParagraph("Beta needle here.");
    await page.click(inSelectionBtn);
    await settle();
    check("the scope still reports no matches", (await matchCount()) !== "1/1");
    check(
        "scoping to a selection shades it even when the query matches nothing",
        (await scopeText()) === "Beta needle here.",
        String(await scopeText()),
    );

    await page.evaluate(() => document.querySelector(".ProseMirror").focus());
    await settle();
    await page.keyboard.press("Escape");
    await settle();
    check("closing the bar clears the shade", (await scopeText()) === null);
    check("closing the bar closed the bar", !(await barVisible()));
}
