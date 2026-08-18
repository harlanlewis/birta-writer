/**
 * webview/export tests (MAR-32): the pure halves of Export as HTML, run
 * against jsdom, plus the eager-graph pin for its loader seam.
 *
 * What jsdom can answer: variable resolution, URL relativization, selector
 * pruning, chrome stripping driven by inline computed styles, and the shape
 * of the assembled document. What it cannot: whether the pruned CSS PAINTS the
 * same document, which `e2e/htmlExport` checks against the real bundle.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    buildExportDocument,
    CHROME_SELECTORS,
    collectExportCss,
    documentRootStyle,
    exportTitle,
    relativizeResourceUrl,
    resolveVscodeVars,
    selectorApplies,
    snapshotContent,
} from "../export";
import { mockVscodeApi } from "./setup";

const PALETTE: Record<string, string> = {
    "--vscode-editor-foreground": "#d4d4d4",
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-focusBorder": "rgba(0, 127, 212, 0.9)",
};
const resolve = (name: string): string => PALETTE[name] ?? "";

describe("resolveVscodeVars", () => {
    it("a defined variable should be replaced by its value", () => {
        expect(resolveVscodeVars("color: var(--vscode-editor-foreground);", resolve))
            .toBe("color: #d4d4d4;");
    });

    it("a defined variable with a fallback should drop the fallback", () => {
        expect(resolveVscodeVars("color: var(--vscode-editor-foreground, red);", resolve))
            .toBe("color: #d4d4d4;");
    });

    it("an undefined variable should keep the reference and resolve inside its fallback", () => {
        expect(resolveVscodeVars("color: var(--vscode-nope, var(--vscode-editor-foreground));", resolve))
            .toBe("color: var(--vscode-nope, #d4d4d4);");
    });

    it("a nested reference inside a function should be resolved with balanced parens intact", () => {
        expect(resolveVscodeVars("border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 50%, transparent);", resolve))
            .toBe("border: 1px solid color-mix(in srgb, rgba(0, 127, 212, 0.9) 50%, transparent);");
    });

    it("a non-vscode custom property should be left alone", () => {
        const css = "font-size: var(--content-em); gap: var(--ui-space-s, 4px);";
        expect(resolveVscodeVars(css, resolve)).toBe(css);
    });

    it("an unbalanced reference should be passed through rather than dropped", () => {
        expect(resolveVscodeVars("x: var(--vscode-editor-foreground", resolve))
            .toBe("x: var(--vscode-editor-foreground");
    });
});

describe("relativizeResourceUrl", () => {
    const base = "https://file+.vscode-resource.vscode-cdn.net/Users/x/docs/";

    it("a resource under the document directory should become a relative path without the query", () => {
        expect(relativizeResourceUrl(`${base}img/cat.png?v=1`, base)).toBe("img/cat.png");
    });

    it("a resource above the document directory should climb with ..", () => {
        expect(relativizeResourceUrl("https://file+.vscode-resource.vscode-cdn.net/Users/x/assets/a.png", base))
            .toBe("../assets/a.png");
    });

    it("a URL on another origin should be left as written", () => {
        expect(relativizeResourceUrl("https://example.com/x.png", base)).toBe("https://example.com/x.png");
    });

    it("no document base should leave every URL as written", () => {
        expect(relativizeResourceUrl(`${base}img/cat.png`, undefined)).toBe(`${base}img/cat.png`);
    });

    it("a relative or malformed URL should be left as written", () => {
        expect(relativizeResourceUrl("img/cat.png", base)).toBe("img/cat.png");
        expect(relativizeResourceUrl("", base)).toBe("");
    });
});

describe("selectorApplies", () => {
    let root: HTMLElement;
    beforeEach(() => {
        root = document.createElement("div");
        root.innerHTML = '<div class="milkdown"><p class="x"><a href="#">l</a></p></div>';
    });

    it("a selector matching a descendant should apply", () => {
        expect(selectorApplies(".milkdown p.x", root)).toBe(true);
    });

    it("a selector matching nothing should not apply", () => {
        expect(selectorApplies(".toolbar .tb-btn", root)).toBe(false);
    });

    it("a hover or pseudo-element selector should apply when its element is present", () => {
        expect(selectorApplies(".milkdown a:hover", root)).toBe(true);
        expect(selectorApplies("p.x::before", root)).toBe(true);
    });

    it("a hover selector on an absent element should not apply", () => {
        expect(selectorApplies(".gone:hover", root)).toBe(false);
    });

    it("a selector the document cannot parse should be kept", () => {
        expect(selectorApplies("::highlight(find-match)", root)).toBe(true);
        expect(selectorApplies(":host(.x)", root)).toBe(true);
    });
});

/** A live-looking editor root with chrome interleaved through real content. */
function liveEditor(): HTMLElement {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ProseMirror editor";
    root.setAttribute("contenteditable", "true");
    root.setAttribute("role", "textbox");
    root.setAttribute("translate", "no");
    root.innerHTML = [
        '<h1 class="heading-fold-heading"><span class="heading-fold-gutter ProseMirror-widget"><button>H1</button></span>Title</h1>',
        '<p spellcheck="false" style="">Body <img class="ProseMirror-separator" alt=""><br class="ProseMirror-trailingBreak"></p>',
        '<div class="callout"><div class="callout-title"><button class="callout-kind"><svg></svg></button>',
        '<span class="callout-title-text" role="textbox" contenteditable="plaintext-only">Note</span></div></div>',
        '<div class="code-block-wrapper"><div class="code-float-rail"><button class="lang-picker-btn">TS</button></div>',
        '<div class="hidden-preview" style="display: none">stale</div>',
        '<div class="faded" style="opacity: 0">rail</div>',
        '<pre><code>x</code></pre></div>',
        '<p class="img-block"><div class="image-wrapper"><img class="image-node" src="https://file+.vscode-resource.vscode-cdn.net/Users/x/docs/img/cat.png?v=1">',
        '<input class="image-caption" value="A cat"><input class="img-tb-title" value="t"></div></p>',
        '<p style="color: var(--vscode-editor-foreground)">styled</p>',
    ].join("");
    document.body.appendChild(root);
    return root;
}

describe("snapshotContent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.__i18n = { translations: {}, isMac: true, resourceBaseUri: "https://file+.vscode-resource.vscode-cdn.net/Users/x/docs/" };
        document.documentElement.style.setProperty("--vscode-editor-foreground", "#d4d4d4");
    });

    it("widgets, separators, named chrome and hidden elements should be stripped, content kept", () => {
        const out = snapshotContent(liveEditor());
        expect(out.querySelector(".ProseMirror-widget")).toBeNull();
        expect(out.querySelector(".ProseMirror-separator, .ProseMirror-trailingBreak")).toBeNull();
        expect(out.querySelector(".code-float-rail")).toBeNull();
        expect(out.querySelector(".hidden-preview")).toBeNull();
        expect(out.querySelector(".faded")).toBeNull();
        expect(out.querySelector("button")).toBeNull();
        expect(out.querySelector("h1")?.textContent).toBe("Title");
        expect(out.querySelector("pre code")?.textContent).toBe("x");
        expect(out.textContent).toContain("Body");
    });

    it("editing attributes should be gone from the root and every element", () => {
        const out = snapshotContent(liveEditor());
        expect(out.hasAttribute("contenteditable")).toBe(false);
        expect(out.hasAttribute("role")).toBe(false);
        expect(out.hasAttribute("translate")).toBe(false);
        expect(out.querySelector("[contenteditable], [spellcheck], [role=textbox]")).toBeNull();
    });

    it("the callout kind button should become a span keeping its icon", () => {
        const out = snapshotContent(liveEditor());
        const kind = out.querySelector(".callout-kind");
        expect(kind?.tagName).toBe("SPAN");
        expect(kind?.querySelector("svg")).not.toBeNull();
    });

    it("the image caption field should become text and other inputs should go", () => {
        const out = snapshotContent(liveEditor());
        expect(out.querySelector("input")).toBeNull();
        expect(out.querySelector(".image-caption")?.textContent).toBe("A cat");
    });

    it("a webview resource URL should be relativized to the document and inline vscode vars resolved", () => {
        const out = snapshotContent(liveEditor());
        expect(out.querySelector("img.image-node")?.getAttribute("src")).toBe("img/cat.png");
        expect(out.querySelector("p[style]")?.getAttribute("style")).toContain("#d4d4d4");
        expect(out.querySelector('p[style=""]')).toBeNull();
    });

    it("a folded-away block should travel unfolded, its own hidden descendants still dropped", () => {
        const live = liveEditor();
        const style = document.createElement("style");
        style.textContent = ".heading-fold-hidden { display: none !important; } .block-gutter-host.collapsed > .body { display: none; }";
        document.head.appendChild(style);
        live.insertAdjacentHTML("beforeend",
            '<p class="heading-fold-hidden block-gutter-host">Folded body<span class="stale" style="display: none">x</span></p>' +
            '<div class="callout block-gutter-host collapsed"><div class="title">T</div><div class="body">Collapsed body</div></div>');
        // The folds really hide live, so the exemption (not a missing rule) is what is tested.
        expect(getComputedStyle(live.querySelector(".heading-fold-hidden")!).display).toBe("none");
        expect(getComputedStyle(live.querySelector(".collapsed > .body")!).display).toBe("none");
        const before = live.outerHTML;
        const out = snapshotContent(live);
        const p = Array.from(out.querySelectorAll("p")).find((el) => el.textContent?.startsWith("Folded body"));
        expect(p).toBeDefined();
        expect(p!.classList.contains("heading-fold-hidden")).toBe(false);
        expect(p!.classList.contains("block-gutter-host")).toBe(true);
        expect(p!.querySelector(".stale")).toBeNull();
        expect(out.querySelector(".callout .body")?.textContent).toBe("Collapsed body");
        expect(out.querySelector(".callout")?.classList.contains("collapsed")).toBe(false);
        expect(live.outerHTML).toBe(before); // the fold classes are back on the live tree
        style.remove();
    });

    it("the live tree should be untouched by the snapshot", () => {
        const live = liveEditor();
        const before = live.outerHTML;
        snapshotContent(live);
        expect(live.outerHTML).toBe(before);
    });

    it("every named chrome selector should be a selector the platform accepts", () => {
        for (const sel of CHROME_SELECTORS) {
            expect(() => document.querySelector(sel), sel).not.toThrow();
        }
    });
});

describe("collectExportCss", () => {
    function sheetFrom(css: string): CSSStyleSheet {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
        return style.sheet as CSSStyleSheet;
    }
    let root: HTMLElement;
    beforeEach(() => {
        document.head.innerHTML = "";
        root = document.createElement("html");
        root.innerHTML = '<body class="vscode-dark"><div id="editor"><div class="milkdown"><div class="ProseMirror"><p class="katex">x</p></div></div></div></body>';
    });

    it("rules that match should be kept, chrome rules dropped, vars resolved", () => {
        const sheet = sheetFrom([
            "body.vscode-dark { color: var(--vscode-editor-foreground); }",
            ".toolbar .tb-btn { color: red; }",
            "#editor p { margin: 0; }",
        ].join("\n"));
        const css = collectExportCss([sheet], root, root.querySelector(".ProseMirror")!, resolve);
        expect(css).toContain("body.vscode-dark");
        expect(css).toContain("#d4d4d4");
        expect(css).not.toContain("--vscode-editor-foreground");
        expect(css).toContain("#editor p");
        expect(css).not.toContain(".tb-btn");
    });

    it("a media block should survive only around matching rules, with its prelude", () => {
        const sheet = sheetFrom([
            "@media (max-width: 720px) { #editor p { padding: 0; } .tb-btn { padding: 0; } }",
            "@media print { .tb-btn { display: none; } }",
        ].join("\n"));
        const css = collectExportCss([sheet], root, root.querySelector(".ProseMirror")!, resolve);
        expect(css).toMatch(/@media \(max-width: 720px\) \{\s*#editor p/);
        expect(css).not.toContain("@media print");
        expect(css).not.toContain(".tb-btn");
    });

    it("font faces should be kept only for families the kept rules reference", () => {
        const sheet = sheetFrom([
            "@font-face { font-family: KaTeX_Main; src: url(data:font/woff2;base64,AA==); }",
            "@font-face { font-family: KaTeX_Fraktur; src: url(data:font/woff2;base64,AA==); }",
            ".katex { font-family: KaTeX_Main, serif; }",
            ".katex .mathfrak { font-family: KaTeX_Fraktur; }",
        ].join("\n"));
        const css = collectExportCss([sheet], root, root.querySelector(".ProseMirror")!, resolve);
        expect(css).toContain("KaTeX_Main");
        expect(css).not.toContain("KaTeX_Fraktur");
    });

    it("a stylesheet living inside the content should be skipped", () => {
        // A connected tree, so jsdom parses the inner <style> into a sheet.
        document.body.innerHTML = '<div class="ProseMirror"><p>x</p><style>#editor p { color: red; }</style></div>';
        const contentRoot = document.body.querySelector(".ProseMirror")!;
        const styleEl = contentRoot.querySelector("style") as HTMLStyleElement;
        const parsed = styleEl.sheet as CSSStyleSheet;
        expect(parsed.cssRules).toHaveLength(1); // the sheet is real, so the skip is what is tested
        // jsdom's sheets carry no ownerNode; hand it the one Chromium would.
        const inner = { cssRules: parsed.cssRules, ownerNode: styleEl } as unknown as CSSStyleSheet;
        const css = collectExportCss([inner], root, contentRoot, resolve);
        expect(css).not.toContain("red");
        // The same sheet from OUTSIDE the content is not skipped: the skip is the containment.
        const outside = { cssRules: parsed.cssRules, ownerNode: document.head } as unknown as CSSStyleSheet;
        expect(collectExportCss([outside], root, contentRoot, resolve)).toContain("red");
    });
});

describe("buildExportDocument and exportTitle", () => {
    it("the document should carry the title, body class, root style, css and content, escaped", () => {
        const html = buildExportDocument({
            title: "A <b> & \"title\"",
            lang: "en",
            bodyClass: "vscode-dark",
            rootStyle: "--content-font-scale: 1.1",
            css: "p { margin: 0 }",
            contentHtml: '<div class="ProseMirror"><p>hi</p></div>',
        });
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("<title>A &lt;b&gt; &amp; &quot;title&quot;</title>");
        expect(html).toContain('<body class="vscode-dark">');
        expect(html).toContain('style="--content-font-scale: 1.1"');
        expect(html).toContain("p { margin: 0 }");
        expect(html).toContain('<div id="editor"><div class="milkdown"><div class="ProseMirror"><p>hi</p></div></div></div>');
        expect(html).toContain("@media print");
    });

    it("the title should be the first heading, else the file name, else a fallback", () => {
        const withHeading = document.createElement("div");
        withHeading.innerHTML = "<p>intro</p><h2>Second</h2>";
        expect(exportTitle(withHeading, "file:///x/My%20Note.md")).toBe("Second");
        expect(exportTitle(document.createElement("div"), "file:///x/My%20Note.md")).toBe("My Note");
        expect(exportTitle(document.createElement("div"), undefined)).toBe("Document");
    });

    it("root style should carry document preferences and drop pane geometry and the palette", () => {
        const root = document.createElement("html");
        root.style.setProperty("--content-font-scale", "1.2");
        root.style.setProperty("--editor-max-width", "60ch");
        root.style.setProperty("--vscode-editor-foreground", "#fff");
        root.style.setProperty("--editor-topbar-height", "40px");
        root.style.setProperty("--bw-pane", "1200px");
        root.style.setProperty("--toc-width", "260px");
        const style = documentRootStyle(root);
        expect(style).toContain("--content-font-scale: 1.2");
        expect(style).toContain("--editor-max-width: 60ch");
        expect(style).not.toMatch(/--vscode-|--editor-topbar-height|--bw-pane|--toc-width/);
    });
});

describe("the export command", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.__i18n = { translations: {}, isMac: true, documentUri: "file:///x/Notes.md" };
    });

    it("exportHtmlLazy should post one exportHtml message carrying the document and its name", async () => {
        document.body.innerHTML = '<div id="editor"><div class="milkdown"><div class="ProseMirror editor" contenteditable="true"><h1>Hello</h1></div></div></div>';
        const { exportHtmlLazy } = await import("../export/loader");
        await exportHtmlLazy();
        const posted = mockVscodeApi.postMessage.mock.calls.map((c) => c[0] as { type: string; html?: string; suggestedName?: string });
        const msg = posted.find((m) => m.type === "exportHtml");
        expect(msg).toBeDefined();
        expect(msg!.suggestedName).toBe("Notes.html");
        expect(msg!.html).toContain("<title>Hello</title>");
        expect(msg!.html).not.toContain("contenteditable");
    });

    it("with no editor mounted it should post nothing", async () => {
        document.body.innerHTML = "";
        const { exportHtmlLazy } = await import("../export/loader");
        await exportHtmlLazy();
        expect(mockVscodeApi.postMessage.mock.calls.some((c) => (c[0] as { type: string }).type === "exportHtml")).toBe(false);
    });

    it("the exporter should stay off the eager import graph, reached only through the loader", async () => {
        const { eagerModulesOf } = await import("./helpers/eagerGraph");
        const eager = new Set(eagerModulesOf());
        expect(eager.has("export/loader.ts")).toBe(true);
        expect(eager.has("export/index.ts")).toBe(false);
    });
});
