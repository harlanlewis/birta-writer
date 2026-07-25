/**
 * Lazy DOMPurify loader.
 *
 * DOMPurify (~27 KB minified) is only needed when a document contains inline
 * HTML, so it is pulled in through a dynamic `import()` and code-split into its
 * own chunk by esbuild (`splitting: true`) instead of riding the launch bundle
 * every time. The promise is cached, so every html node in a document shares
 * one load. Mirrors `katexLoader.ts`; unlike KaTeX there is no sibling asset to
 * resolve, so the `import.meta.url` caveat does not apply here.
 */
import type DOMPurify from "dompurify";

type DOMPurifyModule = typeof DOMPurify;

let purifyPromise: Promise<DOMPurifyModule> | null = null;

/** Load (and cache) the DOMPurify module. */
export function loadSanitizer(): Promise<DOMPurifyModule> {
    if (!purifyPromise) {
        purifyPromise = import("dompurify").then((m) => m.default);
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
 */
export async function sanitizeInto(
    target: HTMLElement,
    raw: string,
    config: Parameters<DOMPurifyModule["sanitize"]>[1],
): Promise<void> {
    const purify = await loadSanitizer();
    target.innerHTML = purify.sanitize(raw, config) as string;
}
