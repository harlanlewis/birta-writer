/**
 * Lazy DOMPurify loader, plus the `style` attribute policy (MAR-366).
 *
 * DOMPurify (~27 KB minified) is only needed when a document contains inline
 * HTML, so it is pulled in through a dynamic `import()` and code-split into its
 * own chunk by esbuild (`splitting: true`) instead of riding the launch bundle
 * every time. The promise is cached, so every html node in a document shares
 * one load. Mirrors `katexLoader.ts`; unlike KaTeX there is no sibling asset to
 * resolve, so the `import.meta.url` caveat does not apply here.
 *
 * The hook is installed with the module rather than passed per call, so every
 * caller of `loadSanitizer` gets the same policy and no future sink can opt out
 * of it by writing its own config.
 */
import type DOMPurify from "dompurify";
import { resolveResourceUrlsIn } from "./resourceUri";

type DOMPurifyModule = typeof DOMPurify;

/**
 * Declarations a document must not be able to write.
 *
 * The rendered face is `display: contents` (style.css, `.html-inline`), so it
 * has no box of its own and CSS containment has nothing to hold: what a
 * document's own CSS can reach has to be decided here instead. `position` is
 * what lets a declaration leave the flow entirely, and dropping it leaves
 * `inset`/`top`/`z-index` inert without naming them. A viewport unit is the
 * other way out, sizing a box against the window rather than its container.
 *
 * This is a blocklist, and a blocklist can be outrun by a property nobody
 * thought of. That is the accepted trade (maintainer decision, MAR-366): an
 * allowlist would silently drop the legitimate CSS that HTML-in-Markdown is
 * mostly made of.
 */
const ESCAPING_PROPERTIES = new Set(["position", "z-index"]);
const VIEWPORT_UNIT_RE = /\d[\d.]*[dsl]?v(?:h|w|b|i|min|max)\b/i;

/**
 * Split `css` on top-level `;` only.
 *
 * A naive split tears `background: url(data:image/png;base64,...)` in half, so
 * separators inside parentheses and quotes are not separators. The browser's
 * own parser would be the obvious tool, and is the wrong one: reading a
 * declaration back out of a `CSSStyleDeclaration` normalizes it and silently
 * drops whatever that engine does not implement, which makes the same input
 * behave differently under jsdom and Chromium.
 */
function splitDeclarations(css: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (quote) {
            if (ch === quote && css[i - 1] !== "\\") quote = "";
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (ch === ";" && depth === 0) {
            out.push(css.slice(start, i));
            start = i + 1;
        }
    }
    out.push(css.slice(start));
    return out;
}

/**
 * Drop the escaping declarations from one `style` attribute value.
 *
 * Kept declarations are returned verbatim, never reserialized, so authored CSS
 * renders as written.
 */
export function filterStyleAttribute(value: string): string {
    return splitDeclarations(value)
        .filter((decl) => {
            const colon = decl.indexOf(":");
            if (colon === -1) return false;
            const property = decl.slice(0, colon).trim().toLowerCase();
            if (ESCAPING_PROPERTIES.has(property)) return false;
            return !VIEWPORT_UNIT_RE.test(decl.slice(colon + 1));
        })
        .map((decl) => decl.trim())
        .filter(Boolean)
        .join("; ");
}

/**
 * The ```svg fence's policy (MAR-402).
 *
 * A ```svg fence is the one construct that puts markup the DOCUMENT AUTHOR
 * wrote into the live DOM: every other diagram engine renders its own output
 * from a source language. So this is the sink, and it is the only one whose
 * defence has to hold with no CSP behind it, because Export as HTML writes a
 * plain file with no CSP at all (export/index.ts, `buildExportDocument`). An
 * in-editor check of a `<script>` or an `onload=` passes either way, since the
 * webview's CSP already makes both inert; the exported file is where the
 * difference between a sanitizer that runs and one that does not is visible.
 *
 * The tag and attribute allowlist is DOMPurify's own `svg` and `svgFilters`
 * profiles, taken as they come. That set already excludes `foreignObject` and
 * `use` (its `svgDisallowed` list), which is the namespace-confusion surface,
 * and following it rather than editing it is what keeps this policy from
 * becoming a hand-maintained copy of a library internal that rots in silence.
 * The two consequences worth knowing: an SVG whose text labels are HTML inside
 * a `<foreignObject>` loses those labels, and an icon sprite built on `<use>`
 * renders empty.
 *
 * `style` is the one addition. It is an ALLOWED svg tag, and a `<style>` inside
 * an inline SVG is not scoped to that SVG: its selectors reach the whole
 * document, which is the MAR-366 escape by another door. The element goes, and
 * DOMPurify's default `FORBID_CONTENTS` already drops its text (and a
 * `<script>`'s) so nothing leaks through as a stray text node. That default is
 * deliberately not overridden here: passing `FORBID_CONTENTS` REPLACES the
 * default set rather than adding to it, so naming one tag would silently
 * un-forbid every other.
 *
 * The `style` ATTRIBUTE still arrives with the MAR-366 filter already on it,
 * from the module-level hook below.
 */
export const SVG_SANITIZE_CONFIG: Parameters<DOMPurifyModule["sanitize"]>[1] = {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style"],
};

/** Attributes whose whole value is a URL to fetch. */
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

/**
 * A reference that leaves this machine: any scheme except `data:`, and the
 * protocol-relative `//host/path` form.
 *
 * `data:` stays because an embedded raster is how every design tool ships a
 * bitmap inside an SVG, and it fetches nothing. A bare `#fragment` has no
 * scheme, so it falls through as local, which is what makes gradients, filters
 * and clip paths keep working.
 */
const REMOTE_REFERENCE_RE = /^(?!data:)(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Every `url(...)` payload in an attribute value, quotes stripped. */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * Should this attribute be dropped for pointing off the machine?
 *
 * Two shapes, because a URL reaches an SVG two ways: as the whole value of
 * `href`/`xlink:href`/`src`, and as a `url(...)` inside `fill`, `filter`,
 * `mask`, `clip-path` or `style`. Whitespace is collapsed first, since it is
 * legal inside both and is the obvious way to hide a scheme from a matcher.
 *
 * `<a>` is exempt on the URL-attribute limb and only there: a link navigates on
 * a click the reader chooses to make, which is what every markdown link in the
 * document already does, whereas an `<image href>` or a `<feImage href>` fetches
 * the moment the picture paints. A `javascript:` href never reaches here;
 * DOMPurify's own `ALLOWED_URI_REGEXP` has already refused it.
 */
export function isRemoteReferenceAttribute(
    tagName: string,
    attrName: string,
    value: string,
): boolean {
    const collapsed = value.replace(/\s+/g, "");
    if (
        tagName.toLowerCase() !== "a" &&
        URL_ATTRIBUTES.has(attrName.toLowerCase()) &&
        REMOTE_REFERENCE_RE.test(collapsed)
    ) {
        return true;
    }
    CSS_URL_RE.lastIndex = 0;
    for (let m = CSS_URL_RE.exec(collapsed); m; m = CSS_URL_RE.exec(collapsed)) {
        if (REMOTE_REFERENCE_RE.test(m[2])) return true;
    }
    return false;
}

let purifyPromise: Promise<DOMPurifyModule> | null = null;

/** Load (and cache) the DOMPurify module, with the style policy installed. */
export function loadSanitizer(): Promise<DOMPurifyModule> {
    if (!purifyPromise) {
        purifyPromise = import("dompurify").then((m) => {
            const purify = m.default;
            purify.addHook("uponSanitizeAttribute", (_node, data) => {
                if (data.attrName !== "style") return;
                data.attrValue = filterStyleAttribute(data.attrValue);
                if (!data.attrValue) data.keepAttr = false;
            });
            // Remote references, dropped for the svg profile only. Installed
            // with the module like the style policy above, so a future SVG sink
            // cannot write its own config without it; gated on the profile the
            // CALL asked for, so inline HTML (`htmlView`, `{ html: true }`) is
            // untouched and its images still resolve.
            purify.addHook("afterSanitizeAttributes", (node, _event, config) => {
                if (config.USE_PROFILES === false || config.USE_PROFILES?.svg !== true) return;
                for (const attr of Array.from(node.attributes)) {
                    if (isRemoteReferenceAttribute(node.localName, attr.name, attr.value)) {
                        node.removeAttribute(attr.name);
                    }
                }
            });
            return purify;
        });
    }
    return purifyPromise;
}

/**
 * Sanitize a ```svg fence's source down to the markup that may be painted.
 *
 * Returns a string rather than writing into an element, because the shared
 * diagram pane owns the write (`diagramPane.ts` assigns `innerHTML` and then
 * stamps the natural size onto the root). That keeps ONE sink for a diagram's
 * markup and leaves this function the only thing between the fence and it.
 */
export async function sanitizeSvgMarkup(raw: string): Promise<string> {
    const purify = await loadSanitizer();
    return purify.sanitize(raw, SVG_SANITIZE_CONFIG) as string;
}

/**
 * Sanitize `raw` and write it into `target`, replacing its contents.
 *
 * The write lands a frame or two after the caller returns, so a freshly mounted
 * inline-HTML node paints empty first — the same trade the lazy KaTeX and
 * Mermaid loaders already make, and invisible in practice because the node is
 * inline and the chunk is already on disk.
 *
 * Relative resource URLs are resolved against the document AFTER the sanitizer
 * has run (utils/resourceUri.ts), so what gets a document-relative URL is only
 * ever an element the filter already kept. The rewrite is the rendered
 * attribute's alone: `raw` is the document's bytes and stays untouched.
 */
export async function sanitizeInto(
    target: HTMLElement,
    raw: string,
    config: Parameters<DOMPurifyModule["sanitize"]>[1],
): Promise<void> {
    const purify = await loadSanitizer();
    target.innerHTML = purify.sanitize(raw, config) as string;
    resolveResourceUrlsIn(target);
}
