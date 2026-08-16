/**
 * The what's-new unread dot (MAR-357), in a real browser.
 *
 * The jsdom suite (`webview/__tests__/whatsNewIndicator.test.ts`) pins the
 * wiring: the class goes on, opening the menu takes it off, and the host is
 * told exactly once. None of that answers the question a user actually asks,
 * because jsdom has no layout engine and no `::after` box: IS THE DOT PAINTED,
 * and is it on the gear rather than somewhere off in the corner.
 *
 * So this suite asserts geometry and paint, which is the half that can only be
 * seen here. It reads the `::after` pseudo-element directly, because the dot
 * has no element of its own to query.
 */

/** The settings gear trigger, and the wrap the hover listener lives on. */
const GEAR = ".tb-fmt-wrap:has(.tb-settings-menu)";

async function dotBox(page) {
    return page.evaluate((sel) => {
        const wrap = document.querySelector(sel);
        const btn = wrap?.querySelector("button, .tb-btn, [aria-haspopup]") ?? wrap?.firstElementChild;
        if (!btn) return null;
        const style = getComputedStyle(btn, "::after");
        const rect = btn.getBoundingClientRect();
        return {
            marked: btn.classList.contains("tb-gear--unread"),
            content: style.content,
            width: parseFloat(style.width) || 0,
            height: parseFloat(style.height) || 0,
            radius: style.borderRadius,
            bg: style.backgroundColor,
            pointerEvents: style.pointerEvents,
            gearW: Math.round(rect.width),
            gearH: Math.round(rect.height),
        };
    }, GEAR);
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(GEAR, { timeout: 15000 });

    // ── 1. Nothing is painted before the host says so ──
    const before = await dotBox(page);
    check(
        "the gear rests with no dot",
        before?.marked === false && before.width === 0,
        JSON.stringify(before),
    );

    // ── 2. The host's verdict paints a dot ──
    await page.evaluate(() => window.postMessage({ type: "whatsNewUnread", unread: true }, "*"));
    await page.waitForFunction(
        (sel) => {
            const wrap = document.querySelector(sel);
            const btn = wrap?.querySelector("button, .tb-btn, [aria-haspopup]") ?? wrap?.firstElementChild;
            return btn?.classList.contains("tb-gear--unread");
        },
        GEAR,
        { timeout: 5000 },
    );
    const lit = await dotBox(page);

    check(
        "an unread release paints a dot with real size",
        lit.width > 0 && lit.height > 0 && lit.width === lit.height,
        JSON.stringify(lit),
    );
    check(
        "the dot is a circle",
        lit.radius === "50%" || parseFloat(lit.radius) >= lit.width / 2,
        lit.radius,
    );
    check(
        "it is small enough to stay quiet, not a badge",
        lit.width <= 8 && lit.width < lit.gearW / 2,
        JSON.stringify({ dot: lit.width, gear: lit.gearW }),
    );
    check(
        "it is painted in the theme's accent rather than a literal",
        // The harness sets --vscode-focusBorder to #007fd4.
        lit.bg === "rgb(0, 127, 212)",
        lit.bg,
    );
    check(
        "it cannot eat the click that dismisses it",
        lit.pointerEvents === "none",
        lit.pointerEvents,
    );

    // ── 3. Opening the menu clears the paint AND tells the host ──
    await page.evaluate((sel) => {
        const wrap = document.querySelector(sel);
        const btn = wrap?.querySelector("button, .tb-btn, [aria-haspopup]") ?? wrap?.firstElementChild;
        btn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, GEAR);

    const after = await dotBox(page);
    const seen = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "whatsNewSeen").length,
    );
    check("opening the menu unpaints the dot", after.marked === false && after.width === 0, JSON.stringify(after));
    check("and reports it seen exactly once", seen === 1, String(seen));

    // ── 4. A second open stays silent ──
    await page.evaluate((sel) => {
        const wrap = document.querySelector(sel);
        const btn = wrap?.querySelector("button, .tb-btn, [aria-haspopup]") ?? wrap?.firstElementChild;
        btn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, GEAR);
    const seenAgain = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "whatsNewSeen").length,
    );
    check("a routine menu open reports nothing", seenAgain === 1, String(seenAgain));
}
