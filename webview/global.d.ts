// Global CSS module declaration: allows importing any .css file in TypeScript (side-effect import)
declare module '*.css' {}

// esbuild's `binary` loader (see esbuild.mjs) turns a .wasm import into the
// module's raw bytes. Only PlantUML's engine is imported this way.
declare module '*.wasm' {
    const bytes: Uint8Array;
    export default bytes;
}

/**
 * The wasm-bindgen glue for `plantuml-little`, imported directly rather than
 * through the package entry.
 *
 * The package is built with wasm-pack's `bundler` target, whose entry
 * (`dist/wasm/plantuml_little_web.js`) does `import * as wasm from
 * "./plantuml_little_web_bg.wasm"` and hands that namespace to
 * `__wbg_set_wasm`. That import only resolves in bundlers implementing the
 * WebAssembly ESM integration proposal, which esbuild does not. We therefore
 * bypass the entry and close the glue↔wasm cycle by hand in
 * `webview/utils/plantUmlLoader.ts`. Untyped upstream, so declared here.
 */
declare module '@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js' {
    /** Render PlantUML source to an SVG string. Throws on invalid input. */
    export function convert(source: string): string;
    /** The bundled engine version (tracks the upstream PlantUML release). */
    export function version(): string;
    /** wasm-bindgen's back-reference hook; called once after instantiation. */
    export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
