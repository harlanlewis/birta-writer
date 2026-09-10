/**
 * One diagram of every Mermaid type that a document can already contain,
 * rendered through the real bundle.
 *
 * It GATES on reach: every type still renders, and the page raises nothing.
 * A Mermaid upgrade that drops or breaks a diagram type is the failure this
 * catches, and it is the one an upgrade actually risks.
 *
 * It REPORTS geometry rather than gating on it. The numbers are the answer to
 * "does this upgrade redraw documents nobody edited", which is what the pins in
 * `mermaidRuntime.ts` exist to prevent, but they are font-metric dependent and
 * therefore machine dependent, so a recorded golden here would fail for
 * reasons that have nothing to do with Mermaid. Read them by running this
 * suite on both versions and diffing the GEOMETRY lines; the config pins
 * themselves are held machine-independently by
 * `webview/__tests__/mermaidInitConfig.test.ts`.
 *
 * This is the same split perf-nightly uses: gate the counts, report the
 * durations.
 */
export async function run({ page, check, baseUrl }) {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".mermaid-svg-container svg", { timeout: 30000 });
    await page.waitForTimeout(2500); // every lazily-rendered diagram settles

    const names = await page.evaluate(() => window.__diagramNames);
    const geo = await page.evaluate(() =>
        [...document.querySelectorAll(".mermaid-svg-container svg")].map((svg) => ({
            w: svg.getAttribute("width"),
            h: svg.getAttribute("height"),
            vb: svg.getAttribute("viewBox"),
        })));

    // Asserted before any geometry is read: a suite that rendered three of nine
    // diagrams would otherwise print a short list that diffs clean against
    // another short list, and report success for having measured nothing.
    check(`every diagram type renders (${geo.length}/${names.length})`,
        geo.length === names.length,
        JSON.stringify({ expected: names, got: geo.length }));

    // An error card counts as a render, so reaching the right COUNT is not the
    // same as every type having laid out; a type that failed to parse settles
    // on a card with no <svg>, which the count above already refuses.
    check("no diagram fell back to an error card",
        (await page.evaluate(() => document.querySelectorAll(".mermaid-error-msg").length)) === 0);

    for (let i = 0; i < geo.length; i++) {
        check(`GEOMETRY ${names[i] ?? `#${i}`}`, true,
            `${geo[i].w} x ${geo[i].h} vb=${geo[i].vb}`);
    }

    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
}
