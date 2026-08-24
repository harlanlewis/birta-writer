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
 * 2. **Graphviz is not optional, but it is lazy.** Nine of PlantUML's diagram
 *    families (class, state, component, deployment, use case, object, ERD,
 *    DOT, ArchiMate — class diagrams above all) are laid out by Graphviz,
 *    which the engine reaches through a `globalThis.__graphviz_anywhere_render`
 *    bridge. Without it those diagrams fail with "graphviz render failed"
 *    while sequence and activity diagrams still work, which would read as a
 *    random half-broken feature. We bridge to `@hpcc-js/wasm-graphviz`
 *    (Apache-2.0, the long-established Graphviz WASM build) rather than the
 *    upstream package's own young optional peer, and the bridge is installed
 *    before the first `convert()` can run.
 *
 *    The Graphviz engine itself is NOT loaded up front: a sequence-only
 *    document never calls the bridge, so it must never pay for that engine
 *    (MAR-369). Which family a source belongs to is decided deep inside the
 *    engine and is not something a sniff can predict (`title hi` alone is a
 *    class diagram; `A -up-> B` is a sequence), so instead of guessing, the
 *    bridge is installed as a thunk and the engine is fetched on demand: a
 *    `convert()` that reaches the bridge before Graphviz is here fails fast,
 *    the loader awaits `loadGraphviz()`, and the SAME source is converted
 *    again. `convert()` is a pure function of its source, and a bridge that
 *    throws is a path the compiled engine already survives (it is exactly
 *    what "no bridge installed" looked like), so the retry is safe. The
 *    failure mode of every branch is "loaded" or "rendered", never
 *    "graphviz render failed" for a family that needed it.
 *
 *    That engine comes from `utils/graphvizLoader.ts`, which ```graphviz
 *    blocks use directly (MAR-330). Sharing the loader is what keeps a document
 *    holding both from instantiating the same WASM module twice, and its
 *    `peekGraphviz()` is how the synchronous bridge finds an engine that is
 *    already here without starting a load.
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
 * bump a version that will never move.
 *
 * This paragraph IS the record, and there is deliberately no ticket beside it.
 * MAR-331 said all of the above and recommended waiting for a trigger, which
 * is a thing to read at the moment somebody touches this loader rather than a
 * thing to meet while ranking a backlog; and the trigger, a wrong render or
 * somebody wanting post-1.2026.2 syntax, arrives as its own bug report.
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

import { loadGraphviz, peekGraphviz } from "./graphvizLoader";

/** The subset of the engine we use: PlantUML source in, SVG markup out. */
export type PlantUmlEngine = {
    /**
     * Render PlantUML source to SVG markup. Rejects on invalid input. Async
     * because a source that turns out to need Graphviz layout loads that
     * engine here, on first need, rather than every document paying for it.
     */
    convert(source: string): Promise<string>;
    /** The bundled engine version, tracking the upstream PlantUML release. */
    version(): string;
};

/** The bridge signature the compiled engine calls for Graphviz layout. */
type GraphvizBridge = (dot: string, engine: string, format: string) => string;

const GRAPHVIZ_BRIDGE_KEY = "__graphviz_anywhere_render";

let enginePromise: Promise<PlantUmlEngine> | null = null;

/**
 * Set by the bridge when the compiled engine asked for Graphviz layout and no
 * engine was loaded yet. `convert()` clears it before a render and reads it
 * after; the calls are synchronous, so nothing can interleave. It is what
 * tells a "needs Graphviz" failure apart from a genuinely invalid diagram
 * without parsing the engine's error text.
 */
let graphvizMissed = false;

/**
 * The bridge itself is synchronous, called from inside the compiled engine
 * mid-render, so it can only use an engine that is already here. When there is
 * none it records the miss and throws; the throw surfaces from `convert()` as
 * the engine's own layout error and the loader takes it from there.
 *
 * The loader's `layout(dot, format, engine)` takes its arguments in a
 * different order from the bridge's (dot, engine, format), which is the other
 * reason this wrapper exists.
 */
const bridge: GraphvizBridge = (dot, engine, format) => {
    const graphviz = peekGraphviz();
    if (!graphviz) {
        graphvizMissed = true;
        throw new Error("Graphviz engine not loaded yet");
    }
    return graphviz.layout(dot, format, engine);
};

async function instantiate(): Promise<PlantUmlEngine> {
    const [glue, wasm] = await Promise.all([
        import("@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js"),
        import("@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.wasm"),
    ]);

    // Install the Graphviz bridge BEFORE instantiating, so no convert() can
    // observe a half-wired engine.
    (globalThis as Record<string, unknown>)[GRAPHVIZ_BRIDGE_KEY] = bridge;

    // Cast: the BufferSource overload is the one that applies (we pass bytes,
    // not a compiled Module), but the `*.wasm` ambient type is a bare
    // Uint8Array and TS picks the Module overload from it.
    const { instance } = (await WebAssembly.instantiate(wasm.default as BufferSource, {
        "./plantuml_little_web_bg.js": glue as unknown as WebAssembly.ModuleImports,
    })) as WebAssembly.WebAssemblyInstantiatedSource;
    glue.__wbg_set_wasm(instance.exports);

    const convert = async (source: string): Promise<string> => {
        if (!peekGraphviz()) {
            // First attempt without Graphviz. Most families never reach the
            // bridge and return here; one that does fails fast and tells us.
            // The flag, not the outcome, decides: whatever the engine made of
            // a bridge that threw, a render that asked for layout and got none
            // is not the render to hand back.
            graphvizMissed = false;
            let attempt: { ok: true; svg: string } | { ok: false; err: unknown };
            try {
                attempt = { ok: true, svg: glue.convert(source) };
            } catch (err) {
                attempt = { ok: false, err };
            }
            if (!graphvizMissed) {
                if (attempt.ok) return attempt.svg;
                throw attempt.err;
            }
            await loadGraphviz();
        }
        return glue.convert(source);
    };

    return { convert, version: glue.version };
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
    graphvizMissed = false;
    delete (globalThis as Record<string, unknown>)[GRAPHVIZ_BRIDGE_KEY];
}
