/**
 * Heavy-fixture COUNT gate: hold the work counters one typing run stamped
 * against the ceilings in e2e/perf/heavy-budget.json.
 *
 *   node e2e/perf-typing.mjs huge-outline --json typing.json
 *   node e2e/perf-counts.mjs --check typing.json        # the nightly's verdict; exit 1 on any failure
 *   node e2e/perf-counts.mjs --set-budget typing.json   # re-record every ceiling from this run, plus headroom
 *
 * Browser-free and therefore outside the harness lock: it reads a JSON another
 * runner wrote and contends with nothing (`e2e/harnessEntryPoints.test.mjs`
 * lists it as exempt for that reason). The decision logic is in
 * e2e/perf/counts.mjs so it can be unit-tested; this file is argument parsing
 * and I/O.
 *
 * Why a checked-in ceiling rather than yesterday's run: the counts are
 * deterministic, so the ceiling is a contract the way `eagerBudget` is, and a
 * file in the tree is reviewed with the change that moves it. A comparison
 * against a stored artifact from the previous night would need that artifact
 * to exist, would drift with every accepted change, and would make the first
 * night after a deliberate move a false red.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWork, countVerdict, formatVerdict, proposeBudget, COUNT_HEADROOM_PCT } from "./perf/counts.mjs";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const budgetPath = join(repoRoot, "e2e", "perf", "heavy-budget.json");

const argv = process.argv.slice(2);
const usage = "usage: node e2e/perf-counts.mjs (--check | --set-budget) <typing.json>";

async function readReport(path) {
    if (!path || path.startsWith("--")) {
        console.error(usage);
        process.exit(2);
    }
    let report;
    try {
        report = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
        console.error(`cannot read ${path}: ${e.message}\n${usage}`);
        process.exit(2);
    }
    const work = collectWork(report);
    if (Object.keys(work).length === 0) {
        console.error(`${path} carries no per-fixture work counts (expected e2e/perf-typing.mjs --json output).`);
        process.exit(2);
    }
    return work;
}

const setIdx = argv.indexOf("--set-budget");
const checkIdx = argv.indexOf("--check");

async function readBudget() {
    try {
        return JSON.parse(await readFile(budgetPath, "utf8"));
    } catch {
        return null;
    }
}

if (setIdx !== -1) {
    const work = await readReport(argv[setIdx + 1]);
    // The reported-only list and its reasons are the one thing a re-set
    // PRESERVES: they are judgements about what a counter measures, not
    // readings, and a run cannot re-derive them. Edit them by hand.
    const prev = await readBudget();
    const budget = proposeBudget(work, prev?.reported ?? {});
    await writeFile(budgetPath, JSON.stringify(budget, null, 2) + "\n");
    console.log(`wrote ${budgetPath} (ceilings = measured + ${COUNT_HEADROOM_PCT}%; \`reported\` carried over)\n`);
    console.log(formatVerdict(countVerdict(work, budget)));
    process.exit(0);
}

if (checkIdx !== -1) {
    const work = await readReport(argv[checkIdx + 1]);
    const budget = await readBudget();
    if (!budget) {
        console.error(`no budget at ${budgetPath}. Set one with: node e2e/perf-counts.mjs --set-budget <typing.json>`);
        process.exit(2);
    }
    const verdict = countVerdict(work, budget);
    console.log(formatVerdict(verdict));
    if (verdict.failures.length === 0) {
        console.log(`\nverdict: OK — ${verdict.reached} counter(s) under their ceilings.`);
        process.exit(0);
    }
    const kinds = [...new Set(verdict.failures.map((f) => f.status))].join(", ");
    console.error(
        `\nverdict: FAILED (${kinds}).\n` +
        "  OVER        a pass became proportional to the document again; fix it (AGENTS.md, \"Launch performance\").\n" +
        "  unbudgeted  a new counter is on neither list; give it a ceiling with --set-budget, or, if a timer\n" +
        "              rather than the document decides it, add it to `reported` with the reason.\n" +
        "  missing     a listed counter stopped being stamped; a dash reads exactly like \"cheap\".\n" +
        "To record the current counts as the new ceilings deliberately:\n" +
        "  node e2e/perf-counts.mjs --set-budget <typing.json>   (then commit e2e/perf/heavy-budget.json and say why)\n",
    );
    process.exit(1);
}

console.error(usage);
process.exit(2);
