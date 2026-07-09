/**
 * Eager-bytes metric — the zero-variance companion to e2e/perf.mjs.
 *
 * Walks dist/webview.meta.json from the webview entry, following ONLY
 * `import-statement` edges (never `dynamic-import`), to sum the JS bytes the
 * browser must fetch+parse before the editor can boot, plus the render-blocking
 * entry CSS bytes. Unlike wall-clock timings this is deterministic, so an
 * eager-bytes reduction can justify committing a launch-neutral change, and any
 * eager-bytes increase is an instant red flag.
 *
 * Usage:
 *   pnpm build --metafile && pnpm perf:bundle
 *   node e2e/perf-bundle.mjs --json bundle-after.json
 *   node e2e/perf-bundle.mjs --compare bundle-before.json bundle-after.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const metaPath = join(repoRoot, "dist", "webview.meta.json");
const kb = (b) => Math.round((b / 1024) * 10) / 10;

async function computeEager() {
    let meta;
    try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
        console.error("dist/webview.meta.json not found — run `pnpm build --metafile` first.");
        process.exit(2);
    }
    const outputs = meta.outputs;
    // The entry JS output is the one whose entryPoint is the webview entry.
    const entry = Object.keys(outputs).find(
        (o) => outputs[o].entryPoint === "webview/index.ts" || basename(o) === "webview.js",
    );
    if (!entry) {
        console.error("could not find the webview.js entry in the metafile");
        process.exit(2);
    }

    // BFS over import-statement edges only.
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
        const cur = queue.shift();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const imp of outputs[cur].imports ?? []) {
            if (imp.kind === "import-statement" && outputs[imp.path] && !seen.has(imp.path)) {
                queue.push(imp.path);
            }
        }
    }

    let eagerJs = 0;
    for (const o of seen) eagerJs += outputs[o].bytes ?? 0;

    // Render-blocking CSS = the cssBundle of each eagerly-reached JS output.
    // esbuild attaches the concatenated stylesheet for a JS file to its
    // `cssBundle` field, so the entry's cssBundle is webview.css and any eager
    // chunk's CSS is included too. A CSS-only entry point (dist/katex.css) is
    // NOT the cssBundle of any JS output, so it is correctly excluded — it is
    // injected lazily, not render-blocking.
    let eagerCss = 0;
    const cssSeen = new Set();
    for (const o of seen) {
        const cb = outputs[o].cssBundle;
        if (cb && outputs[cb] && !cssSeen.has(cb)) {
            cssSeen.add(cb);
            eagerCss += outputs[cb].bytes ?? 0;
        }
    }

    // Total emitted bytes (incl. lazy chunks + separate CSS entries), for context.
    let totalJs = 0, totalCss = 0;
    for (const [o, info] of Object.entries(outputs)) {
        if (o.endsWith(".js")) totalJs += info.bytes ?? 0;
        else if (o.endsWith(".css")) totalCss += info.bytes ?? 0;
    }

    return {
        eagerJs,
        eagerCss,
        eagerTotal: eagerJs + eagerCss,
        eagerChunkCount: seen.size,
        totalJs,
        totalCss,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const cmpIdx = argv.indexOf("--compare");
    if (cmpIdx !== -1) {
        const before = JSON.parse(await readFile(argv[cmpIdx + 1], "utf8"));
        const after = JSON.parse(await readFile(argv[cmpIdx + 2], "utf8"));
        const line = (label, b, a) => {
            const d = a - b;
            const pct = b ? (d / b) * 100 : 0;
            const sign = d >= 0 ? "+" : "";
            console.log(`  ${label.padEnd(12)} ${kb(b)}KB → ${kb(a)}KB  (${sign}${kb(d)}KB, ${sign}${Math.round(pct * 10) / 10}%)`);
        };
        console.log("\neager bundle compare\n");
        line("eager JS", before.eagerJs, after.eagerJs);
        line("eager CSS", before.eagerCss, after.eagerCss);
        line("eager total", before.eagerTotal, after.eagerTotal);
        // Fail on >1% eager-total growth (the plan's second gate).
        const grow = (after.eagerTotal - before.eagerTotal) / before.eagerTotal;
        console.log(`\nverdict: ${grow > 0.01 ? "EAGER BYTES GREW >1% — do not commit" : "ok"}\n`);
        process.exit(grow > 0.01 ? 1 : 0);
    }

    const r = await computeEager();
    const jsonIdx = argv.indexOf("--json");
    console.log("\neager bundle (fetched+parsed before editor boots)\n");
    console.log(`  eager JS     ${kb(r.eagerJs)} KB  across ${r.eagerChunkCount} chunks`);
    console.log(`  eager CSS    ${kb(r.eagerCss)} KB  (render-blocking)`);
    console.log(`  eager total  ${kb(r.eagerTotal)} KB`);
    console.log(`  (all JS      ${kb(r.totalJs)} KB, all CSS ${kb(r.totalCss)} KB incl. lazy)\n`);
    if (jsonIdx !== -1) {
        await writeFile(argv[jsonIdx + 1], JSON.stringify(r, null, 2));
        console.log(`wrote ${argv[jsonIdx + 1]}\n`);
    }
}

await main();
