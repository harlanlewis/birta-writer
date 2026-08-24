/**
 * The ```svg fence (MAR-402), in a real browser, against the real bundle.
 *
 * The fence is the first construct that puts markup the DOCUMENT AUTHOR wrote
 * into the live DOM, so half of this suite is the sanitizer and half is the
 * shared pane behaving as it does for every other diagram:
 *   - a fence auto-previews at mount and paints its own picture,
 *   - the natural size comes off the SANITIZED markup, by width/height where
 *     the author gave them and by viewBox where they did not,
 *   - the hostile fence renders its picture AND none of its five hostile
 *     constructs survive, asserted on the sanitized output rather than on
 *     "nothing happened",
 *   - a local `url(#id)` reference survives, which is the control that stops the
 *     remote strip passing by dropping everything,
 *   - source with no `<svg>` in it settles on the error card rather than a
 *     blank pane,
 *   - the page fetched nothing off its own bundle (rung 0, docs/NETWORK_POSTURE),
 *   - the fence is an ordinary code block, so the document bytes are unchanged
 *     by rendering.
 *
 * The page carries no CSP on purpose (see its header): inside the extension a
 * `<script>` and an `onload=` are inert either way, so the same checks there
 * would pass with the sanitizer removed. The other half of the argument is in
 * `e2e/htmlExport`, which opens the EXPORTED file, where there is no CSP in
 * production either.
 *
 * jsdom cannot stand in: no layout for the pane, no resource timeline, and its
 * parse of injected SVG is not the one that ships.
 */

/** Every settled SVG pane: painted picture or error card. */
async function paneStates(page) {
    return page.evaluate(() =>
        [...document.querySelectorAll(".svg-preview[data-settled]")].map((pane) => {
            // A DIRECT-child selector for the reason plantUmlRender documents:
            // the error card is a div inside the same container carrying its own
            // inline alert <svg>, so a descendant selector reports a failed
            // render as a painted picture.
            const svg = pane.querySelector(".svg-svg-container > svg");
            return {
                settled: pane.dataset["settled"],
                hasSvg: !!svg,
                error: pane.querySelector(".svg-error-msg")?.textContent?.trim() ?? "",
                // The pane stamps the natural size it read onto the root, so
                // these are what it measured rather than what was authored.
                width: svg?.getAttribute("width") ?? "",
                height: svg?.getAttribute("height") ?? "",
                shapes: svg ? svg.querySelectorAll("rect, circle, path, text").length : 0,
            };
        }),
    );
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);

    // Five fences, all auto-previewing at mount. The sanitizer is a lazy chunk,
    // so the wait is for the chunk plus the render.
    await page.waitForFunction(
        () => document.querySelectorAll(".svg-preview[data-settled]").length === 5,
        { timeout: 30000 },
    );
    const states = await paneStates(page);
    check("all five SVG fences settle", states.length === 5, JSON.stringify(states.length));

    // ── 1. The ordinary fence paints, at the size its author gave ──
    check(
        "a ```svg fence paints its own picture",
        states[0]?.hasSvg === true && states[0]?.error === "" && states[0]?.shapes === 3,
        JSON.stringify(states[0]),
    );
    check(
        "the pane stamps the width and height the markup declared",
        states[0]?.width === "240" && states[0]?.height === "120",
        JSON.stringify(states[0]),
    );

    // ── 2. viewBox alone is enough ──
    // The case that matters most in practice, and the one a naive reader gets
    // wrong: with no width/height a browser's replaced-element default is
    // 300x150, which is nothing to do with the picture. `readSvgNaturalSize`
    // falls through to the viewBox, so the pane fits and zooms against the real
    // aspect ratio. 300x150 is exactly what a regression here would report.
    check(
        "a fence with only a viewBox is measured from it, not from 300x150",
        states[1]?.width === "400" && states[1]?.height === "200",
        JSON.stringify(states[1]),
    );

    // ── 3. The hostile fence: the picture lands, the five constructs do not ──
    // Asserted on the sanitized DOM, construct by construct. "Nothing happened"
    // would pass with the whole fence dropped, so the kept rect is checked in
    // the same breath as the things that went.
    const hostile = await page.evaluate(() => {
        const pane = [...document.querySelectorAll(".svg-preview[data-settled]")][2];
        const svg = pane?.querySelector(".svg-svg-container > svg");
        return {
            pwn: window.__pwn,
            present: !!svg,
            keptRect: !!svg?.querySelector("#kept"),
            // The pane's own sheet must still be visible: a <style> that made
            // it through would have hidden the whole editor.
            editorVisible: !!document.querySelector(".ProseMirror")
                && getComputedStyle(document.querySelector(".ProseMirror")).display !== "none",
            onload: svg?.getAttribute("onload") ?? null,
            scripts: svg ? svg.querySelectorAll("script").length : 0,
            styles: svg ? svg.querySelectorAll("style").length : 0,
            imageHref: svg?.querySelector("image")?.getAttribute("href") ?? null,
            // The remote paint reference, through a presentation attribute
            // rather than an href. Its rect survives; only the fill goes.
            remoteFill: [...(svg?.querySelectorAll("rect") ?? [])]
                .map((r) => r.getAttribute("fill") ?? "")
                .filter((f) => f.includes("tracker.example")).length,
        };
    });
    check("the hostile fence still paints its picture",
        hostile.present && hostile.keptRect, JSON.stringify(hostile));
    check("no onload attribute survives", hostile.onload === null, JSON.stringify(hostile));
    check("no <script> survives", hostile.scripts === 0, JSON.stringify(hostile));
    check("no <style> element survives, and the editor is still visible",
        hostile.styles === 0 && hostile.editorVisible, JSON.stringify(hostile));
    check("the remote <image> href is stripped", hostile.imageHref === null, JSON.stringify(hostile));
    check("a remote url() in a presentation attribute is stripped",
        hostile.remoteFill === 0, JSON.stringify(hostile));
    check("nothing from the fence executed, on a page with no CSP to stop it",
        hostile.pwn === null, String(hostile.pwn));

    // ── 4. A local reference is NOT collateral ──
    // The control for check 3: a policy that dropped every url() would pass
    // every line above and break gradients, filters, masks and clip paths.
    const local = await page.evaluate(() => {
        const pane = [...document.querySelectorAll(".svg-preview[data-settled]")][3];
        const svg = pane?.querySelector(".svg-svg-container > svg");
        return {
            fill: svg?.querySelector("rect")?.getAttribute("fill") ?? null,
            gradientStops: svg ? svg.querySelectorAll("linearGradient stop").length : 0,
        };
    });
    check("a local url(#id) reference and its gradient both survive",
        local.fill === "url(#g)" && local.gradientStops === 2, JSON.stringify(local));

    // ── 5. Source with no <svg> settles on the error card ──
    check(
        "source with no <svg> in it settles on the error card, not a blank pane",
        states[4]?.settled === "error" && states[4]?.hasSvg === false && states[4]?.error.length > 0,
        JSON.stringify(states[4]),
    );

    // The main thread is still alive after the failed render.
    const alive = await page.evaluate(() => {
        document.body.dataset["probe"] = "alive";
        return document.body.dataset["probe"];
    });
    check("the main thread survives a failed render", alive === "alive", alive);

    // ── 6. Rung 0: no request beyond the page's own bundle ──
    // Two fences asked for remote resources by name. docs/NETWORK_POSTURE.md
    // states the invariant this pins: a document cannot make the editor fetch
    // anything by containing a diagram, whatever it contains.
    const offsite = await page.evaluate(() =>
        performance.getEntriesByType("resource")
            .map((e) => e.name)
            // favicon.ico is the browser's own unsolicited request, not ours.
            .filter((n) => !n.includes("/e2e/") && !n.includes("/dist/") && !n.includes("favicon.ico")),
    );
    check("no off-bundle request is made while rendering an SVG fence",
        offsite.length === 0, JSON.stringify(offsite.slice(0, 3)));

    // ── 7. The shared pane chrome really is shared ──
    const chrome = await page.evaluate(() => {
        const pane = document.querySelector(".svg-preview");
        return {
            zoom: !!pane?.querySelector(".svg-zoom-overlay"),
            pan: !!pane?.querySelector(".svg-pan-controls"),
            // The export prunes chrome by this marker, so a pane that stopped
            // carrying it would ship its zoom buttons into an exported file.
            marker: pane ? pane.querySelectorAll(".diagram-chrome").length : 0,
        };
    });
    check("SVG panes carry the shared zoom and pan chrome, under the export marker",
        chrome.zoom && chrome.pan && chrome.marker === 2, JSON.stringify(chrome));

    // The pane's sheet stays light whatever Mermaid's canvas setting says, the
    // same way Graphviz's does: an SVG paints its own page.
    const canvas = await page.evaluate(() => {
        const pane = document.querySelector(".svg-preview");
        const before = getComputedStyle(pane).backgroundColor;
        document.body.classList.add("mermaid-canvas-dark");
        const under = getComputedStyle(pane).backgroundColor;
        document.body.classList.remove("mermaid-canvas-dark");
        return { before, under };
    });
    check("the SVG pane keeps its light sheet under a dark Mermaid canvas",
        canvas.before === canvas.under && canvas.before !== "" && canvas.before !== "rgba(0, 0, 0, 0)",
        JSON.stringify(canvas));

    // ── 8. The document is untouched by rendering ──
    // The phase-0 claim that makes this feature cheap: the fence is an ordinary
    // code block, so nothing the pane does can reach the bytes. Asserted on the
    // hostile fence in particular, since that is the one whose rendered form
    // differs most from its source.
    // `ready` is asserted alongside it: an empty `__posted` would satisfy the
    // "no update" half on its own, and would mean the channel never opened
    // rather than that the document was left alone.
    const posted = await page.evaluate(() => ({
        ready: window.__posted.some((m) => m.type === "ready"),
        updates: window.__posted.filter((m) => m.type === "update").map((m) => m.content),
    }));
    check("the message channel is open (the control for the next check)",
        posted.ready, JSON.stringify(posted.updates.length));
    check("rendering posts no document update at all",
        posted.updates.length === 0, JSON.stringify(posted.updates.slice(-1)));

    // ── 9. The code view carries the language and highlights ──
    // The language row's VALUE has to match refractor's grammar name or the code
    // surface is unhighlighted; `markup` registers `svg` among its aliases.
    const highlighted = await page.evaluate(() => {
        const wrapper = document.querySelector(".code-block-wrapper");
        const toggle = wrapper?.querySelector(".code-view-toggle-btn");
        toggle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        const code = wrapper?.querySelector("code");
        return {
            cls: code?.className ?? "",
            tokens: code?.querySelectorAll("span.token").length ?? 0,
            // The source is the author's, verbatim: the toggle shows what the
            // file holds, not what the sanitizer kept.
            hasScript: (code?.textContent ?? "").includes("<title>plain</title>"),
        };
    });
    check("the code view carries the svg language class",
        highlighted.cls === "language-svg", JSON.stringify(highlighted));
    check("and the markup grammar tokenizes it",
        highlighted.tokens > 0, JSON.stringify(highlighted));
    check("the code view shows the author's own source",
        highlighted.hasScript, JSON.stringify(highlighted));
}
