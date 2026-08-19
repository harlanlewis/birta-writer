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
import { readFileSync, readdirSync, statSync } from "node:fs";
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
    /^extension\/(\.vscode-test|\.vscode-test-web|\.e2e-shots|dist-base|dist-head|releases|node_modules|coverage|out|packages)\//;
const offenders = entries.filter((name) => banned.test(name));

// Headroom over a clean package, so legitimate growth passes and a leaked
// directory of any size trips this long before the archive doubles. Read the
// current count off the `check-vsix: OK` line rather than trusting a figure
// written here, which goes stale on the next feature that adds an asset.
//
// Naming the directory beats tripping only on the count: `dist-base`/`dist-head`
// (left behind by `pnpm perf:ab`) failed this as a bare "entry count 318 exceeds
// 200", which says nothing about WHICH directory leaked. They are in `banned`
// above so the next occurrence reports itself.
//
// This number caught `jot/**` in 2026-08, which had shipped since the
// directory arrived because `.vscodeignore` never gained a line for it. The
// first instinct was to raise the ceiling to fit the growth; the count was
// right and the growth was not. Raise this only once the entries above it
// have been listed and each directory in them has a reason to be there:
// "nothing on the banned list leaked" is a different question from "every
// directory here belongs", and only the second one justifies a higher number.
const MAX_FILES = 200;

// The Marketplace tile. `.vscodeignore` is a deny-list, so the icon ships by
// default and the failure mode is silent in the other direction: a broad new
// ignore pattern drops it, `vsce package` still succeeds, and the listing falls
// back to a gray placeholder that nobody sees until it is published. Read the
// path out of package.json rather than hardcoding it, so moving the file cannot
// leave this checking a stale name.
const { icon } = JSON.parse(readFileSync("package.json", "utf8"));

const problems = [];
if (icon && !entries.includes(`extension/${icon}`)) {
    problems.push(`package.json "icon" is ${icon}, but extension/${icon} is not in the VSIX`);
}
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
