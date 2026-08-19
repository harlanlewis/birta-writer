import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

// Production (vscode:prepublish) builds start from a clean dist/: chunk file
// names are content-hashed, so repeated dev builds accumulate stale chunks
// that vsce would happily package — the 0.2.154 VSIX shipped ~400 dead chunk
// files (21.5 MB where the real bundle is ~11 MB). Dev/watch builds skip the
// wipe so a running Extension Development Host never loses files under it.
if (isProduction && !isWatch) {
    fs.rmSync('dist', { recursive: true, force: true });
}
// `--metafile` writes one dist/<entry>.meta.json per shipped bundle.
// The webview one drives bundle analysis (see e2e/perf-bundle.mjs); both drive
// the third-party attribution generator (scripts/generate-third-party-notices.mjs),
// which needs the union of what BOTH bundles inline to know what actually ships.
// Off by default so normal builds stay lean.
const withMetafile = process.argv.includes('--metafile');

const commonOptions = {
    bundle: true,
    minify: isProduction,
    sourcemap: !isProduction,
    logLevel: 'info',
};

// Extension host (Node.js)
const extensionBuild = {
    ...commonOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    alias: {
        // harper.js publishes ESM-only exports; point at its entry so the
        // CJS extension bundle can inline it.
        'harper.js': path.resolve('./node_modules/harper.js/dist/index.js'),
    },
    metafile: withMetafile,
};

// Harper's WASM binary is loaded from dist/ at runtime (see harperService.ts)
function copyHarperWasm() {
    fs.mkdirSync('dist', { recursive: true });
    fs.copyFileSync(
        path.resolve('./node_modules/harper.js/dist/harper_wasm_bg.wasm'),
        path.resolve('./dist/harper_wasm_bg.wasm'),
    );
}

/**
 * Rebind the bare `refractor` specifier to our core singleton shim.
 *
 * `@milkdown/plugin-prism` does `import { refractor } from "refractor"`, whose
 * package entry is `refractor/lib/common.js`: the same singleton `refractor/core`
 * exports, but with 35 grammars registered onto it at import time. refractor
 * lists that file in `sideEffects`, so esbuild cannot tree-shake the
 * registrations — ~82 KB of grammars landed in the eager launch bundle,
 * duplicating a subset of the lazy chunk in webview/highlighterLanguages.ts.
 * The shim keeps the instance and drops the payload; highlighterLanguages.ts
 * registers a superset of common so no language loses coverage.
 *
 * This must be an exact-match `onResolve` rather than an `alias` entry: esbuild
 * aliases also match subpaths, which would rewrite `refractor/core` and the 60+
 * `refractor/<lang>` imports the lazy grammar chunk is built from.
 */
const refractorSingletonPlugin = {
    name: 'refractor-singleton',
    setup(build) {
        const shim = path.resolve('./webview/refractorSingleton.ts');
        build.onResolve({ filter: /^refractor$/ }, () => ({ path: shim }));
    },
};

/**
 * Resolve the two `plantuml-little` internals the PlantUML loader imports.
 *
 * The package's `exports` map publishes only `.` and `./wasm`, and both lead to
 * the wasm-pack `bundler`-target entry whose `import * as wasm from
 * "./plantuml_little_web_bg.wasm"` esbuild cannot resolve (it does not
 * implement the WebAssembly ESM integration proposal). `plantUmlLoader.ts`
 * therefore instantiates the module itself and needs the glue and the binary
 * as two separate imports, which the exports map does not expose.
 *
 * Mapping them here — rather than reaching into `node_modules` from the
 * loader's import specifiers — keeps the coupling to upstream's internal
 * layout in ONE place, next to the other build-time package surgery, where a
 * version bump that moves these files fails the build loudly instead of
 * silently resolving to something else. The paths are asserted at build time
 * for exactly that reason.
 */
const plantUmlWasmPlugin = {
    name: 'plantuml-wasm',
    setup(build) {
        const base = './node_modules/@kookyleo/plantuml-little-web/dist/wasm';
        const files = {
            '@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js':
                path.resolve(`${base}/plantuml_little_web_bg.js`),
            '@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.wasm':
                path.resolve(`${base}/plantuml_little_web_bg.wasm`),
        };
        for (const [specifier, file] of Object.entries(files)) {
            if (!fs.existsSync(file)) {
                throw new Error(
                    `plantuml-wasm: ${file} is missing, so "${specifier}" cannot be resolved. ` +
                    `@kookyleo/plantuml-little-web has probably changed its dist layout.`,
                );
            }
        }
        build.onResolve({ filter: /^@kookyleo\/plantuml-little-web\/dist\/wasm\// }, (args) => {
            const file = files[args.path];
            return file ? { path: file } : null;
        });
    },
};

// WebView frontend (Browser) - ESM + code splitting, lazy-loads Mermaid etc.
const webviewBuild = {
    ...commonOptions,
    // KaTeX's stylesheet is a SECOND entry so it emits as dist/katex.css instead
    // of being hoisted into the render-blocking entry webview.css. It is injected
    // lazily at runtime the first time math loads (see webview/utils/katexLoader.ts).
    // hostPalette.css is a THIRD entry for the same reason, with the opposite
    // consumer: the --vscode-* palette a non-VS-Code host (jot/, the e2e
    // harness) links in place of the workbench's. It must never be hoisted
    // into webview.css, where it would fight the injected palette inside VS
    // Code; webview/__tests__/hostPalette.test.ts pins that no module imports it.
    entryPoints: {
        webview: 'webview/index.ts',
        katex: 'katex/dist/katex.min.css',
        hostPalette: 'webview/ui/hostPalette.css',
    },
    outdir: 'dist',
    platform: 'browser',
    target: 'es2020',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    loader: {
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
    },
    alias: {
        '@': path.resolve('./webview'),
    },
    plugins: [refractorSingletonPlugin, plantUmlWasmPlugin],
    metafile: withMetafile,
};

// The rendered-diff panel (MAR-55): its own page, and deliberately its own
// build rather than a fourth entry of webviewBuild. Sharing that build would
// mean sharing its `splitting: true`, which redistributes common modules into
// chunks and so changes how many resources the EDITOR fetches at launch - the
// one number this repository gates on every PR. A separate pass keeps
// dist/webview.js and its chunk graph identical whether or not this panel
// exists; the cost is that the ProseMirror and markdown presets it
// needs are its own copy, paid only by a panel the user opened.
const diffViewBuild = {
    // A shipped bundle with no metafile is invisible to the third-party
    // notices generator, whose whole claim is that it reports what the
    // bundles inline. Same reason perf-bundle reads metafiles rather than
    // the dependency tree.
    metafile: withMetafile,
    ...commonOptions,
    entryPoints: { diffView: 'webview/diffView/index.ts' },
    outdir: 'dist',
    platform: 'browser',
    target: 'es2020',
    format: 'esm',
    splitting: false,
    alias: {
        '@': path.resolve('./webview'),
    },
};

copyHarperWasm();

if (isWatch) {
    const [ctx1, ctx2, ctx3] = await Promise.all([
        esbuild.context(extensionBuild),
        esbuild.context(webviewBuild),
        esbuild.context(diffViewBuild),
    ]);
    await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()]);
    console.log('Watching for changes...');
} else {
    const [extensionResult, webviewResult, diffViewResult] = await Promise.all([
        esbuild.build(extensionBuild),
        esbuild.build(webviewBuild),
        esbuild.build(diffViewBuild),
    ]);
    if (withMetafile && webviewResult.metafile) {
        fs.writeFileSync(
            path.resolve('./dist/webview.meta.json'),
            JSON.stringify(webviewResult.metafile),
        );
    }
    if (withMetafile && extensionResult.metafile) {
        fs.writeFileSync(
            path.resolve('./dist/extension.meta.json'),
            JSON.stringify(extensionResult.metafile),
        );
    }
    if (withMetafile && diffViewResult.metafile) {
        fs.writeFileSync(
            path.resolve('./dist/diffView.meta.json'),
            JSON.stringify(diffViewResult.metafile),
        );
    }
}
