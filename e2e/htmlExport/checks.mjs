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

    // ── The live editor is untouched by the snapshot ──
    const liveAfter = await page.evaluate(() => ({
        editable: document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
        gutters: document.querySelectorAll(".ProseMirror .heading-fold-gutter").length,
    }));
    check("the live editor keeps its chrome and editability", liveAfter.editable === "true" && liveAfter.gutters > 0, JSON.stringify(liveAfter));
}
