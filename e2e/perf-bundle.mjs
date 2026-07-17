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
 *   node e2e/perf-bundle.mjs --check            # CI gate vs the committed baseline
 *   node e2e/perf-bundle.mjs --write-baseline   # accept an intentional increase
 *
 * `--check` is the CI eager-bytes gate: it fails on ANY eager-total growth over
 * the committed baseline (e2e/perf/bundle-baseline.json). It can be exact
 * because esbuild output is deterministic for a given lockfile — two clean
 * production builds produce byte-identical bundles. An intentional increase is
 * accepted by re-running `--write-baseline` and committing the updated file.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const metaPath = join(repoRoot, "dist", "webview.meta.json");
const baselinePath = join(repoRoot, "e2e", "perf", "bundle-baseline.json");
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

    if (argv.includes("--write-baseline")) {
        const r = await computeEager();
        await writeFile(
            baselinePath,
            JSON.stringify(
                {
                    note: "Committed eager-bytes baseline for the CI perf-bundle gate (`pnpm perf:bundle --check`). Deterministic for a given lockfile. To accept an intentional eager-bytes increase: `node esbuild.mjs --production --metafile && node e2e/perf-bundle.mjs --write-baseline`, then commit this file (and say why in the commit).",
                    ...r,
                },
                null,
                2,
            ) + "\n",
        );
        console.log(`wrote ${baselinePath} (eager total ${kb(r.eagerTotal)} KB)`);
        return;
    }

    if (argv.includes("--check")) {
        let baseline;
        try {
            baseline = JSON.parse(await readFile(baselinePath, "utf8"));
        } catch {
            // A missing/corrupt baseline must FAIL the gate, never silently pass.
            console.error(
                `eager-bytes baseline missing or unreadable: ${baselinePath}\n` +
                    "Regenerate it with: node esbuild.mjs --production --metafile && node e2e/perf-bundle.mjs --write-baseline",
            );
            process.exit(2);
        }
        const r = await computeEager();
        const d = r.eagerTotal - baseline.eagerTotal;
        console.log("\neager bundle vs committed baseline (e2e/perf/bundle-baseline.json)\n");
        console.log(`  eager JS     ${kb(baseline.eagerJs)}KB → ${kb(r.eagerJs)}KB`);
        console.log(`  eager CSS    ${kb(baseline.eagerCss)}KB → ${kb(r.eagerCss)}KB`);
        console.log(`  eager total  ${kb(baseline.eagerTotal)}KB → ${kb(r.eagerTotal)}KB  (${d >= 0 ? "+" : ""}${d} bytes)`);
        if (d > 0) {
            console.error(
                `\nEAGER BYTES GREW by ${d} bytes (+${kb(d)} KB) over the committed baseline.\n` +
                    "The launch bundle must stay lean (CLAUDE.md, 'Launch performance'): anything not\n" +
                    "needed for first paint should load lazily via dynamic import().\n" +
                    "If this increase is intentional and justified, accept it with:\n" +
                    "  node esbuild.mjs --production --metafile && node e2e/perf-bundle.mjs --write-baseline\n" +
                    "then commit e2e/perf/bundle-baseline.json and explain the increase in the commit body.\n",
            );
            process.exit(1);
        }
        if (d < 0) {
            console.log(
                "\nok — eager bytes SHRANK; consider ratcheting the baseline down with\n" +
                    "`node e2e/perf-bundle.mjs --write-baseline` in this commit.\n",
            );
        } else {
            console.log("\nok — eager bytes unchanged.\n");
        }
        return;
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
