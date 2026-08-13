/**
 * Font changes keep the top visible line stable (scrollAnchor.ts, wired into
 * the setFontFamily / setFontSize apply paths). Both reflow the whole document:
 * a family swap changes every glyph's advance width, a size step changes every
 * line's height.
 *
 * Two regimes, because Chromium's own scroll anchoring covers one of these and
 * not the other, and a suite that ignored the difference would be reporting the
 * browser's work as ours:
 *
 * - Production regime (the harness page as it ships, no overflow-anchor rules):
 *   the size stepper. The browser's heuristic does NOT hold this one, so these
 *   checks fail outright with withScrollAnchor removed. This is the regression
 *   guard that matters.
 * - Isolation regime (overflow-anchor: none injected): the family swaps. The
 *   browser absorbs these unaided in every focus and document shape probed, so
 *   under production CSS they would pass with our code deleted. Taking the
 *   heuristic away is what makes them a guard on OUR anchor, which is the one
 *   that is exact rather than best-effort: it picks the top visible line rather
 *   than the browser's own choice of anchor node, and no style change in the
 *   same frame can suppress it.
 *
 * Every case first proves the scenario is real by requiring the document's
 * height to change, so a font that failed to resolve fails a check instead of
 * passing vacuously on a zero-delta reflow.
 */

export async function run({ page, check, baseUrl }) {
    const fontWrap = page.locator('[data-item-id="fontPreset"]');
    const fontItems = page.locator(".tb-font-menu .tb-font-item");

    async function load({ isolate }) {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.setViewportSize({ width: 900, height: 400 });
        if (isolate) {
            // Exclude every element from the browser's anchor-node selection.
            await page.addStyleTag({ content: "body { overflow-anchor: none; }" });
        }
        await page.waitForTimeout(300);
    }

    /**
     * Scroll `para 30` so its FIRST LINE straddles the anchor probe (a few px
     * above the topbar's bottom edge). The anchor holds the character under
     * the probe still, so the probe has to land inside the paragraph we then
     * measure: park the paragraph just below the probe instead and the anchored
     * line is its predecessor, whose own height change the target inherits.
     */
    const scrollTargetToTop = () =>
        page.evaluate(() => {
            const target = [...document.querySelectorAll(".ProseMirror p")]
                .find((p) => p.textContent.startsWith("para 30"));
            const topbar = document.querySelector(".editor-topbar").getBoundingClientRect().height;
            window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - topbar + 6 });
        });
    const targetTop = () =>
        page.evaluate(() => {
            const target = [...document.querySelectorAll(".ProseMirror p")]
                .find((p) => p.textContent.startsWith("para 30"));
            return target ? target.getBoundingClientRect().top : null;
        });
    const docHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
    const contentFamily = () =>
        page.evaluate(() =>
            getComputedStyle(document.querySelector(".ProseMirror p")).fontFamily,
        );

    /** Open the (A) menu and click the row with this label. */
    const pickFont = async (label) => {
        await fontWrap.dispatchEvent("mouseenter");
        await page.waitForTimeout(150);
        const count = await fontItems.count();
        for (let i = 0; i < count; i++) {
            const item = fontItems.nth(i);
            if ((await item.textContent()).trim() === label) {
                await item.dispatchEvent("mousedown");
                await page.waitForTimeout(200);
                return true;
            }
        }
        return false;
    };

    /** Step the size with the menu's A+ button, `n` times. */
    const stepSizeUp = async (n) => {
        await fontWrap.dispatchEvent("mouseenter");
        await page.waitForTimeout(150);
        for (let i = 0; i < n; i++) {
            await page.locator(".tb-font-size-btn--inc").dispatchEvent("mousedown");
            await page.waitForTimeout(150);
        }
        await page.waitForTimeout(150);
    };

    // ── Production regime: the size stepper ──────────────────────────────────
    await load({ isolate: false });
    await scrollTargetToTop();
    await page.waitForTimeout(100);
    const beforeSize = await targetTop();
    const heightBeforeSize = await docHeight();

    // Two steps up: 100% → 120%, a reflow no anchor could absorb by accident.
    await stepSizeUp(2);
    const scale = await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--content-font-scale").trim(),
    );
    check("two A+ steps set --content-font-scale to 1.2", scale === "1.2", scale);
    const heightAfterSize = await docHeight();
    check(
        "the size step really re-heighted the document (non-vacuous)",
        heightAfterSize - heightBeforeSize > 20,
        `before=${heightBeforeSize} after=${heightAfterSize}`,
    );
    const afterSize = await targetTop();
    check(
        "stepping the font size keeps the top visible line at the top",
        afterSize !== null && Math.abs(afterSize - beforeSize) <= 6,
        `before=${beforeSize?.toFixed(0)} after=${afterSize?.toFixed(0)}`,
    );

    // ── Isolation regime: the family swaps ───────────────────────────────────
    await load({ isolate: true });
    await scrollTargetToTop();
    await page.waitForTimeout(100);
    const beforeSerif = await targetTop();
    const heightBeforeSerif = await docHeight();

    check("the menu offers a Serif row", await pickFont("Serif"));
    check(
        "picking Serif applies the serif stack to the content",
        /serif/i.test(await contentFamily()) && !/verdana/i.test(await contentFamily()),
        await contentFamily(),
    );
    const heightAfterSerif = await docHeight();
    check(
        "the serif swap really reflowed the document (non-vacuous)",
        Math.abs(heightAfterSerif - heightBeforeSerif) > 20,
        `before=${heightBeforeSerif} after=${heightAfterSerif}`,
    );
    const afterSerif = await targetTop();
    check(
        "switching to Serif keeps the top visible line at the top",
        afterSerif !== null && Math.abs(afterSerif - beforeSerif) <= 6,
        `before=${beforeSerif?.toFixed(0)} after=${afterSerif?.toFixed(0)}`,
    );

    const beforeMono = await targetTop();
    const heightBeforeMono = await docHeight();
    check("the menu offers a Monospace row", await pickFont("Monospace"));
    const heightAfterMono = await docHeight();
    check(
        "the monospace swap really reflowed the document (non-vacuous)",
        Math.abs(heightAfterMono - heightBeforeMono) > 20,
        `before=${heightBeforeMono} after=${heightAfterMono}`,
    );
    const afterMono = await targetTop();
    check(
        "switching to Monospace keeps it there too",
        afterMono !== null && Math.abs(afterMono - beforeMono) <= 6,
        `before=${beforeMono?.toFixed(0)} after=${afterMono?.toFixed(0)}`,
    );

    // Back to the editor font: the null-family path (removeProperty) anchors too.
    const beforeEditor = await targetTop();
    const heightBeforeEditor = await docHeight();
    check("the menu offers an Editor font row", await pickFont("Editor font"));
    check(
        "picking Editor font clears the content family override",
        (await page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--content-font-family"),
        )) === "",
    );
    const heightAfterEditor = await docHeight();
    check(
        "the return to the editor font really reflowed the document (non-vacuous)",
        Math.abs(heightAfterEditor - heightBeforeEditor) > 20,
        `before=${heightBeforeEditor} after=${heightAfterEditor}`,
    );
    const afterEditor = await targetTop();
    check(
        "returning to the editor font keeps the top visible line at the top",
        afterEditor !== null && Math.abs(afterEditor - beforeEditor) <= 6,
        `before=${beforeEditor?.toFixed(0)} after=${afterEditor?.toFixed(0)}`,
    );

    // The preset picks reached the extension as settings writes, not just CSS.
    const presets = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "setFontPreset").map((m) => m.preset),
    );
    check(
        "each pick posted its preset for persistence",
        presets.join(",") === "serif,mono,editor",
        presets.join(","),
    );
}
