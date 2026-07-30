/**
 * A search hit must arrive SELECTED and ON SCREEN (MAR-268), against the real
 * bundle.
 *
 * jsdom can't answer this half at all: revealing the match is layout — block
 * offsets, viewport height, `window.scrollY`. The extension-side capture is
 * unit-tested and the end-to-end jump has an integration test, but neither can
 * see where the document actually ended up, which is exactly where the first
 * cut of this feature fell down: the match was selected and the view stayed at
 * the top of the file.
 */

/** Where the needle's paragraph sits relative to the viewport. */
const needleRect = (page) =>
    page.evaluate(() => {
        const el = [...document.querySelectorAll(".ProseMirror > p")]
            .find((p) => p.textContent.includes("ZQXNEEDLEZQX"));
        if (!el) { return null; }
        const rect = el.getBoundingClientRect();
        return {
            top: rect.top,
            bottom: rect.bottom,
            scrollY: window.scrollY,
            viewport: window.innerHeight,
        };
    });

const selectedText = (page) =>
    page.evaluate(() => window.getSelection()?.toString() ?? "");

/** True when the paragraph is inside the viewport rather than far below it. */
const onScreen = (r) => r !== null && r.top >= 0 && r.bottom <= r.viewport;

export async function run({ page, check, baseUrl }) {
    const boot = async (scenario) => {
        await page.goto(`${baseUrl}/index.html?scenario=${scenario}`);
        await page.waitForSelector(".ProseMirror > p", { timeout: 10000 });
        await page.waitForTimeout(800); // the retry ladder's first rungs
        return needleRect(page);
    };

    // ── a plain arrival: the match is selected AND revealed ──
    const plain = await boot("plain");
    check(
        "search hit: the matched text is selected",
        (await selectedText(page)) === "ZQXNEEDLEZQX",
        JSON.stringify(await selectedText(page)),
    );
    check(
        "search hit: the match is scrolled on screen, not left below the fold",
        onScreen(plain),
        JSON.stringify(plain),
    );
    check(
        "search hit: the match is roughly centered, as the raw editor reveals it",
        plain !== null && Math.abs((plain.top + plain.bottom) / 2 - plain.viewport / 2) < plain.viewport / 4,
        JSON.stringify(plain),
    );

    // ── a REOPENED panel: the arriving navigation beats the remembered scroll ──
    // The search jump closes and reopens the tab, so the panel boots with the
    // view-state bag the extension echoes back. A remembered scroll position
    // restored on top of the jump is what put the user back at the top of the
    // file with the match selected off screen.
    const remembered = await boot("remembered");
    check(
        "reopened panel: the arriving navigation wins over the remembered scroll",
        onScreen(remembered),
        JSON.stringify(remembered),
    );

    // A webview is hidden and shown as its tab is opened and revealed, and that
    // transition restores the remembered scroll. Fire it IMMEDIATELY after the
    // jump — before the 200 ms scroll-save debounce has replaced the remembered
    // position with the one we just jumped to, which is the only reason a late
    // flip looks harmless.
    await page.goto(`${baseUrl}/index.html?scenario=remembered`);
    await page.waitForSelector(".ProseMirror > p", { timeout: 10000 });
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(1200);
    const flipped = await needleRect(page);
    check(
        "reopened panel: a visibility flip right after the jump does not yank it back",
        onScreen(flipped),
        JSON.stringify(flipped),
    );
}
