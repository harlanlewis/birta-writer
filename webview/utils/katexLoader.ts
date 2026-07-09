/**
 * Lazy KaTeX loader.
 *
 * The KaTeX rendering engine (~280 KB minified) is only needed once a document
 * actually contains math, so the JS is pulled in through a dynamic `import()`
 * and code-split into its own chunk by esbuild (`splitting: true`). The promise
 * is cached so every math node in a document shares a single load.
 *
 * The stylesheet is emitted as its OWN entry (`dist/katex.css`, see esbuild.mjs)
 * rather than imported here — a static import would hoist KaTeX's ~1.4 MB of CSS
 * (its glyph fonts are inlined as `data:` URIs) into the render-blocking entry
 * `webview.css` on every launch, math or not. Instead we inject a `<link>` to it
 * the first time math loads. esbuild still inlines the fonts as `data:` URIs, so
 * no extra `font-src` host beyond `data:` is needed; the stylesheet itself is
 * served from `dist/`, allowed by the existing `style-src ${webview.cspSource}`.
 */
import type katex from "katex";

type KatexModule = typeof katex;

let katexPromise: Promise<KatexModule> | null = null;
let katexCssInjected = false;

/**
 * Inject the KaTeX stylesheet once, resolving `dist/katex.css` relative to the
 * built bundle (`import.meta.url` → `.../dist/webview.js`). Fire-and-forget: the
 * math JS resolves independently, so a first math node may paint one frame
 * before the glyph metrics land — acceptable, and it never blocks rendering (or
 * hangs in jsdom, where no load event fires).
 */
function ensureKatexCss(): void {
    if (katexCssInjected || typeof document === "undefined" || !document.head) {
        return;
    }
    katexCssInjected = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("katex.css", import.meta.url).href;
    link.dataset.katexCss = "";
    document.head.appendChild(link);
}

/** Load (and cache) the KaTeX module, injecting its stylesheet on first use. */
export function loadKatex(): Promise<KatexModule> {
    ensureKatexCss();
    if (!katexPromise) {
        katexPromise = import("katex").then((m) => m.default);
    }
    return katexPromise;
}

/**
 * Render a LaTeX string into `target`, replacing its contents. Errors never
 * throw (`throwOnError: false`): KaTeX paints the offending source in red so
 * the user can see and fix it. `displayMode` selects block vs. inline layout.
 */
export async function renderKatexInto(
    target: HTMLElement,
    latex: string,
    displayMode: boolean,
): Promise<void> {
    const katexApi = await loadKatex();
    katexApi.render(latex, target, {
        throwOnError: false,
        displayMode,
    });
}
