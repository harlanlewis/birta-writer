import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');
// `--metafile` writes dist/webview.meta.json for bundle analysis (see
// e2e/perf-bundle.mjs). Off by default so normal builds stay lean.
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
};

// Harper's WASM binary is loaded from dist/ at runtime (see harperService.ts)
function copyHarperWasm() {
    fs.mkdirSync('dist', { recursive: true });
    fs.copyFileSync(
        path.resolve('./node_modules/harper.js/dist/harper_wasm_bg.wasm'),
        path.resolve('./dist/harper_wasm_bg.wasm'),
    );
}

// WebView frontend (Browser) - ESM + code splitting, lazy-loads Mermaid etc.
const webviewBuild = {
    ...commonOptions,
    // KaTeX's stylesheet is a SECOND entry so it emits as dist/katex.css instead
    // of being hoisted into the render-blocking entry webview.css. It is injected
    // lazily at runtime the first time math loads (see webview/utils/katexLoader.ts).
    entryPoints: { webview: 'webview/index.ts', katex: 'katex/dist/katex.min.css' },
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
    },
    alias: {
        '@': path.resolve('./webview'),
    },
    metafile: withMetafile,
};

copyHarperWasm();

if (isWatch) {
    const [ctx1, ctx2] = await Promise.all([
        esbuild.context(extensionBuild),
        esbuild.context(webviewBuild),
    ]);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    console.log('Watching for changes...');
} else {
    const [, webviewResult] = await Promise.all([
        esbuild.build(extensionBuild),
        esbuild.build(webviewBuild),
    ]);
    if (withMetafile && webviewResult.metafile) {
        fs.writeFileSync(
            path.resolve('./dist/webview.meta.json'),
            JSON.stringify(webviewResult.metafile),
        );
    }
}
