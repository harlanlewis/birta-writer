/**
 * Lazy Mermaid loader.
 *
 * Mermaid (and its diagram-type sub-bundles) is large and only needed once a
 * document renders a ```mermaid block, so it is pulled in through a dynamic
 * `import()` and code-split into its own chunk by esbuild (`splitting: true`).
 * A static `import mermaid from "mermaid"` would drag the Mermaid entry into the
 * eager launch graph even for documents that contain no diagrams. The promise is
 * cached so every diagram in a document shares a single load.
 */
import type mermaid from "mermaid";

type MermaidModule = typeof mermaid;

let mermaidPromise: Promise<MermaidModule> | null = null;

/** Load (and cache) the Mermaid module. */
export function loadMermaid(): Promise<MermaidModule> {
    if (!mermaidPromise) {
        mermaidPromise = import("mermaid").then((m) => m.default);
    }
    return mermaidPromise;
}
