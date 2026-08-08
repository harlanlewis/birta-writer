/**
 * PlantUML render pipeline (MAR-30) — against the REAL WebAssembly engine in a
 * real browser, which is the only place any of this is observable:
 *   - the engine instantiates at all from the bundled chunks (the wasm-bindgen
 *     glue↔wasm cycle is closed by hand in plantUmlLoader.ts, and esbuild
 *     cannot resolve the upstream entry that would normally do it),
 *   - the Graphviz bridge is wired: a CLASS diagram renders. Without the bridge
 *     it fails with "graphviz render failed" while the sequence diagram still
 *     succeeds — a half-broken state a single-diagram check would miss,
 *   - a `!theme <remote>` directive fails CLOSED rather than fetching, which is
 *     what keeps rendering compatible with birta.network.enabled off,
 *   - an invalid diagram settles on its error card with the main thread alive.
 *
 * jsdom cannot stand in for any of it: no layout for the pane, and the engine
 * never runs there.
 */

/**
 * Every settled PlantUML pane: rendered SVG or error card.
 *
 * `.puml-svg-container > svg` is a DIRECT-child selector on purpose. The error
 * card is a `<div class="puml-error">` inside the same container and carries its
 * own inline alert `<svg>`, so a descendant selector reports a failed render as
 * a painted diagram — the exact confusion diagramPane.ts keeps explicit state
 * for. This harness fell into it on first run.
 */
async function paneStates(page) {
    return page.evaluate(() =>
        [...document.querySelectorAll(".puml-preview")].map((pane) => ({
            hasSvg: !!pane.querySelector(".puml-svg-container > svg"),
            error: pane.querySelector(".puml-error-msg")?.textContent?.trim() ?? "",
            // The engine stamps the family on its root <svg>; it is how we tell
            // a Graphviz-laid-out diagram from a natively laid-out one.
            diagramType:
                pane.querySelector(".puml-svg-container > svg")?.getAttribute("data-diagram-type") ?? "",
        })),
    );
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);

    // Four fenced diagrams, all auto-previewing at mount. The engine is a ~3 MB
    // lazy chunk plus a Graphviz load, so this is the slow wait in the suite.
    await page.waitForFunction(
        () => document.querySelectorAll(".puml-preview").length === 4,
        { timeout: 30000 },
    );
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".puml-preview")].every(
                (p) => p.querySelector(".puml-svg-container > svg") || p.querySelector(".puml-error-msg"),
            ),
        { timeout: 60000 },
    );

    const states = await paneStates(page);
    check("all four PlantUML panes settle", states.length === 4, JSON.stringify(states.length));

    // ── 1. Sequence: the engine's own layout, no Graphviz ──
    check("sequence diagram renders", states[0]?.hasSvg === true, JSON.stringify(states[0]));

    // ── 2. Class: Graphviz via the installed bridge ──
    // The pinned half. A missing bridge leaves state[0] passing and this failing.
    check("class diagram renders (Graphviz bridge is wired)",
        states[1]?.hasSvg === true, JSON.stringify(states[1]));

    // ── 3. Remote theme must fail CLOSED, not fetch ──
    check("a remote !theme fails closed instead of fetching",
        states[2]?.hasSvg === false && /remote|fetch|disabled/i.test(states[2]?.error ?? ""),
        JSON.stringify(states[2]));

    // ── 4. Invalid diagram: error card, main thread alive ──
    check("invalid diagram settles on its error card",
        states[3]?.hasSvg === false && (states[3]?.error ?? "").length > 0,
        JSON.stringify(states[3]?.error?.slice(0, 80)));

    // With a retry loop, timers never fire again — this never returns and the
    // suite dies on its timeout rather than passing slowly.
    const t0 = Date.now();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    check("main thread stays responsive beside the error card",
        Date.now() - t0 < 2000, `${Date.now() - t0}ms`);

    // ── No network, at all ──
    // The strongest statement the harness can make about rung 0: across four
    // diagrams, one of which explicitly asked for a remote theme, the page
    // issued no request beyond its own bundle assets.
    const offsite = await page.evaluate(() =>
        performance.getEntriesByType("resource")
            .map((e) => e.name)
            // favicon.ico is the browser's own unsolicited request, not ours.
            .filter((n) => !n.includes("/e2e/") && !n.includes("/dist/") && !n.includes("favicon.ico")),
    );
    check("no off-bundle request is made while rendering diagrams",
        offsite.length === 0, JSON.stringify(offsite.slice(0, 3)));

    // ── The shared pane chrome really is shared ──
    // PlantUML gets Mermaid's zoom/pan affordances because both are adapters
    // over diagramPane.ts; if that regressed to a bespoke pane, these vanish.
    const chrome = await page.evaluate(() => {
        const pane = document.querySelector(".puml-preview");
        return {
            zoom: !!pane?.querySelector(".puml-zoom-overlay"),
            pan: !!pane?.querySelector(".puml-pan-controls"),
        };
    });
    check("PlantUML panes carry the shared zoom/pan chrome",
        chrome.zoom && chrome.pan, JSON.stringify(chrome));
}
