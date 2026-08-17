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
 *
 * It also pins that the Graphviz engine is loaded only when a diagram needs it
 * (MAR-369): a document holding only a sequence diagram (`sequenceOnly.html`)
 * must not request the Graphviz chunk at all, while this page's class diagram
 * must. Chunk names are content-hashed, so the engine's chunk is recognised by
 * its bytes rather than its name.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The bundle chunks the current page has requested, by file name. Chunks
 * arrive through dynamic `import()`, so one that was never imported never
 * shows up here, cached or not.
 */
async function loadedChunks(page) {
    return page.evaluate(() =>
        performance.getEntriesByType("resource")
            .map((e) => e.name)
            .filter((n) => n.includes("/dist/chunks/"))
            .map((n) => n.slice(n.lastIndexOf("/") + 1)),
    );
}

/**
 * Whether a chunk carries the Graphviz engine. `patchwork` is one of the
 * layout engines `@hpcc-js/wasm-graphviz` declares by name, and a string
 * literal survives minification, so it identifies the chunk in a dev and a
 * production build alike (the source-path comment only survives the former).
 */
async function carriesGraphviz(chunkName) {
    const text = await readFile(join(repoRoot, "dist", "chunks", chunkName), "utf8");
    return /wasm-graphviz|"patchwork"/.test(text);
}

async function settledPanes(page, count) {
    await page.waitForFunction(
        (n) => document.querySelectorAll(".puml-preview").length === n,
        count,
        { timeout: 30000 },
    );
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".puml-preview")].every(
                (p) => p.querySelector(".puml-svg-container > svg") || p.querySelector(".puml-error-msg"),
            ),
        { timeout: 60000 },
    );
}

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
    // ── A sequence-only document never loads the Graphviz engine ──
    // Visited FIRST, on a fresh page, so nothing this suite does later can
    // have primed the chunk. Sequence diagrams are laid out by the PlantUML
    // engine itself and never call the Graphviz bridge, so the engine chunk
    // must not be requested: it is loaded on first need, not on first render.
    await page.goto(`${baseUrl}/sequenceOnly.html`);
    await settledPanes(page, 1);
    const seqOnly = await paneStates(page);
    check("sequence-only document renders its diagram",
        seqOnly[0]?.hasSvg === true && seqOnly[0]?.diagramType === "SEQUENCE", JSON.stringify(seqOnly));
    const seqChunks = await loadedChunks(page);
    const seqGraphviz = [];
    for (const name of seqChunks) if (await carriesGraphviz(name)) seqGraphviz.push(name);
    check("sequence-only document does not load the Graphviz engine chunk",
        seqChunks.length > 0 && seqGraphviz.length === 0, JSON.stringify({ seqChunks, seqGraphviz }));

    await page.goto(`${baseUrl}/index.html`);

    // Four fenced diagrams, all auto-previewing at mount. The engine is a ~3 MB
    // lazy chunk plus a Graphviz load, so this is the slow wait in the suite.
    await settledPanes(page, 4);

    const states = await paneStates(page);
    check("all four PlantUML panes settle", states.length === 4, JSON.stringify(states.length));

    // The class diagram below is the other half of MAR-369: the same marker
    // that found nothing on the sequence-only page must find the engine here,
    // or the check above passed vacuously against a renamed or missing chunk.
    const classChunks = await loadedChunks(page);
    const classGraphviz = [];
    for (const name of classChunks) if (await carriesGraphviz(name)) classGraphviz.push(name);
    check("a document with a class diagram loads the Graphviz engine chunk",
        classGraphviz.length > 0, JSON.stringify({ classChunks }));

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

    // ── A live theme change reaches open diagrams ──
    // `birta.plantuml.theme` arrives as a message, not a reload. The mode's
    // own listener is the only thing that repaints what is already on screen,
    // and `auto` shipped with none at all — nothing called the exported
    // refresh, so a VS Code theme switch left every diagram in the old palette
    // until its source changed.
    await page.evaluate(() => window.postMessage({ type: "setPlantUmlTheme", mode: "dark" }, "*"));
    await page.waitForFunction(
        () => document.querySelector(".puml-preview")?.classList.contains("puml-canvas-dark"),
        { timeout: 30000 },
    );
    check("a live theme change repaints open diagrams onto the dark canvas", true);

    // ── The dark palette actually reaches the ELEMENTS ──
    // `skinparam BackgroundColor` is `backgroundColor` (names are
    // case-insensitive), so the first cut set the page twice and filled
    // nothing: participants kept PlantUML's stock lavender and lifelines
    // stayed #181818 on a dark canvas, all but invisible. Read the fills back
    // out of the painted SVG — the only place the collision is observable.
    const palette = await page.evaluate(() => {
        const svg = document.querySelector(".puml-preview .puml-svg-container > svg");
        const css = getComputedStyle(document.documentElement);
        // Custom-property NAMES are case-sensitive; only the values fold.
        const themeVar = (name) => css.getPropertyValue(name).trim().toLowerCase();
        const hex = (v) => (v ?? "").trim().toLowerCase();
        const fills = [...svg.querySelectorAll("rect")].map((r) => hex(r.getAttribute("fill")));
        const strokes = [...svg.querySelectorAll("line")].map((l) => (l.getAttribute("style") ?? "").toLowerCase());
        return {
            canvas: themeVar("--vscode-textCodeBlock-background"),
            element: themeVar("--vscode-editorWidget-background"),
            border: themeVar("--vscode-panel-border"),
            fills,
            strokes,
        };
    });
    check("participants are filled from the editor's widget surface",
        palette.fills.includes(palette.element),
        JSON.stringify({ want: palette.element, got: palette.fills }));
    check("lifelines are drawn in the editor's border colour, not near-black",
        palette.strokes.some((s) => s.includes(palette.border)) &&
        !palette.strokes.some((s) => s.includes("#181818")),
        JSON.stringify({ want: palette.border, got: palette.strokes.slice(0, 3) }));

    // ── Fullscreen is the SAME engine, not Mermaid ──
    // The lightbox is shared with Mermaid and used to hardcode it: a
    // fullscreened PlantUML diagram was titled "Mermaid", highlighted as
    // Mermaid, drawn on Mermaid's canvas, and — the damaging one — handed to
    // Mermaid's parser the moment the user edited it there.
    await page.evaluate(() => {
        const wrapper = document.querySelector(".code-block-wrapper");
        // The control column attaches its buttons on first reveal, so hover first.
        wrapper.dispatchEvent(new PointerEvent("pointerenter"));
        document.querySelector(".code-block-fullscreen-btn")
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await page.waitForSelector(".fs-surface", { timeout: 10000 });
    const lb = await page.evaluate(() => {
        const overlay = document.querySelector(".fs-surface");
        // The canvas ground IS the overlay now: no card, no shadow, so the
        // colour to compare against the pane is the overlay's own.
        return {
            title: overlay.querySelector(".fs-title")?.textContent ?? "",
            canvasBg: getComputedStyle(overlay).backgroundColor,
            paneBg: getComputedStyle(document.querySelector(".puml-preview")).backgroundColor,
            codeClass: overlay.querySelector(".lb-diagram-code-pane code")?.className ?? "",
        };
    });
    check("the fullscreen header names PlantUML, not Mermaid",
        /plantuml/i.test(lb.title), lb.title);
    check("the fullscreen canvas matches the inline pane's",
        lb.canvasBg === lb.paneBg, JSON.stringify(lb));
    check("the fullscreen code pane is highlighted as PlantUML",
        !/language-mermaid\b/.test(lb.codeClass), lb.codeClass);

    // Edit in the fullscreen editor, then switch back to the preview: the
    // re-render must go through PlantUML. Fed to Mermaid it produced "No
    // diagram type detected" over a diagram that was fine a moment ago.
    await page.evaluate(() => {
        const overlay = document.querySelector(".fs-surface");
        // The mode toggle is the last action before Close in the top-right cluster.
        const actions = [...overlay.querySelectorAll(".fs-actions button")];
        const toggle = actions[actions.length - 2];
        toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        const textarea = overlay.querySelector(".code-lightbox-textarea");
        textarea.value = "@startuml\nAlice -> Bob : edited\n@enduml";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await page.waitForFunction(
        () => {
            const c = document.querySelector(".lb-diagram-svg");
            return !!c && !c.querySelector(".puml-loading") && !c.querySelector(".mermaid-loading");
        },
        { timeout: 30000 },
    );
    const edited = await page.evaluate(() => {
        const c = document.querySelector(".lb-diagram-svg");
        return {
            hasSvg: !!c.querySelector("svg[data-diagram-type]"),
            err: (c.querySelector(".puml-error-msg, .mermaid-error-msg")?.textContent ?? "").trim().slice(0, 80),
        };
    });
    check("editing in fullscreen re-renders through PlantUML",
        edited.hasSvg && !edited.err, JSON.stringify(edited));
}
