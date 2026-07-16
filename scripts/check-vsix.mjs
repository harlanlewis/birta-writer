#!/usr/bin/env node
// Packaging tripwire (MAR-159): fail the package step if the VSIX picked up
// development artifacts or ballooned.
//
// .vscodeignore is a deny-list that does NOT honor .gitignore, so a newly
// gitignored directory ships in the VSIX silently unless someone remembers to
// add it there too (that is exactly how .e2e-shots/ leaked in). This check
// makes the mistake loud at package time instead of install time.
//
// Usage: node scripts/check-vsix.mjs [path/to.vsix]
// With no argument it checks the newest .vsix in releases/ — locally that is
// always birta-writer-0.0.0.vsix; in the CI Release job it is the
// version-stamped artifact `pnpm run package` just wrote.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function newestVsix() {
    const candidates = readdirSync("releases")
        .filter((name) => name.endsWith(".vsix"))
        .map((name) => join("releases", name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length === 0) {
        console.error("check-vsix: no .vsix found in releases/");
        process.exit(1);
    }
    return candidates[0];
}

const vsix = process.argv[2] ?? newestVsix();
const listing = execFileSync("unzip", ["-l", vsix], { encoding: "utf8" });
// unzip -l data rows: "  <size>  <date> <time>   <name>"
const entries = listing
    .split("\n")
    .map((line) => line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/)?.[1])
    .filter((name) => name && name !== "-------" && !name.endsWith("/"));

// Development directories that must never ship. vsce's defaultIgnore already
// covers some (.vscode-test, node_modules); listing them anyway means an
// upstream default change can't silently regress us.
const banned =
    /^extension\/(\.vscode-test|\.vscode-test-web|\.e2e-shots|releases|node_modules|coverage|out|packages)\//;
const offenders = entries.filter((name) => banned.test(name));

// A clean package is 96 files (2026-07). Headroom for legitimate growth;
// a leaked directory of any size trips this long before it doubles.
const MAX_FILES = 200;

const problems = [];
if (offenders.length > 0) {
    problems.push(`development artifacts in the VSIX:\n  ${offenders.join("\n  ")}`);
}
if (entries.length > MAX_FILES) {
    problems.push(
        `entry count ${entries.length} exceeds ${MAX_FILES} — if this growth is intentional, raise MAX_FILES here`,
    );
}

if (problems.length > 0) {
    console.error(`check-vsix: FAILED for ${vsix}\n${problems.join("\n")}`);
    process.exit(1);
}
console.log(`check-vsix: OK — ${entries.length} files, no development artifacts.`);
