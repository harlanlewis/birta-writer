/**
 * Graphviz render pipeline (MAR-330) — against the REAL WebAssembly engine in a
 * real browser, which is the only place any of it is observable:
 *   - a ```graphviz fence is previewable at all, and auto-previews at mount,
 *   - BOTH fence spellings (`dot` and the `graphviz` alias) reach the same pane;
 *     an alias that missed would render a plain code block, which looks exactly
 *     like the feature not existing,
 *   - the shared engine instantiates and lays a graph out (digraph AND the
 *     undirected `graph` form, which takes a different path),
 *   - invalid DOT settles on its error card with the main thread alive.
 *
 * jsdom cannot stand in for any of it: no layout for the pane, and the engine
 * never runs there.
 */

/**
 * Every settled Graphviz pane: rendered SVG or error card.
 *
 * `.gv-svg-container > svg` is a DIRECT-child selector for the reason
 * `plantUmlRender` documents: the error card is a `<div class="gv-error">`
 * inside the same container and carries its own inline alert `<svg>`, so a
 * descendant selector reports a failed render as a painted diagram.
 */
async function paneStates(page) {
    return page.evaluate(() =>
        [...document.querySelectorAll(".gv-preview")].map((pane) => {
            const svg = pane.querySelector(".gv-svg-container > svg");
            return {
                hasSvg: !!svg,
                error: pane.querySelector(".gv-error-msg")?.textContent?.trim() ?? "",
                // Graphviz stamps the graph's own name on the root <svg>'s
                // <title>, which is how we tell WHICH source produced a pane
                // rather than merely counting painted ones.
                title: svg?.querySelector("title")?.textContent?.trim() ?? "",
                // Node count: a graph that "rendered" as an empty canvas would
                // pass a bare hasSvg check.
                nodes: svg ? svg.querySelectorAll("g.node").length : 0,
            };
        }),
    );
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);

    // Four fenced graphs, all auto-previewing at mount. The engine is a lazy
    // WASM chunk, so this is the slow wait in the suite.
    await page.waitForFunction(
        () => document.querySelectorAll(".gv-preview").length === 4,
        { timeout: 30000 },
    );
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".gv-preview")].every(
                (p) => p.querySelector(".gv-svg-container > svg") || p.querySelector(".gv-error-msg"),
            ),
        { timeout: 60000 },
    );

    const states = await paneStates(page);
    check("all four Graphviz panes settle", states.length === 4, JSON.stringify(states.length));

    // ── 1. The canonical ```dot fence renders ──
    check(
        "a ```dot digraph paints an SVG",
        states[0]?.hasSvg === true && states[0]?.error === "",
        JSON.stringify(states[0]),
    );
    check(
        "and it is the graph from THAT fence, with its nodes",
        states[0]?.title === "G" && states[0]?.nodes === 3,
        JSON.stringify(states[0]),
    );

    // ── 2. The ```graphviz ALIAS reaches the same pane ──
    // This is the check that fails if `graphviz` is missing from the language
    // row's alias list: the block would render as ordinary code and there would
    // be three panes rather than four.
    check(
        "the ```graphviz alias paints an SVG too",
        states[1]?.hasSvg === true && states[1]?.title === "H",
        JSON.stringify(states[1]),
    );

    // ── 3. An UNDIRECTED graph ──
    check(
        "an undirected `graph` lays out as well as a digraph",
        states[2]?.hasSvg === true && states[2]?.title === "U" && states[2]?.nodes === 3,
        JSON.stringify(states[2]),
    );

    // ── 4. Invalid DOT fails onto the error card, not past it ──
    check(
        "invalid DOT settles on an error card rather than an empty diagram",
        states[3]?.hasSvg === false && states[3]?.error.length > 0,
        JSON.stringify(states[3]),
    );

    // The main thread is still alive after the engine threw.
    const alive = await page.evaluate(() => {
        document.body.dataset["probe"] = "alive";
        return document.body.dataset["probe"];
    });
    check("the main thread survives a failed render", alive === "alive", alive);

    // ── 5. The code view highlights ──
    // The language row's VALUE has to match refractor's grammar name or the
    // code surface is unhighlighted. Toggling the first block back to code is
    // the only way to see it, since these blocks auto-preview.
    const highlighted = await page.evaluate(() => {
        const wrapper = document.querySelector(".code-block-wrapper");
        const toggle = wrapper?.querySelector(".code-view-toggle-btn");
        toggle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        const code = wrapper?.querySelector("code");
        return {
            cls: code?.className ?? "",
            tokens: code?.querySelectorAll("span.token").length ?? 0,
        };
    });
    check(
        "the code view carries the dot language class",
        highlighted.cls === "language-dot",
        JSON.stringify(highlighted),
    );
    check(
        "and the dot grammar actually tokenizes it",
        highlighted.tokens > 0,
        JSON.stringify(highlighted),
    );
}
