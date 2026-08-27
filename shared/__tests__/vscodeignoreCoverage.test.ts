/**
 * Guard on the one mistake `.vscodeignore` cannot catch by itself.
 *
 * The file is a DENY-list, and it does not honor `.gitignore`. So a directory
 * that did not exist when the list was written is shipped to every extension
 * user by default, silently: `vsce package` succeeds, the extension works, and
 * the only symptom is an archive carrying source nobody can reach. That is how
 * the Mac app's SwiftPM tree and the pre-commit hook shipped (MAR-383).
 *
 * `scripts/check-vsix.mjs` catches the same class only once the archive crosses
 * a count ceiling, needs a production build to run, and reports "entry count
 * too high" rather than naming the directory. This test needs neither a build
 * nor a package: it enumerates the top-level directories git tracks and forces
 * every one of them to be a decision that somebody wrote down.
 *
 * Adding a top-level directory therefore fails here until you either deny it in
 * `.vscodeignore` or add it below with the reason it belongs in the archive.
 *
 * KNOWN BLIND SPOT, and the reason this does not replace `check-vsix.mjs`: the
 * population is what git TRACKS, so build output that is gitignored and still
 * packaged is invisible here. `dist/` is exactly that, and is why the archive's
 * other guard keeps a `banned` list of directory names rather than relying on
 * this one. A new gitignored directory is still that list's job.
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

/** The top-level directory a `.vscodeignore` line denies wholesale, or null. */
function wholesaleTarget(line: string): string | null {
    // A partial rule (`media/*.svg`, `dist/hostPalette.css`) denies files
    // inside a directory, never the directory, so it must NOT count.
    const target = line.endsWith("/**") ? line.slice(0, -3) : line;
    if (target === "" || target.includes("/") || target.includes("*")) return null;
    return target;
}

/**
 * Directory names denied wholesale, from a `<dir>/**` or a bare `<dir>` line.
 *
 * A bare line naming a FILE (`pnpm-workspace.yaml`, `esbuild.mjs`) lands in
 * this set too, because nothing here can tell a file from a directory by name
 * alone. Harmless: the set is only ever asked about directory names.
 *
 * `!` re-includes, and it has to be subtracted rather than ignored. Reading
 * `!mac/**` as a directory named `!mac` would leave the `mac/**` above it still
 * counted as denied, so this guard would pass while the directory shipped,
 * which is the exact failure it exists to catch.
 */
function deniedDirectories(text?: string): Set<string> {
    const source = text ?? readFileSync(path.join(REPO_ROOT, ".vscodeignore"), "utf8");
    const lines = source.split("\n");
    const denied = new Set<string>();
    for (const raw of lines) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) continue;
        if (line.startsWith("!")) {
            // A re-include of anything under a directory means the directory is
            // no longer wholly denied, so the whole subtree stops counting.
            const reincluded = line.slice(1).trim();
            const top = reincluded.split("/")[0];
            if (top !== "" && !top.includes("*")) denied.delete(top);
            continue;
        }
        const target = wholesaleTarget(line);
        if (target !== null) denied.add(target);
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
            expect.arrayContaining(["src", "webview", "shared", "mac", "scripts"]),
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

    it("a re-include should stop its directory counting as denied", () => {
        // The failure this rules out: reading `!mac/**` as a directory named
        // `!mac` leaves the `mac/**` above it counted, so the guard passes
        // while the directory ships. Each case below is a different way that
        // could go wrong, and the last two must NOT be treated as re-includes.
        expect(deniedDirectories("mac/**").has("mac")).toBe(true);
        expect(deniedDirectories("mac/**\n!mac/**").has("mac")).toBe(false);
        expect(deniedDirectories("mac/**\n!mac/Resources/**").has("mac")).toBe(false);
        expect(deniedDirectories("mac/**\n# !mac/**").has("mac")).toBe(true);
        expect(deniedDirectories("mac/**\nmedia/*.svg").has("media")).toBe(false);
    });

    it("a directory justified as shipped should still exist", () => {
        // Otherwise the list accumulates reasons for directories that are gone,
        // and the next reader trusts a claim about an archive nobody checked.
        const missing = Object.keys(SHIPPED_ON_PURPOSE).filter((dir) => !tracked.includes(dir));
        expect(missing).toEqual([]);
    });
});
