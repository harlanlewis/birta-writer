/**
 * Lazy KaTeX loader.
 *
 * The KaTeX rendering engine (~280 KB minified) is only needed once a document
 * actually contains math, so the JS is pulled in through a dynamic `import()`
 * and code-split into its own chunk by esbuild (`splitting: true`). The promise
 * is cached so every math node in a document shares a single load.
 *
 * The stylesheet is imported statically here: KaTeX cannot render without it,
 * and esbuild inlines the referenced woff2 glyph fonts as `data:` URIs (see the
 * webview loader in esbuild.mjs), so no extra network request — and no extra
 * CSP `font-src` host — is required beyond `data:`.
 */
import "katex/dist/katex.min.css";
import type katex from "katex";

type KatexModule = typeof katex;

let katexPromise: Promise<KatexModule> | null = null;

/** Load (and cache) the KaTeX module. */
export function loadKatex(): Promise<KatexModule> {
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
