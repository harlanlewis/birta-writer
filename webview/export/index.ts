/**
 * webview/export/index.ts
 *
 * Export as HTML (MAR-32): the rendered document as one self-contained file.
 *
 * The snapshot is taken from the LIVE editor DOM rather than re-rendered from
 * the schema, because the live tree is the only place the document exists
 * fully rendered: Mermaid diagrams are SVG there, math is KaTeX markup, code
 * carries its highlight tokens, and every NodeView has done its work. A
 * DOMSerializer pass would hand back the schema's bare `toDOM` output, which
 * is what Copy as HTML gives and is the wrong thing for a file meant to be
 * read.
 *
 * Three transformations turn that tree into a document that stands alone:
 *
 * 1. Chrome is stripped. Editor affordances live INSIDE the content tree
 *    (fold gutters, block handles, table grips, code-block rails, diagram
 *    zoom overlays, image toolbars), so the clone is pruned by two rules:
 *    anything the live view is not showing (computed `display: none`,
 *    `visibility: hidden` or `opacity: 0`) goes, and so does a named list of
 *    always-visible chrome. Editing attributes (`contenteditable`,
 *    `tabindex`, `spellcheck`, an island's `role="textbox"`) go with them,
 *    and folds are opened for the length of the snapshot, because a fold is
 *    view state and the file is the document. The few controls that carry
 *    content (the callout kind icon, the image caption field) are rewritten
 *    to static elements.
 * 2. Styles are collected and pruned. Every stylesheet the webview loaded is
 *    walked rule by rule, and a rule is kept only when its selector matches
 *    something in the snapshot, so the file carries the document's CSS and
 *    not the toolbar's. `@font-face` rules are kept only for families the
 *    kept rules reference, which is what keeps a document with one inline
 *    formula from carrying every KaTeX face.
 * 3. `var(--vscode-*)` is resolved. VS Code injects the theme palette on the
 *    root element and nothing else does, so outside VS Code those variables
 *    do not exist. Each is replaced with the value the live root computes to,
 *    which bakes the theme the user was looking at into the file. Every other
 *    custom property is left alone: its definition lives in the CSS being
 *    kept.
 *
 * Images and fonts referenced by URL stay references (v1 inlines nothing as a
 * data URI), so a file with local images travels with its images. There is
 * no PDF path: a webview has no print API, so the file carries print CSS and
 * the host offers to open it in the browser, where print-to-PDF is one step.
 */
import { notifyExportHtml } from "@/messaging";
import { t } from "@/i18n";

/**
 * Chrome that stays visible in the live view and so escapes the computed-
 * style rule. Each is an editor affordance rendered inside the content tree.
 */
export const CHROME_SELECTORS: readonly string[] = [
    ".ProseMirror-widget",          // every widget decoration: fold gutters, block handles, advisories
    ".ProseMirror-separator",       // ProseMirror's own layout hacks
    ".ProseMirror-trailingBreak",
    ".bc-col",                      // block-controls column (width, word-wrap, drag)
    ".mw-table-overlay",            // table grips, insert bars, drag ghost
    ".code-float-rail",             // code block language picker + toggles
    ".code-block-resize-handle",
    ".mermaid-zoom-overlay",        // diagram zoom and pan chrome
    ".mermaid-pan-controls",
    ".puml-zoom-overlay",
    ".puml-pan-controls",
    ".gv-zoom-overlay",
    ".gv-pan-controls",
    ".image-toolbar",               // image path / title editors
    ".fold-ellipsis",               // the "…" shown on a folded block
    ".footnote-def-backlink",       // the ↩ button beside a footnote definition
];

/**
 * The fold plugin's view-state classes (webview/plugins/headingFold): a
 * folded-away block, a heading whose section is folded, and a block folded on
 * itself (a callout, table, code block or footnote showing only its first
 * unit). Each hides content with CSS. Listed as `[selector, class]` because
 * `collapsed` alone is a common word and only the block-host form is the fold's.
 */
const FOLD_STATE_CLASSES: readonly (readonly [string, string])[] = [
    [".heading-fold-hidden", "heading-fold-hidden"],
    [".heading-fold-heading--collapsed", "heading-fold-heading--collapsed"],
    [".block-gutter-host.collapsed", "collapsed"],
];

/**
 * Run `fn` with every fold in `live` opened, then put the folds back exactly.
 * A fold is hidden VIEW state, not hidden content: the file is the document,
 * so folded sections travel. The hidden test is a computed style read off the
 * live tree, and there is no telling a block hidden by a fold from a shell
 * hidden because it is stale, so for the length of one synchronous snapshot
 * the fold classes come off. ProseMirror owns them as decorations and reapplies
 * them on its next update; its mutation observer sees the DOM restored before
 * it runs and finds nothing to reconcile.
 */
function withFoldsOpen<T>(live: HTMLElement, fn: () => T): T {
    // The whole attribute is put back verbatim, so class order (which
    // ProseMirror's reconciler compares as a string) is exactly as it was.
    const restore = new Map<Element, string>();
    for (const [selector, cls] of FOLD_STATE_CLASSES) {
        for (const el of Array.from(live.querySelectorAll(selector))) {
            if (!restore.has(el)) { restore.set(el, el.getAttribute("class") ?? ""); }
            el.classList.remove(cls);
        }
    }
    try {
        return fn();
    } finally {
        for (const [el, className] of restore) { el.setAttribute("class", className); }
    }
}

/** Attributes that make sense only while editing. */
const EDITING_ATTRIBUTES = [
    "contenteditable", "spellcheck", "autocorrect", "autocapitalize", "autocomplete",
    "tabindex", "draggable",
];
/** The editor root's own: `role="textbox"` and `translate="no"` describe the editing surface. */
const ROOT_EDITING_ATTRIBUTES = [...EDITING_ATTRIBUTES, "role", "translate"];

/**
 * Root-level custom properties that describe the editor pane rather than the
 * document (the toolbar's height, the pane width, the caret scroll insets,
 * TOC geometry). Everything else on the root's inline style is a document
 * preference (font preset, font scale, content width, table wrap) and travels.
 */
const PANE_ONLY_ROOT_PROPS = /^--(vscode-|editor-topbar-height$|bw-|caret-scroll-|toc-)/;

/**
 * Body classes the content CSS keys on. The rest (TOC docking, drag state,
 * toolbar visibility) describe chrome that is not in the file.
 */
const BODY_CLASS_ALLOW = /^(vscode-|editor-width-auto$|code-block-word-wrap$|mermaid-canvas-)/;

/** Pseudo-classes and pseudo-elements a static file cannot be in or has no need to match. */
const PSEUDO_STATE_RE = /::?(?:hover|focus|focus-within|focus-visible|active|before|after|marker|placeholder|selection|first-line|first-letter|highlight)(?:\([^)]*\))?/g;

/**
 * Whether the export tree has an element the selector applies to. A selector
 * the export document cannot parse (a `::highlight()` name, `:host`) is
 * retried with its pseudo parts stripped, and one that still fails is kept:
 * an unmatched rule costs bytes, a dropped matched rule costs fidelity.
 */
export function selectorApplies(selector: string, root: Element): boolean {
    const test = (sel: string): boolean | undefined => {
        try {
            return root.matches(sel) || root.querySelector(sel) !== null;
        } catch {
            return undefined;
        }
    };
    const direct = test(selector);
    if (direct) { return true; }
    const stripped = selector.replace(PSEUDO_STATE_RE, "").trim();
    if (stripped === "" || stripped.endsWith(">") || stripped.endsWith("+") || stripped.endsWith("~")) {
        return direct === undefined;
    }
    const relaxed = test(stripped);
    return relaxed === undefined ? direct === undefined : relaxed;
}

/**
 * Replace every `var(--vscode-*)` with the resolved value; a variable that
 * resolves to nothing is left as written (it falls through exactly as it did
 * live). Fallbacks are honoured by the scan and dropped with the reference,
 * because the resolved value is what the live page used.
 */
export function resolveVscodeVars(css: string, resolve: (name: string) => string): string {
    let out = "";
    let i = 0;
    for (;;) {
        const at = css.indexOf("var(", i);
        if (at < 0) { out += css.slice(i); return out; }
        const nameMatch = /^var\(\s*(--vscode-[\w-]+)\s*/.exec(css.slice(at));
        if (!nameMatch) { out += css.slice(i, at + 4); i = at + 4; continue; }
        // Find the closing paren of this var(), depth-aware for a nested fallback.
        let depth = 0;
        let end = -1;
        for (let j = at + 3; j < css.length; j++) {
            const ch = css[j];
            if (ch === "(") { depth++; } else if (ch === ")") { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end < 0) { out += css.slice(i); return out; }
        const value = resolve(nameMatch[1]).trim();
        if (value === "") {
            // Unresolved: keep the reference, but still resolve inside its
            // fallback, which may name a variable that does resolve.
            const nameEnd = at + nameMatch[0].length;
            out += css.slice(i, nameEnd) + resolveVscodeVars(css.slice(nameEnd, end), resolve) + ")";
        } else {
            out += css.slice(i, at) + value;
        }
        i = end + 1;
    }
}

/** Font families a block of CSS references (`font-family:` declarations only). */
function referencedFontFamilies(css: string): Set<string> {
    const names = new Set<string>();
    for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/g)) {
        for (const part of m[1].split(",")) {
            names.add(part.trim().replace(/^["']|["']$/g, "").toLowerCase());
        }
    }
    return names;
}

/** The families a stylesheet's `@font-face` rules declare, one per rule. */
function fontFaceFamily(rule: CSSFontFaceRule): string {
    return rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "").toLowerCase();
}

/**
 * The rules of one stylesheet that apply to `root`, in source order, with
 * conditional at-rules kept around their surviving children. `@font-face`
 * rules are returned separately so the caller can prune them by reference.
 */
function pruneRules(rules: CSSRuleList, root: Element, fontFaces: CSSFontFaceRule[]): string[] {
    const kept: string[] = [];
    // Rules are told apart by shape rather than by constructor: the CSSOM
    // classes differ between Chromium and the jsdom the unit tests run in.
    for (const rule of Array.from(rules)) {
        const text = rule.cssText;
        if ("selectorText" in rule) {
            if (selectorApplies((rule as CSSStyleRule).selectorText, root)) { kept.push(text); }
        } else if (text.startsWith("@font-face")) {
            fontFaces.push(rule as CSSFontFaceRule);
        } else if ("styleSheet" in rule) {
            const imported = (rule as CSSImportRule).styleSheet;
            try { if (imported) { kept.push(...pruneRules(imported.cssRules, root, fontFaces)); } } catch { /* cross-origin */ }
        } else if (text.startsWith("@keyframes") || text.startsWith("@namespace")) {
            // Motion is chrome; namespaces are for XML sheets.
        } else if ("cssRules" in rule) {
            // @media, @supports, @layer, @container, @scope: keep the prelude
            // around whatever survives inside.
            const inner = pruneRules((rule as CSSGroupingRule).cssRules, root, fontFaces);
            if (inner.length > 0) {
                const prelude = text.slice(0, text.indexOf("{")).trim();
                kept.push(`${prelude} {\n${inner.join("\n")}\n}`);
            }
        } else {
            // @property, @counter-style, @page and friends: cheap and possibly load-bearing.
            kept.push(text);
        }
    }
    return kept;
}

/**
 * Collect the CSS the export document needs from the webview's stylesheets:
 * the rules that apply to `root`, the `@font-face` rules those reference,
 * with every `--vscode-*` reference resolved. Sheets that live inside the
 * content itself (a Mermaid SVG's own `<style>`) are skipped, because they
 * travel with the clone.
 */
export function collectExportCss(
    sheets: Iterable<CSSStyleSheet>,
    root: Element,
    contentRoot: Element,
    resolve: (name: string) => string,
): string {
    const kept: string[] = [];
    const fontFaces: CSSFontFaceRule[] = [];
    for (const sheet of sheets) {
        if (sheet.ownerNode && contentRoot.contains(sheet.ownerNode)) { continue; }
        let rules: CSSRuleList;
        try { rules = sheet.cssRules; } catch { continue; }
        kept.push(...pruneRules(rules, root, fontFaces));
    }
    const css = kept.join("\n");
    const families = referencedFontFamilies(css);
    const faces = fontFaces.filter((f) => families.has(fontFaceFamily(f))).map((f) => f.cssText);
    return resolveVscodeVars([...faces, css].join("\n"), resolve);
}

/** Attributes that carry ONE resource URL the webview may have rewritten. */
const RESOURCE_URL_ATTRS = ["src", "poster"] as const;

/**
 * A resource URL the webview rewrote onto its own resource origin, turned
 * back into a path relative to the document's directory: the form the author
 * wrote, and the form that resolves when the export sits beside the document
 * (where the save dialog defaults). Anything on another origin, or with no
 * document base to relate to, is left as it is. The webview's own query
 * string (the resource loader's) is dropped with the origin.
 */
export function relativizeResourceUrl(url: string, documentBase: string | undefined): string {
    if (!documentBase) { return url; }
    let target: URL;
    let base: URL;
    try {
        target = new URL(url);
        base = new URL(documentBase);
    } catch {
        return url;
    }
    if (target.origin !== base.origin || target.origin === "null") { return url; }
    const from = base.pathname.split("/").slice(1, -1); // directory segments
    const to = target.pathname.split("/").slice(1);
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) { common++; }
    const up = from.slice(common).map(() => "..");
    const rel = [...up, ...to.slice(common)].join("/");
    return rel === "" ? url : rel + target.hash;
}

/** Whether a live element is something the view is not actually showing. */
function isHiddenLive(el: Element, view: Window): boolean {
    const cs = view.getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0";
}

/**
 * A chrome-free clone of the live content root. Decisions are made against
 * the LIVE elements (their computed style is what says whether the view shows
 * them) and applied to the clone at the same index: `cloneNode(true)` and
 * `querySelectorAll("*")` share document order, so the two walks line up.
 */
export function snapshotContent(live: HTMLElement, view: Window = window): HTMLElement {
    return withFoldsOpen(live, () => snapshotUnfolded(live, view));
}

function snapshotUnfolded(live: HTMLElement, view: Window): HTMLElement {
    const clone = live.cloneNode(true) as HTMLElement;
    const rootComputed = view.getComputedStyle(view.document.documentElement);
    const resolveRootVar = (name: string): string => rootComputed.getPropertyValue(name);
    const liveAll = Array.from(live.querySelectorAll("*"));
    const cloneAll = Array.from(clone.querySelectorAll("*"));
    const chromeSelector = CHROME_SELECTORS.join(",");
    for (let i = 0; i < liveAll.length; i++) {
        const src = liveAll[i];
        const dst = cloneAll[i];
        if (!clone.contains(dst)) { continue; } // an ancestor already went
        // A NodeView's contents are what the user sees; its container's own
        // hover chrome is handled by the named list. Inside an SVG nothing is
        // chrome, and its computed styles do not follow the HTML rules.
        if (src.closest("svg") !== null && src.tagName.toLowerCase() !== "svg") { continue; }
        if (src.matches(chromeSelector) || isHiddenLive(src, view)) {
            dst.remove();
            continue;
        }
        const tag = src.tagName.toLowerCase();
        if (tag === "button") {
            if (src.classList.contains("callout-kind")) {
                // The callout's kind icon is content: keep it as a static span.
                const span = dst.ownerDocument.createElement("span");
                span.className = dst.className;
                span.append(...Array.from(dst.childNodes));
                dst.replaceWith(span);
            } else {
                dst.remove();
            }
            continue;
        }
        if (tag === "input" || tag === "textarea" || tag === "select") {
            const value = (src as HTMLInputElement).value;
            if (src.classList.contains("image-caption") && value.trim() !== "") {
                const cap = dst.ownerDocument.createElement("div");
                cap.className = dst.className;
                cap.textContent = value;
                dst.replaceWith(cap);
            } else {
                dst.remove();
            }
            continue;
        }
        for (const attr of EDITING_ATTRIBUTES) { dst.removeAttribute(attr); }
        // Editable islands inside NodeViews (a callout title, an inline
        // source field) announce themselves as text boxes; a static file has none.
        if (dst.getAttribute("role") === "textbox") { dst.removeAttribute("role"); }
        for (const attr of RESOURCE_URL_ATTRS) {
            const url = dst.getAttribute(attr);
            if (url) { dst.setAttribute(attr, relativizeResourceUrl(url, view.__i18n?.resourceBaseUri)); }
        }
        const inline = dst.getAttribute("style");
        if (inline !== null) {
            if (inline.trim() === "") {
                dst.removeAttribute("style");
            } else {
                dst.setAttribute("style", resolveVscodeVars(inline, resolveRootVar));
            }
        }
    }
    for (const attr of ROOT_EDITING_ATTRIBUTES) { clone.removeAttribute(attr); }
    if ((clone.getAttribute("style") ?? "").trim() === "") { clone.removeAttribute("style"); }
    return clone;
}

/** The export's own page rules: the editor's pane layout undone, and print geometry. */
export const EXPORT_PAGE_CSS = `
html, body { height: auto; }
#editor {
    min-height: 0;
    padding: 3rem 3rem 4rem;
    --editor-content-left-padding: 3rem;
    --editor-content-right-padding: 3rem;
}
#editor .bw-full, #editor .bw-wide {
    width: auto;
    max-width: none;
    margin-left: 0;
}
@page { margin: 2cm; }
@media print {
    #editor { padding: 0; max-width: none; }
    pre, table, figure, .mw-table, .code-block-wrapper, .callout, .diagram-preview, .image-wrapper { break-inside: avoid; }
    h1, h2, h3, h4, h5, h6 { break-after: avoid; }
}
`;

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The document's own name without its extension, from its URI; empty when there is none. */
function documentStem(documentUri: string | undefined): string {
    const base = documentUri?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    try { return decodeURIComponent(base); } catch { return base; }
}

/** The document's title: its first heading, else the file's own name. */
export function exportTitle(content: Element, documentUri: string | undefined): string {
    const heading = content.querySelector("h1, h2, h3, h4, h5, h6")?.textContent?.trim();
    return heading || documentStem(documentUri) || t("Document");
}

export interface ExportDocumentParts {
    title: string;
    lang: string;
    bodyClass: string;
    /** `prop: value` pairs for the export root's inline style. */
    rootStyle: string;
    css: string;
    /** The pruned `.ProseMirror` clone's outer HTML. */
    contentHtml: string;
}

/** Assemble the final file. */
export function buildExportDocument(parts: ExportDocumentParts): string {
    const rootStyle = parts.rootStyle ? ` style="${escapeHtml(parts.rootStyle)}"` : "";
    return `<!doctype html>
<html lang="${escapeHtml(parts.lang || "en")}"${rootStyle}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(parts.title)}</title>
<style>
${parts.css}
${EXPORT_PAGE_CSS}
</style>
</head>
<body class="${escapeHtml(parts.bodyClass)}">
<div id="editor"><div class="milkdown">${parts.contentHtml}</div></div>
</body>
</html>
`;
}

/** The root inline declarations that describe the document rather than the pane. */
export function documentRootStyle(root: HTMLElement): string {
    const decls: string[] = [];
    for (let i = 0; i < root.style.length; i++) {
        const name = root.style[i];
        if (PANE_ONLY_ROOT_PROPS.test(name)) { continue; }
        decls.push(`${name}: ${root.style.getPropertyValue(name)}`);
    }
    return decls.join("; ");
}

/**
 * Render the live document to a self-contained HTML string. Exported for the
 * e2e harness, which reads the string back and opens it as its own page.
 */
export function renderExportHtml(view: Window = window): string | null {
    const live = view.document.querySelector<HTMLElement>(".milkdown .ProseMirror");
    if (!live) { return null; }
    const content = snapshotContent(live, view);
    // Match selectors against a document shaped exactly like the file: html >
    // body.<theme> > #editor > .milkdown > .ProseMirror, so `body.vscode-dark
    // …` and `#editor …` rules resolve as they will when the file opens.
    const bodyClass = Array.from(view.document.body.classList).filter((c) => BODY_CLASS_ALLOW.test(c)).join(" ");
    const shadow = view.document.implementation.createHTMLDocument("");
    shadow.body.className = bodyClass;
    const editorEl = shadow.createElement("div");
    editorEl.id = "editor";
    const milkdown = shadow.createElement("div");
    milkdown.className = "milkdown";
    milkdown.appendChild(shadow.importNode(content, true));
    editorEl.appendChild(milkdown);
    shadow.body.appendChild(editorEl);

    const rootStyle = view.getComputedStyle(view.document.documentElement);
    const css = collectExportCss(
        Array.from(view.document.styleSheets),
        shadow.documentElement,
        live,
        (name) => rootStyle.getPropertyValue(name),
    );
    return buildExportDocument({
        title: exportTitle(content, view.__i18n?.documentUri),
        lang: view.document.documentElement.lang,
        bodyClass,
        rootStyle: documentRootStyle(view.document.documentElement),
        css,
        contentHtml: content.outerHTML,
    });
}

/** The command: render, then hand the file to the host to save. */
export function exportDocumentAsHtml(): void {
    const html = renderExportHtml();
    if (html === null) { return; }
    notifyExportHtml(html, `${documentStem(window.__i18n?.documentUri) || "document"}.html`);
}
