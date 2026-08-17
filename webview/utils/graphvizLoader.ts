/**
 * Lazy Graphviz loader, shared by the two things that need DOT layout.
 *
 * `@hpcc-js/wasm-graphviz` (Apache-2.0) is the long-established Graphviz WASM
 * build. It arrives through a cached dynamic `import()` and is code-split into
 * its own chunk, so a document with neither a ```graphviz fence nor a PlantUML
 * diagram that needs DOT layout never pulls it onto the launch path. Mirrors
 * `mermaidLoader.ts` / `katexLoader.ts`.
 *
 * WHY THIS IS A MODULE RATHER THAN TWO CALLS. `plantUmlLoader.ts` reached for
 * `Graphviz.load()` first, to bridge the nine PlantUML families that are laid
 * out by Graphviz. A ```graphviz block needs the same engine directly. Two
 * independent `load()` calls instantiate the WASM module twice in a document
 * holding both, for no benefit: the instance is stateless across `layout()`
 * calls, so one is enough and the second is pure cost.
 *
 * A failed load is NOT cached, so a transient failure can be retried by the
 * next render rather than poisoning the feature for the life of the webview.
 * That is the same contract `loadPlantUml` keeps, and it is why the catch
 * clears the promise rather than storing the rejection.
 *
 * The engine never reaches the network: it is vendored into our bundle at build
 * time and lays out the DOT it is handed, nothing more (docs/NETWORK_POSTURE.md,
 * rung 0).
 */

/** The subset of the engine we use: DOT in, SVG markup out. */
export type GraphvizEngine = {
    layout(dot: string, format: string, engine: string): string;
};

let enginePromise: Promise<GraphvizEngine> | null = null;
let engine: GraphvizEngine | null = null;

/**
 * The engine if it has already loaded, else null, without starting a load.
 * The PlantUML bridge is synchronous (the compiled engine calls it mid-render),
 * so it can only ever use an engine that is already here; this is how it finds
 * out whether one is.
 */
export function peekGraphviz(): GraphvizEngine | null {
    return engine;
}

/**
 * Load (and cache) the Graphviz engine. Every caller in a document shares one
 * instantiation.
 */
export function loadGraphviz(): Promise<GraphvizEngine> {
    if (!enginePromise) {
        enginePromise = import("@hpcc-js/wasm-graphviz")
            .then((mod) => mod.Graphviz.load())
            .then((graphviz): GraphvizEngine => {
                // @hpcc-js types `format` and `engine` as unions of the names it
                // knows; both of our callers pass names through as plain strings
                // (PlantUML's compiled engine hands them across a bridge), and a
                // name it does not know is a runtime error there rather than
                // something that can usefully be narrowed here.
                type Layout = typeof graphviz.layout;
                engine = {
                    layout: (dot, format, layoutEngine) =>
                        graphviz.layout(
                            dot,
                            format as Parameters<Layout>[1],
                            layoutEngine as Parameters<Layout>[2],
                        ),
                };
                return engine;
            })
            .catch((err) => {
                enginePromise = null;
                throw err;
            });
    }
    return enginePromise;
}

/** Test seam: forget the cached engine so a suite can re-exercise the load. */
export function resetGraphvizEngineForTests(): void {
    enginePromise = null;
    engine = null;
}
