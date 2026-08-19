/**
 * Guard on the one mistake `.vscodeignore` cannot catch by itself.
 *
 * The file is a DENY-list, and it does not honor `.gitignore`. So a directory
 * that did not exist when the list was written is shipped to every extension
 * user by default, silently: `vsce package` succeeds, the extension works, and
 * the only symptom is an archive carrying source nobody can reach. That is how
 * Jot's SwiftPM tree and the pre-commit hook shipped (MAR-383).
 *
 * `scripts/check-vsix.mjs` catches the same class only once the archive crosses
 * a count ceiling, needs a production build to run, and reports "entry count
 * too high" rather than naming the directory. This test needs neither a build
 * nor a package: it enumerates the top-level directories git tracks and forces
 * every one of them to be a decision that somebody wrote down.
 *
 * Adding a top-level directory therefore fails here until you either deny it in
 * `.vscodeignore` or add it below with the reason it belongs in the archive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Top-level directories that ship on purpose. The value is why a reader of the
 * INSTALLED extension can reach it; anything that cannot be justified that way
 * belongs in `.vscodeignore` instead.
 */
const SHIPPED_ON_PURPOSE: Record<string, string> = {
    licenses:
        "Attribution travels with the distribution: Apache-2.0 section 4 requires the notices, and the MIT/ISC/BSD texts are discharged here because we ship a minified bundle that strips their headers.",
    l10n: "VS Code reads `l10n/bundle.l10n.json` from the installed extension for `vscode.l10n` strings.",
    media: "`media/icon.png` is the Marketplace tile named by package.json's `icon`, which scripts/check-vsix.mjs separately asserts is present.",
};

/** Top-level directories that git tracks at least one file under. */
function trackedTopLevelDirectories(): string[] {
    const files = execFileSync("git", ["ls-files"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
    }).split("\n");
    const dirs = new Set<string>();
    for (const file of files) {
        const slash = file.indexOf("/");
        if (slash > 0) dirs.add(file.slice(0, slash));
    }
    return [...dirs].sort();
}

/** Directory names denied wholesale, from a `<dir>/**` or a bare `<dir>` line. */
function deniedDirectories(): Set<string> {
    const lines = readFileSync(path.join(REPO_ROOT, ".vscodeignore"), "utf8").split("\n");
    const denied = new Set<string>();
    for (const raw of lines) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) continue;
        // A partial rule (`media/*.svg`, `dist/hostPalette.css`) denies files
        // inside a directory, never the directory, so it must NOT count here.
        const wholesale = line.endsWith("/**") ? line.slice(0, -3) : line;
        if (wholesale.includes("/") || wholesale.includes("*")) continue;
        denied.add(wholesale);
    }
    return denied;
}

describe("vscodeignore coverage", () => {
    const tracked = trackedTopLevelDirectories();
    const denied = deniedDirectories();

    // An enumeration that reached nothing passes every assertion below it, so
    // both instruments have to prove they read something real first.
    it("the instrument should reach the repository's real directories", () => {
        expect(tracked).toEqual(
            expect.arrayContaining(["src", "webview", "shared", "jot", "scripts"]),
        );
        expect(tracked.length).toBeGreaterThan(10);
        expect(denied.size).toBeGreaterThan(10);
        for (const name of ["src", "webview", "shared", "scripts", "e2e", "docs"]) {
            expect(denied.has(name)).toBe(true);
        }
    });

    it("every tracked top-level directory should be denied or justified", () => {
        const undecided = tracked.filter((dir) => !denied.has(dir) && !(dir in SHIPPED_ON_PURPOSE));
        expect(
            undecided,
            `These top-level directories would ship inside the VSIX. Deny each in .vscodeignore, or add it to SHIPPED_ON_PURPOSE in this file with the reason an installed extension can reach it:\n  ${undecided.join("\n  ")}`,
        ).toEqual([]);
    });

    it("a directory justified as shipped should not also be denied", () => {
        // A contradiction here means the archive does not contain what the
        // justification claims, and the justification is the thing people read.
        const contradictory = Object.keys(SHIPPED_ON_PURPOSE).filter((dir) => denied.has(dir));
        expect(contradictory).toEqual([]);
    });

    it("a directory justified as shipped should still exist", () => {
        // Otherwise the list accumulates reasons for directories that are gone,
        // and the next reader trusts a claim about an archive nobody checked.
        const missing = Object.keys(SHIPPED_ON_PURPOSE).filter((dir) => !tracked.includes(dir));
        expect(missing).toEqual([]);
    });
});
