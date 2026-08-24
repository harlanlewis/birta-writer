/**
 * Export as HTML (MAR-32), against the real bundle: the command posts one
 * `exportHtml` message whose HTML, opened as its OWN page with no access to
 * the webview's stylesheets or palette, paints the same document.
 *
 *   - rendered constructs travel: Mermaid SVG, KaTeX markup, highlight tokens,
 *     the table, the callout, the image (with its src relativized back to the
 *     document's directory);
 *   - editor chrome does not: no buttons, inputs, widgets, contenteditable;
 *   - the theme is baked in: landmark computed styles match the live view,
 *     and no reference to a defined `--vscode-*` variable survives;
 *   - the file is pruned: fewer KaTeX faces than KaTeX ships, and no
 *     toolbar rules.
 */

/** Computed-style landmarks, the same probe run on both pages. */
async function landmarks(page) {
    return page.evaluate(() => {
        const pick = (sel, props) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const cs = getComputedStyle(el);
            return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
        };
        return {
            body: pick("body", ["background-color", "color"]),
            h1: pick(".ProseMirror h1", ["color", "font-size", "font-weight", "font-family"]),
            code: pick(".ProseMirror p code", ["background-color", "color", "font-family"]),
            link: pick(".ProseMirror a", ["color"]),
            cell: pick(".ProseMirror td", ["border-top-color", "padding-left"]),
            callout: pick(".ProseMirror .callout", ["background-color", "border-left-color"]),
            token: pick(".ProseMirror .token.keyword", ["color"]),
            fence: pick(".ProseMirror .code-block-wrapper", ["background-color", "border-top-color"]),
            para: pick(".ProseMirror p", ["font-size", "line-height", "font-family"]),
        };
    });
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // Everything lazy has to have landed before the snapshot: the diagram, the
    // math, the image.
    await page.waitForSelector(".mermaid-svg-container svg", { timeout: 20000 });
    await page.waitForSelector(".katex-display .katex", { timeout: 20000 });
    await page.waitForSelector(".svg-preview[data-settled]", { timeout: 20000 });
    await page.waitForFunction(() => {
        const img = document.querySelector("img.image-node");
        return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 10000 });
    await page.waitForTimeout(300);
    const live = await landmarks(page);

    // ── The command, driven the way the palette drives it ──
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "exportHtml" }, "*"));
    await page.waitForFunction(() => window.__posted.some((m) => m.type === "exportHtml"), { timeout: 15000 });
    const posted = await page.evaluate(() => window.__posted.filter((m) => m.type === "exportHtml"));
    check("the command posts exactly one exportHtml message", posted.length === 1, String(posted.length));
    const { html, suggestedName } = posted[0];
    check("the suggested name is the document's own with .html", suggestedName === "Export Sample.html", suggestedName);
    check("the file is a complete HTML document", html.startsWith("<!doctype html>") && html.includes("</html>"));
    check("the title is the first heading", /<title>Export sample<\/title>/.test(html));

    // ── The file, opened on its own: no webview stylesheets, no palette ──
    // A fresh page off the browser (the runner's page owns a default context
    // that refuses siblings), and its own tab, so nothing of the live page's
    // stylesheets or palette can leak in.
    const out = await page.context().browser().newPage({ viewport: { width: 1000, height: 900 } });
    const outErrors = [];
    out.on("pageerror", (e) => outErrors.push(String(e)));
    // Every URL the exported file asks for. The file carries no CSP, so this is
    // the page that can actually make a request the document asked for.
    const outRequests = [];
    out.on("request", (r) => outRequests.push(r.url()));
    await out.setContent(html, { waitUntil: "load" });
    await out.waitForTimeout(300);
    const exported = await landmarks(out);
    for (const key of Object.keys(live)) {
        check(`landmark ${key} paints the same as the live view`,
            live[key] !== null && JSON.stringify(exported[key]) === JSON.stringify(live[key]),
            JSON.stringify({ live: live[key], exported: exported[key] }));
    }

    const shape = await out.evaluate(() => ({
        buttons: document.querySelectorAll("button").length,
        inputs: document.querySelectorAll("input, textarea, select").length,
        editable: document.querySelectorAll("[contenteditable], [role=textbox]").length,
        widgets: document.querySelectorAll(".ProseMirror-widget, .ProseMirror-separator, .ProseMirror-trailingBreak").length,
        gutters: document.querySelectorAll(".heading-fold-gutter, .bc-col, .mw-table-overlay, .code-float-rail, .mermaid-zoom-overlay, .image-toolbar").length,
        mermaidSvg: document.querySelectorAll(".mermaid-svg-container svg").length,
        katex: document.querySelectorAll(".katex").length,
        tokens: document.querySelectorAll(".token").length,
        tableCells: document.querySelectorAll("table td, table th").length,
        callout: document.querySelectorAll(".callout .callout-body").length,
        taskChecked: document.querySelectorAll('li[data-checked="true"]').length,
        footnote: document.querySelectorAll(".footnote-def").length,
        imgSrc: document.querySelector("img.image-node")?.getAttribute("src") ?? null,
        caption: document.querySelector(".image-caption")?.textContent ?? null,
        headingId: document.querySelector("h1")?.id ?? null,
        bodyClass: document.body.className,
    }));
    check("no buttons, inputs or editable surfaces remain", shape.buttons === 0 && shape.inputs === 0 && shape.editable === 0, JSON.stringify(shape));
    check("no widgets, separators or gutter chrome remain", shape.widgets === 0 && shape.gutters === 0, JSON.stringify(shape));
    check("the Mermaid diagram travels as SVG", shape.mermaidSvg === 1, String(shape.mermaidSvg));
    check("inline and display math travel as KaTeX", shape.katex >= 2, String(shape.katex));
    check("code highlighting travels as tokens", shape.tokens > 0, String(shape.tokens));
    check("table, callout, task state and footnote travel", shape.tableCells === 4 && shape.callout === 1 && shape.taskChecked === 1 && shape.footnote === 1, JSON.stringify(shape));
    check("the image src is relativized back to the document directory", shape.imgSrc === "img/box.svg", String(shape.imgSrc));
    check("the image caption is text, not a field", shape.caption === "a box", String(shape.caption));
    check("heading anchors survive for in-document links", shape.headingId === "export-sample", String(shape.headingId));
    check("the theme class rides on body", /\bvscode-dark\b/.test(shape.bodyClass), shape.bodyClass);

    // ── Pruning and baking ──
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    check("defined palette variables are baked in, not referenced",
        !/var\(--vscode-(editor-background|editor-foreground|textLink-foreground|focusBorder|editor-font-size)\b/.test(css));
    check("no toolbar rules travel", !/\.tb-btn|\.toc-panel|\.find-bar|\.sel-toolbar/.test(css));
    const faces = (css.match(/@font-face/g) ?? []).length;
    check("only the KaTeX faces the document uses travel", faces > 0 && faces < 10, String(faces));
    check("print rules travel", /@media print/.test(css));
    check("the export page has no script errors", outErrors.length === 0, outErrors.join(" | "));

    // === The ```svg fence, in a file with no CSP (MAR-402) ===
    // THE discriminating assertions of the whole feature. In the editor a
    // <script> and an onload= are dead whatever the sanitizer does, because the
    // webview CSP carries no 'unsafe-inline' and no nonce reaches injected
    // markup, so an in-editor check of either passes with the sanitizer removed.
    // Here there is no CSP, the page is opened for real, and the four hostile
    // constructs in the fence get their chance.
    //
    // The picture is asserted alongside them, positively: a sanitizer that
    // dropped the whole fence would pass every "it is gone" line below and ship
    // a feature that renders nothing.
    const svgOut = await out.evaluate(() => {
        const svg = document.querySelector(".svg-svg-container > svg");
        return {
            pwn: window.__pwn ?? null,
            present: !!svg,
            rects: svg ? svg.querySelectorAll("rect").length : 0,
            label: svg?.querySelector("text")?.textContent?.trim() ?? "",
            onload: svg?.getAttribute("onload") ?? null,
            scripts: svg ? svg.querySelectorAll("script").length : 0,
            styles: svg ? svg.querySelectorAll("style").length : 0,
            imageHref: svg?.querySelector("image")?.getAttribute("href") ?? null,
        };
    });
    check("the fence's picture travels into the exported file",
        svgOut.present && svgOut.rects === 1 && svgOut.label === "svg fence", JSON.stringify(svgOut));
    check("no onload attribute survives into the exported file",
        svgOut.onload === null && !/\bonload\s*=/i.test(html), JSON.stringify(svgOut));
    check("no <script> survives into the exported file",
        svgOut.scripts === 0 && !/<script/i.test(html), JSON.stringify(svgOut));
    check("no <style> element survives into the exported SVG",
        svgOut.styles === 0, JSON.stringify(svgOut));
    check("the remote <image> reference is stripped, not merely refused",
        svgOut.imageHref === null && !/tracker\.example/.test(html), JSON.stringify(svgOut));
    // The strongest of the six: not "the markup is absent" but "the page, given
    // its chance, did nothing". Both halves would have fired without the
    // sanitizer, and neither can fire inside the editor's CSP.
    check("nothing from the fence executed in the exported file",
        svgOut.pwn === null, String(svgOut.pwn));
    check("the exported file requested nothing off its own bytes",
        !outRequests.some((u) => /^https?:/.test(u)),
        outRequests.filter((u) => /^https?:/.test(u)).join(" | "));
    // Editor annotations are view state: the live view underlines the filler
    // "really" and chips the [TK] marker; the file must carry neither.
    const liveAnnotated = await page.evaluate(() => ({
        hits: document.querySelectorAll(".ProseMirror .pf-style-hit").length,
        markers: document.querySelectorAll(".ProseMirror .note-marker").length,
    }));
    check("the live view is annotated (the control for the next check)", liveAnnotated.hits > 0, JSON.stringify(liveAnnotated));
    const exportedAnnotations = await out.evaluate(() => ({
        hits: document.querySelectorAll(".pf-style-hit, .pf-spell-err, .pf-lint-err").length,
        markers: document.querySelectorAll(".note-marker").length,
        text: document.body.textContent.includes("really quite short and carries a [TK] marker"),
    }));
    check("proofread underlines and note-marker chips do not travel, their text does",
        exportedAnnotations.hits === 0 && exportedAnnotations.markers === 0 && exportedAnnotations.text, JSON.stringify(exportedAnnotations));
    check("no proofread rules travel in the stylesheet", !/\.pf-style-hit|\.pf-spell-err|\.note-marker\b/.test(css));
    await out.close();

    // ── A folded document exports its content, not its view state ──
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "foldAll" }, "*"));
    await page.waitForFunction(() => document.querySelectorAll(".ProseMirror .heading-fold-hidden").length > 0, { timeout: 5000 });
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "exportHtml" }, "*"));
    await page.waitForFunction(() => window.__posted.filter((m) => m.type === "exportHtml").length === 2, { timeout: 15000 });
    const folded = await page.evaluate(() => window.__posted.filter((m) => m.type === "exportHtml")[1].html);
    const foldedOut = await page.context().browser().newPage();
    await foldedOut.setContent(folded, { waitUntil: "load" });
    const foldedShape = await foldedOut.evaluate(() => ({
        hiddenClass: document.querySelectorAll(".heading-fold-hidden").length,
        cells: document.querySelectorAll("table td").length,
        footnoteVisible: (() => { const el = document.querySelector(".footnote-def"); return !!el && getComputedStyle(el).display !== "none"; })(),
        text: document.body.textContent.includes("The note.") && document.body.textContent.includes("A callout"),
    }));
    check("content behind a fold travels, unfolded", foldedShape.hiddenClass === 0 && foldedShape.cells === 2 && foldedShape.footnoteVisible && foldedShape.text, JSON.stringify(foldedShape));
    await foldedOut.close();
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "unfoldAll" }, "*"));
    await page.waitForTimeout(100);

    // ── A block open in source-peek is still content ──
    await page.locator(".ProseMirror p", { hasText: "really quite short" }).click();
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "editBlockSource" }, "*"));
    await page.waitForSelector(".ProseMirror .block-source-hidden", { state: "attached", timeout: 5000 });
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "exportHtml" }, "*"));
    await page.waitForFunction(() => window.__posted.filter((m) => m.type === "exportHtml").length === 3, { timeout: 15000 });
    const peeked = await page.evaluate(() => window.__posted.filter((m) => m.type === "exportHtml")[2].html);
    const peekedOut = await page.context().browser().newPage();
    await peekedOut.setContent(peeked, { waitUntil: "load" });
    const peekedShape = await peekedOut.evaluate(() => ({
        text: document.body.textContent.includes("really quite short and carries"),
        textareas: document.querySelectorAll("textarea").length,
        hiddenClass: document.querySelectorAll(".block-source-hidden").length,
    }));
    check("a block open in source-peek exports its rendered content, without the source editor",
        peekedShape.text && peekedShape.textareas === 0 && peekedShape.hiddenClass === 0, JSON.stringify(peekedShape));
    await peekedOut.close();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // ── The live editor is untouched by the snapshot ──
    const liveAfter = await page.evaluate(() => ({
        editable: document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
        gutters: document.querySelectorAll(".ProseMirror .heading-fold-gutter").length,
    }));
    check("the live editor keeps its chrome and editability", liveAfter.editable === "true" && liveAfter.gutters > 0, JSON.stringify(liveAfter));
}
