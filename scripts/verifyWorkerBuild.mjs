/**
 * The verify worker's esbuild configuration (webview/workers/verifyWorker.ts),
 * in one place so the build and the test that runs its output build the same
 * script. `esbuild.mjs`'s `verifyWorkerPlugin` inlines the result into the
 * webview bundle; `shared/__tests__/verifyWorkerBundle.test.ts` evaluates it
 * in a scope that has no document, which is the only reading of "this script
 * can run in a worker" that is about the script that ships.
 *
 * Why the test cannot be the unit test that imports the entry: Vitest
 * resolves packages under Node's conditions and esbuild under the browser's,
 * and a package can ship a DOM build for the browser that its Node build
 * does not need. `decode-named-character-reference` is one: its browser
 * entry creates an element at load, so the worker script threw on its first
 * line of it while every Node test of the same modules was green. The plugin
 * below is the answer for that package; the vm test is the answer for the
 * next one.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The webview build's loaders, shared with the worker build. */
export const WEBVIEW_LOADER = {
    '.ttf': 'dataurl',
    // KaTeX's stylesheet references its glyph fonts; inline them as data:
    // URIs so no extra webview resource fetch (or CSP host) is needed.
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
    // PlantUML's engine ships as a wasm-bindgen "bundler"-target binary.
    // `binary` inlines it as a Uint8Array inside the lazy chunk that
    // imports it, which keeps the CSP at one added directive: the webview
    // never fetches the module, so `connect-src` stays absent and
    // `default-src 'none'` keeps blocking every request the webview could
    // make. See webview/utils/plantUmlLoader.ts for the instantiation.
    '.wasm': 'binary',
};

/**
 * `decode-named-character-reference` publishes two entries: `index.dom.js`,
 * which decodes through a DOM element and creates it at load, and
 * `index.js`, which decodes through the `character-entities` table. The
 * package's `browser` field sends a browser build to the first; a worker has
 * no document and takes the second, which decodes the same HTML5 entity list.
 */
const domFreeEntities = {
    name: 'dom-free-entities',
    setup(build) {
        build.onResolve({ filter: /^decode-named-character-reference$/ }, async (args) => {
            // The re-entrant resolve below reaches this handler again; it is
            // the package's own resolution that is wanted there.
            if (args.pluginData?.skip) return null;
            const resolved = await build.resolve(args.path, {
                kind: args.kind,
                resolveDir: args.resolveDir,
                pluginData: { skip: true },
            });
            if (resolved.errors.length) return resolved;
            const tableBuild = path.join(path.dirname(resolved.path), 'index.js');
            if (!fs.existsSync(tableBuild)) {
                throw new Error(
                    `dom-free-entities: ${tableBuild} is missing beside ${resolved.path}; ` +
                    'decode-named-character-reference has changed its layout.',
                );
            }
            return { path: tableBuild };
        });
    },
};

/**
 * The options for one build of the worker script. Self-contained: a classic
 * worker in `iife` form with no splitting, because a Blob-origin script has
 * nothing to resolve a chunk against (webview/utils/verifyOracle.ts).
 *
 * @param {{ production: boolean, webviewDir: string }} opts
 */
export function verifyWorkerBuildOptions({ production, webviewDir }) {
    return {
        entryPoints: [path.join(webviewDir, 'workers', 'verifyWorker.ts')],
        bundle: true,
        write: false,
        outdir: 'dist',
        platform: 'browser',
        target: 'es2020',
        format: 'iife',
        minify: production,
        sourcemap: false,
        logLevel: 'silent',
        alias: { '@': webviewDir },
        loader: WEBVIEW_LOADER,
        plugins: [domFreeEntities],
        metafile: true,
    };
}
