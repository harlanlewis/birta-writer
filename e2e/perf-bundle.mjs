/**
 * Eager-bytes metric — the zero-variance companion to e2e/perf.mjs.
 *
 * Walks dist/webview.meta.json from the webview entry, following ONLY
 * `import-statement` edges (never `dynamic-import`), to sum the JS bytes the
 * browser must fetch+parse before the editor can boot (JS is boot-blocking —
 * the entry is a deferred `<script type=module>`), plus the render-blocking
 * entry CSS bytes (`<link>` in the head). Deterministic for a given lockfile.
 *
 * This is a cheap, browser-free BACKSTOP: it catches "bytes added without
 * asking" — an accidental static `import` of a heavy dep into the first-paint
 * graph (KaTeX, Mermaid, a grammar), which is a step-change of tens-to-hundreds
 * of KB. The wall-clock launch A/B (e2e/perf-ab.mjs) is the primary guard and
 * catches the complementary class — time added *without* bytes.
 *
 * Usage:
 *   pnpm build --metafile && pnpm perf:bundle
 *   node e2e/perf-bundle.mjs --json bundle-after.json
 *   node e2e/perf-bundle.mjs --compare bundle-before.json bundle-after.json
 *   node e2e/perf-bundle.mjs --check              # CI gate: eagerTotal must be under the budget
 *   node e2e/perf-bundle.mjs --set-budget [bytes] # raise the ceiling deliberately (milestone)
 *   node e2e/perf-bundle.mjs --write-baseline     # refresh the informational snapshot only
 *
 * `--check` gates on a fixed BUDGET (a ceiling with headroom in
 * e2e/perf/bundle-baseline.json → `eagerBudget`), not a ratchet to the current
 * bytes. Normal feature growth flows under the ceiling silently; the gate fires
 * only when eager bytes near the launch cliff we actually care about. Raise the
 * ceiling consciously at a milestone with `--set-budget`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const metaPath = join(repoRoot, "dist", "webview.meta.json");
const baselinePath = join(repoRoot, "e2e", "perf", "bundle-baseline.json");
const kb = (b) => Math.round((b / 1024) * 10) / 10;

const BUDGET_NOTE =
    "Eager-bytes BUDGET for the CI gate (`pnpm perf:bundle --check`): the gate fails only when `eagerTotal` exceeds `eagerBudget` — a deliberate ceiling with headroom, NOT a per-commit ratchet to current bytes. Normal feature growth flows under it silently. Raise the ceiling consciously at a milestone: `node esbuild.mjs --production --metafile && node e2e/perf-bundle.mjs --set-budget`, then commit this file and say why. The remaining fields are the last measured snapshot (informational), refreshed with `--write-baseline`.";

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

    if (argv.includes("--set-budget") || argv.includes("--write-baseline")) {
        const r = await computeEager();
        let prev = {};
        try { prev = JSON.parse(await readFile(baselinePath, "utf8")); } catch { /* first write */ }

        let eagerBudget;
        if (argv.includes("--set-budget")) {
            const next = argv[argv.indexOf("--set-budget") + 1];
            const explicit = Number(next);
            // Explicit byte ceiling if given, else current + 8% headroom (→ 1 KB).
            eagerBudget = next && !next.startsWith("--") && Number.isFinite(explicit)
                ? explicit
                : Math.ceil((r.eagerTotal * 1.08) / 1024) * 1024;
        } else {
            // --write-baseline refreshes the snapshot but PRESERVES the ceiling.
            eagerBudget = prev.eagerBudget;
            if (eagerBudget == null) {
                console.error("no eagerBudget in the baseline yet — set one first with `--set-budget`.");
                process.exit(2);
            }
        }

        await writeFile(baselinePath, JSON.stringify({ note: BUDGET_NOTE, eagerBudget, ...r }, null, 2) + "\n");
        console.log(
            `wrote ${baselinePath}\n  eager total ${kb(r.eagerTotal)} KB / budget ${kb(eagerBudget)} KB ` +
                `(${kb(eagerBudget - r.eagerTotal)} KB headroom)`,
        );
        return;
    }

    if (argv.includes("--check")) {
        let baseline;
        try {
            baseline = JSON.parse(await readFile(baselinePath, "utf8"));
        } catch {
            // A missing/corrupt budget must FAIL the gate, never silently pass.
            console.error(
                `eager-bytes budget missing or unreadable: ${baselinePath}\n` +
                    "Set it with: node esbuild.mjs --production --metafile && node e2e/perf-bundle.mjs --set-budget",
            );
            process.exit(2);
        }
        const budget = baseline.eagerBudget;
        if (budget == null) {
            console.error(`no eagerBudget in ${baselinePath} — set one with \`--set-budget\`.`);
            process.exit(2);
        }
        const r = await computeEager();
        const headroom = budget - r.eagerTotal;
        console.log("\neager bundle vs budget (e2e/perf/bundle-baseline.json)\n");
        console.log(`  eager JS     ${kb(r.eagerJs)}KB`);
        console.log(`  eager CSS    ${kb(r.eagerCss)}KB`);
        console.log(
            `  eager total  ${kb(r.eagerTotal)}KB  /  budget ${kb(budget)}KB  ` +
                `(${Math.abs(headroom)} bytes ${headroom >= 0 ? "headroom" : "OVER"})`,
        );
        if (r.eagerTotal > budget) {
            console.error(
                `\nEAGER BYTES are ${r.eagerTotal - budget} bytes (+${kb(r.eagerTotal - budget)} KB) OVER the ${kb(budget)} KB budget.\n` +
                    "The launch bundle must stay lean (AGENTS.md, 'Launch performance'): a jump this size\n" +
                    "usually means a heavy dep was statically imported into the first-paint graph — load it\n" +
                    "lazily via dynamic import() instead.\n" +
                    "If the growth is deliberate and the new normal is acceptable, raise the ceiling with:\n" +
                    "  node esbuild.mjs --production --metafile && node e2e/perf-bundle.mjs --set-budget\n" +
                    "then commit e2e/perf/bundle-baseline.json and explain the increase in the commit body.\n",
            );
            process.exit(1);
        }
        console.log(`\nok — ${kb(headroom)} KB under budget.\n`);
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
