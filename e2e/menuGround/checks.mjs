/**
 * The shared menu ground and the paired row states, measured as COMPUTED style
 * in a real browser. Three things live here and nowhere else.
 *
 * 1. Every floating surface computes the same background. jsdom has no cascade
 *    worth trusting and the CSS guard (webview/__tests__/menuGrounds.test.ts)
 *    only reads the text of a declaration — neither can say what a variable
 *    chain actually RESOLVES to. The harness hands the four widget grounds four
 *    different values on purpose, so a surface that slipped back to the wrong
 *    token computes a different color rather than the same one by luck.
 *
 * 2. `--ui-menu-ink-dim` is `color-mix(in srgb, currentColor 80%, transparent)`.
 *    That resolves against the ROW's inherited color, which is the whole reason
 *    it can dim correctly on a resting ground and on a hover wash with one
 *    declaration. `currentColor` inside a custom property inside color-mix is
 *    exactly the sort of thing that either works or silently computes to
 *    something useless, and only a browser can answer it.
 *
 * 3. A keyboard-focused row carries a background and an ink DIFFERENT from the
 *    resting ink, and no rule of its own. The harness paints
 *    list.activeSelectionBackground a solid #0060c0 the way VS Code Light+
 *    does; a row that took that fill and kept the resting #d4d4d4 was the
 *    shipped 1.75:1 defect.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(200);

    const bg = (sel) => page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
    const ink = (sel) => page.$eval(sel, (el) => getComputedStyle(el).color);

    /**
     * A computed color as [r, g, b, a] with channels 0-255.
     *
     * Two serializations turn up here and they are not interchangeable.
     * `rgb()`/`rgba()` carry 0-255 channels; a `color-mix()` result serializes
     * as `color(srgb r g b / a)` with 0-1 channels — reading those as 0-255
     * makes a light ink measure as near-black, which is a lie in the direction
     * that passes a "dimmer than the label" check while failing everything
     * after it.
     */
    const parse = (s) => {
        const n = s.match(/[\d.]+(?:e[-+]?\d+)?/g).map(Number);
        const scale = s.startsWith("color(") ? 255 : 1;
        return [n[0] * scale, n[1] * scale, n[2] * scale, n.length > 3 ? n[3] : 1];
    };

    /** Composite a possibly-translucent ink onto its opaque ground. */
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));

    /**
     * Contrast of an ink against a ground, alpha included. The dim ink is
     * translucent BY DESIGN — that is how one declaration tracks the resting
     * ground and the hover wash — so measuring it without compositing measures
     * a color that is never on screen.
     */
    const contrast = (inkStr, groundStr) => {
        const ground = parse(groundStr);
        const c = over(parse(inkStr), ground);
        const lum = (rgb) =>
            rgb.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
                .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
        const [x, y] = [lum(c), lum(ground.slice(0, 3))].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
    };

    // The ground the harness assigns to editorHoverWidget.background. Every
    // floating surface must land here and not on one of the other three.
    const CARD = "rgb(37, 37, 38)";

    // ── 1. One ground across three menus opened three different ways ──
    const type = async (text) => {
        await page.click(".milkdown .ProseMirror p");
        await page.keyboard.press("End");
        await page.keyboard.type(text);
    };

    // Slash menu: used to read editorSuggestWidget.background (#1a1a2e here).
    await type("\n/");
    await page.waitForSelector(".slash-menu", { state: "visible", timeout: 5000 });
    check("the slash menu paints the shared card ground", (await bg(".slash-menu")) === CARD, await bg(".slash-menu"));

    // Sample a row that is NOT the focused one. The slash menu focuses its
    // first row on open, and that row is deliberately the one place the ink
    // rules differ — reading "resting" off it measures the selected state and
    // every comparison below then compares white to white.
    const RESTING = ".slash-menu-item:not(.slash-menu-item--focused)";
    const restingInk = await ink(`${RESTING} .slash-menu-item-label`);
    const dimInk = await ink(`${RESTING} :is(.slash-menu-item-icon, .slash-menu-item-badge)`);

    // ── 2. The dim ink resolves against the row, and actually dims ──
    check("the row's secondary ink differs from its label ink", dimInk !== restingInk, `${dimInk} vs ${restingInk}`);
    check("the secondary ink is DIMMER, not merely different",
        contrast(dimInk, CARD) < contrast(restingInk, CARD),
        `${contrast(dimInk, CARD).toFixed(2)} vs ${contrast(restingInk, CARD).toFixed(2)}`);
    // The whole point of currentColor over a fixed descriptionForeground: it
    // still clears AA against the ground it is actually on.
    check("the secondary ink still clears AA on the menu ground",
        contrast(dimInk, CARD) >= 4.5, contrast(dimInk, CARD).toFixed(2));
    // The mix has to land on the ROW's own ink, not on some fixed color. That
    // is the single property the whole design rests on, so assert the identity
    // rather than merely "it is not black": the dim must be the resting ink
    // with alpha, which is what makes one declaration correct on every ground.
    const dimParsed = parse(dimInk);
    const restingParsed = parse(restingInk);
    check("the secondary ink is the row's OWN ink, carried at reduced alpha",
        dimParsed[3] < 1 && dimParsed.slice(0, 3).every((v, i) => Math.abs(v - restingParsed[i]) <= 1),
        `${dimInk} derived from ${restingInk}`);

    // ── 3. The keyboard row: ground, ink, and outline together ──
    const focused = ".slash-menu-item--focused";
    const focusedStyle = await page.$eval(focused, (el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle };
    });
    check("the focused row takes the selection ground", focusedStyle.bg === "rgb(0, 96, 192)", focusedStyle.bg);
    check("the focused row takes the selection INK with it",
        focusedStyle.color !== restingInk, `${focusedStyle.color} vs resting ${restingInk}`);
    check("the focused row's label clears AA on its own fill",
        contrast(focusedStyle.color, focusedStyle.bg) >= 4.5,
        contrast(focusedStyle.color, focusedStyle.bg).toFixed(2));
    // The ground and its ink are the whole state; a rule drawn inside the row
    // box reads as a hairline above and below it, which is a group divider's
    // spelling, so the row must draw none. Asserted on the COMPUTED style
    // because that is what a reader sees: a source-text guard would still pass
    // with the outline reinstated from some other rule in the cascade.
    check("the focused row draws no rule of its own",
        focusedStyle.outlineStyle === "none" || parseFloat(focusedStyle.outlineWidth) === 0,
        `${focusedStyle.outlineStyle} ${focusedStyle.outlineWidth}`);
    // A filled row shows its parts at full ink — the dim would be spent against
    // a fill whose knockout the theme already chose.
    const focusedPartInk = await ink(`${focused} :is(.slash-menu-item-icon, .slash-menu-item-badge)`);
    check("the focused row's icon is at full ink, not dimmed",
        focusedPartInk === focusedStyle.color, `${focusedPartInk} vs ${focusedStyle.color}`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // ── 4. The code-block language picker: used to read dropdown.background ──
    await page.click(".lang-picker-btn");
    await page.waitForSelector(".lang-picker-dropdown", { state: "visible", timeout: 5000 });
    check("the language picker paints the shared card ground",
        (await bg(".lang-picker-dropdown")) === CARD, await bg(".lang-picker-dropdown"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // ── 5. The gutter block menu: the surface that already had it ──
    await page.hover(".milkdown .ProseMirror h1");
    await page.waitForTimeout(150);
    const marker = await page.$(".heading-fold-marker--block, .block-gutter-marker");
    if (marker) {
        await marker.click();
        await page.waitForSelector(".block-menu", { state: "visible", timeout: 5000 });
        check("the block menu paints the shared card ground", (await bg(".block-menu")) === CARD, await bg(".block-menu"));
        await page.keyboard.press("Escape");
    } else {
        check("the block menu's gutter marker is reachable", false, "no marker found to open the menu");
    }
}
