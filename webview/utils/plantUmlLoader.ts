/**
 * Lazy PlantUML loader.
 *
 * `plantuml-little` is an independent Rust reimplementation of PlantUML
 * (byte-exact reference tests against upstream Java PlantUML) compiled to
 * WebAssembly, so diagrams render entirely on this machine. The engine is
 * ~3 MB, and only a document containing a ```plantuml fence needs it, so
 * everything here is reached through cached dynamic `import()`s and code-split
 * into its own chunk — a static import would drag the engine onto the launch
 * path for every document. Mirrors `mermaidLoader.ts` / `katexLoader.ts`.
 *
 * Two things about this module are load-bearing:
 *
 * 1. **It closes the wasm-bindgen cycle by hand.** The upstream package is
 *    built with wasm-pack's `bundler` target: its glue imports the `.wasm`
 *    module and the `.wasm` module imports the glue's callbacks back. That
 *    mutual import only resolves in a bundler implementing the WebAssembly
 *    ESM integration proposal, which esbuild does not. So we import the glue
 *    and the raw bytes separately (the `binary` loader in esbuild.mjs), pass
 *    the glue *as* the wasm's import object, and hand the resulting exports
 *    back with `__wbg_set_wasm` — which is precisely what the generated entry
 *    would have done.
 *
 * 2. **Graphviz is not optional.** Nine of PlantUML's diagram families (class,
 *    state, component, deployment, use case, object, ERD, DOT, ArchiMate —
 *    class diagrams above all) are laid out by Graphviz, which the engine
 *    reaches through a `globalThis.__graphviz_anywhere_render` bridge. Without
 *    it those diagrams fail with "graphviz render failed" while sequence and
 *    activity diagrams still work, which would read as a random half-broken
 *    feature. We bridge to `@hpcc-js/wasm-graphviz` (Apache-2.0, the
 *    long-established Graphviz WASM build) rather than the upstream package's
 *    own young optional peer, and the bridge is installed before the first
 *    `convert()` can run.
 *
 * PROVENANCE, and what "update the engine" means here (checked 2026-08-08).
 * The npm package we depend on is a frozen snapshot, and updating it is not a
 * `pnpm update`. Know this before reaching for one:
 *
 * - The Rust crate `plantuml-little` is alive and maintained. It sits at
 *   1.2026.2-4 on crates.io (July 2026), and its home is now
 *   `Actrium/plantuml-little`, having also been merged into `Actrium/supramark`
 *   by git subtree.
 * - The npm WASM wrapper `@kookyleo/plantuml-little-web` is NOT. It has exactly
 *   one published version, 1.2026.2-3 (April 2026), and `kookyleo/plantuml-little`
 *   — the repository that published it — is archived. It is not deprecated and
 *   installs fine; it simply has no maintained publishing home.
 * - Supramark's own `@supramark/*` packages are documented but unpublished, so
 *   there is currently nothing to migrate TO.
 *
 * So we are one patch behind a live crate, with no npm path to it. The
 * consequences are bounded and worth naming: no upstream fix reaches us
 * automatically, and the engine tracks upstream PlantUML 1.2026.2, so syntax
 * added to PlantUML after that release will not render. Neither is urgent —
 * the version is lockfile-pinned, vendored into our bundle at build time (so
 * the registry is not a runtime dependency), and verified end-to-end by
 * `e2e/plantUmlRender`. When an update IS wanted, the route is to build the
 * wasm from the crate or pick up a supramark package once one exists, not to
 * bump a version that will never move. Tracked in MAR-331.
 *
 * IF YOU ARE AUDITING THE BUNDLE AND FOUND `License GPL`: that string is in
 * `dist/`, and it is output data rather than a license grant. The engine can
 * emit upstream PlantUML's own version banner —
 * `PlantUML version 1.2026.2 / bb8550d [...]` followed by `License GPL` —
 * because a diagram asking for `version` must print what upstream prints, byte
 * for byte, which is the entire point of a reimplementation targeting output
 * parity. No GPL code is bundled: what we ship is the Rust reimplementation
 * under the MIT election recorded in `scripts/generate-third-party-notices.mjs`.
 * The long-form answer, including why upstream's GPL/LGPL stdlib sprites are
 * NOT in this artifact, is in `THIRD_PARTY_NOTICES.md`.
 *
 * The engine never reaches the network. PlantUML's `!theme <name>` and
 * `!include <url>` directives resolve over HTTP in upstream Java PlantUML;
 * this build is compiled without its `remote` feature, so they fail closed
 * with "remote fetch disabled" instead. A document therefore cannot make the
 * editor fetch anything, which is what keeps diagram rendering compatible with
 * `birta.network.enabled` being off (docs/NETWORK_POSTURE.md, rung 0).
 */

/** The subset of the engine we use: PlantUML source in, SVG markup out. */
export type PlantUmlEngine = {
    /** Render PlantUML source to SVG markup. Throws on invalid input. */
    convert(source: string): string;
    /** The bundled engine version, tracking the upstream PlantUML release. */
    version(): string;
};

/** The bridge signature the compiled engine calls for Graphviz layout. */
type GraphvizBridge = (dot: string, engine: string, format: string) => string;

const GRAPHVIZ_BRIDGE_KEY = "__graphviz_anywhere_render";

let enginePromise: Promise<PlantUmlEngine> | null = null;

async function instantiate(): Promise<PlantUmlEngine> {
    const [glue, wasm, graphvizModule] = await Promise.all([
        import("@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js"),
        import("@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.wasm"),
        import("@hpcc-js/wasm-graphviz"),
    ]);

    // Install the Graphviz bridge BEFORE instantiating, so no convert() can
    // observe a half-wired engine. `layout(dot, format, engine)` — note the
    // argument order differs from the bridge's (dot, engine, format).
    const graphviz = await graphvizModule.Graphviz.load();
    // The engine passes Graphviz's own format/engine names through as plain
    // strings; @hpcc-js types them as unions, and a name it does not know is a
    // runtime error there rather than something we can usefully narrow here.
    type Layout = typeof graphviz.layout;
    const bridge: GraphvizBridge = (dot, engine, format) =>
        graphviz.layout(dot, format as Parameters<Layout>[1], engine as Parameters<Layout>[2]);
    (globalThis as Record<string, unknown>)[GRAPHVIZ_BRIDGE_KEY] = bridge;

    // Cast: the BufferSource overload is the one that applies (we pass bytes,
    // not a compiled Module), but the `*.wasm` ambient type is a bare
    // Uint8Array and TS picks the Module overload from it.
    const { instance } = (await WebAssembly.instantiate(wasm.default as BufferSource, {
        "./plantuml_little_web_bg.js": glue as unknown as WebAssembly.ModuleImports,
    })) as WebAssembly.WebAssemblyInstantiatedSource;
    glue.__wbg_set_wasm(instance.exports);

    return { convert: glue.convert, version: glue.version };
}

/**
 * Load (and cache) the PlantUML engine. The promise is cached so every diagram
 * in a document shares one instantiation; a failed load is NOT cached, so a
 * transient failure can be retried by the next render rather than poisoning
 * the feature for the life of the webview.
 */
export function loadPlantUml(): Promise<PlantUmlEngine> {
    if (!enginePromise) {
        enginePromise = instantiate().catch((err) => {
            enginePromise = null;
            throw err;
        });
    }
    return enginePromise;
}

/** Test seam: forget the cached engine so a suite can re-exercise the load. */
export function resetPlantUmlEngineForTests(): void {
    enginePromise = null;
    delete (globalThis as Record<string, unknown>)[GRAPHVIZ_BRIDGE_KEY];
}
