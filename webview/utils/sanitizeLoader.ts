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
            return purify;
        });
    }
    return purifyPromise;
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
