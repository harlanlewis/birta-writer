/**
 * Same-session launch A/B orchestrator — the guard behind `pnpm perf:ab` and the
 * CI `launch-perf` job (one script so local and CI run byte-identical logic).
 *
 * It builds the PR's merge-base and the current HEAD into two dist dirs and runs
 * `e2e/perf.mjs --ab` to compare their cold-start launch time. Both builds are
 * measured back-to-back on the SAME machine, so the machine-load confound that
 * makes absolute launch ms untrustworthy cancels in the delta (see the header of
 * e2e/perf.mjs). That is what lets a browser-timing check be a blocking gate.
 *
 * Usage:
 *   node e2e/perf-ab.mjs                       # vs origin/main, 8 pairs/fixture
 *   node e2e/perf-ab.mjs --base origin/main --runs 9 --json ab.json
 *   PERF_ACCEPT="reason" node e2e/perf-ab.mjs  # accept an intended regression
 *
 * Requires the playwright devDependency + `npx playwright install chromium`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const baseRef = arg("--base", "origin/main");
const runs = arg("--runs", "9");
const jsonOut = arg("--json", null);

// The base bundle must be built from the merge-base with the same deps that
// commit shipped — otherwise a dependency bump in the PR would be attributed to
// the PR's own code. Resolve the merge-base; fall back to the ref itself.
let base;
try {
    base = git("merge-base", baseRef, "HEAD");
} catch {
    console.error(`could not resolve merge-base of ${baseRef} and HEAD — is ${baseRef} fetched? (CI: fetch-depth: 0)`);
    process.exit(2);
}
const head = git("rev-parse", "HEAD");
// The head bundle is built from the WORKING TREE, not the HEAD commit — locally
// that means uncommitted changes are measured (usually what you want), so say so.
const dirty = git("status", "--porcelain") !== "" ? " + working-tree changes" : "";
console.log(`launch A/B: base ${base.slice(0, 9)} (merge-base with ${baseRef}) vs head ${head.slice(0, 9)}${dirty}`);

const worktree = join(tmpdir(), `birta-perf-base-${process.pid}`);
const buildProd = (cwd) => execFileSync("node", ["esbuild.mjs", "--production"], { cwd, stdio: "inherit" });

try {
    // ── build base in an isolated worktree ──────────────────
    console.log(`\n▸ building base in a detached worktree…`);
    // Clear any worktree registration a previously-killed run left dangling
    // (the pid-keyed path avoids collisions, but the git registration leaks).
    git("worktree", "prune");
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
    git("worktree", "add", "--detach", worktree, base);

    // Reuse the root install when deps are unchanged vs the merge-base (the common
    // case — fast); otherwise install the base's own deps for a faithful build.
    // Key on the LOCKFILE only: the bundle is determined by installed deps, so a
    // package.json scripts/version edit must not force a slow base reinstall.
    const depsChanged = git("diff", "--name-only", base, "HEAD", "--", "pnpm-lock.yaml") !== "";
    if (depsChanged) {
        console.log("  deps differ from base — installing base deps…");
        execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, stdio: "inherit" });
    } else {
        symlinkSync(join(repoRoot, "node_modules"), join(worktree, "node_modules"), "dir");
    }
    buildProd(worktree);
    rmSync(join(repoRoot, "dist-base"), { recursive: true, force: true });
    cpSync(join(worktree, "dist"), join(repoRoot, "dist-base"), { recursive: true });

    // ── build head ──────────────────────────────────────────
    console.log(`\n▸ building head…`);
    buildProd(repoRoot);
    rmSync(join(repoRoot, "dist-head"), { recursive: true, force: true });
    cpSync(join(repoRoot, "dist"), join(repoRoot, "dist-head"), { recursive: true });
} finally {
    if (existsSync(worktree)) {
        try { git("worktree", "remove", "--force", worktree); }
        catch { rmSync(worktree, { recursive: true, force: true }); }
    }
}

// ── compare ─────────────────────────────────────────────────
const abArgs = ["e2e/perf.mjs", "--ab", "dist-base", "dist-head", "--runs", runs];
if (jsonOut) abArgs.push("--json", jsonOut);
const res = spawnSync("node", abArgs, { cwd: repoRoot, stdio: "inherit", env: process.env });
process.exit(res.status ?? 1);
