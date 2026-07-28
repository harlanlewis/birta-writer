/**
 * View-state restore across editor round trips, against the real bundle:
 * the extension hands the per-document bag back in `init`, and the webview
 * adopts it PER-KEY (live bag winning). Pins the regression where a stale
 * revived bag — `{scrollY}` from an older session — silently discarded
 * every remembered table width and wrap override.
 */
export async function run({ page, check, baseUrl }) {
    const boot = async (scenario) => {
        await page.goto(`${baseUrl}/index.html?scenario=${scenario}`);
        await page.waitForSelector(".mw-table", { timeout: 10000 });
        await page.waitForTimeout(300);
        return page.evaluate(() => ({
            tableFull: document.querySelector(".mw-table").classList.contains("bw-full"),
            codeWrapped: document.querySelector(".code-block-wrapper")
                .classList.contains("code-block-wrapper--word-wrap"),
            bagWidths: window.__state?.blockWidths,
        }));
    };

    // ── fresh: a new panel (raw-editor round trip) restores everything ──
    const fresh = await boot("fresh");
    check(
        "fresh panel: the remembered table width boots applied",
        fresh.tableFull === true,
        JSON.stringify(fresh),
    );
    check(
        "fresh panel: the remembered word-wrap override boots applied",
        fresh.codeWrapped === true,
        JSON.stringify(fresh),
    );

    // ── stale: a revived bag with ONLY scrollY must not eat the echo ──
    const stale = await boot("stale");
    check(
        "stale bag: per-key merge restores the width the old guard discarded",
        stale.tableFull === true && stale.bagWidths?.["table:NameAge"] === "full",
        JSON.stringify(stale),
    );
    check(
        "stale bag: the wrap override survives too",
        stale.codeWrapped === true,
        JSON.stringify(stale),
    );

    // ── live: a bag that already HAS the key wins over the echo ──
    const live = await boot("live");
    check(
        "live bag wins per key: an existing (empty) blockWidths is not clobbered",
        live.tableFull === false && JSON.stringify(live.bagWidths) === "{}",
        JSON.stringify(live),
    );
}
