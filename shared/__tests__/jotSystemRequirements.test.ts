/**
 * Guard for Jot's macOS floor: the three places that state it agree.
 *
 * The extension has this already, one layer up. `engines.vscode` is the floor
 * VS Code enforces, `@types/vscode` pinned to it is what stops the compiler
 * blessing an API that floor does not have, and
 * `docsSettingsContributions.test.ts` holds the prose in both user-facing
 * documents to the same number. Jot's version of that pair is
 * `Info.plist`'s `LSMinimumSystemVersion`, which macOS checks before launching
 * the app, and `Package.swift`'s `platforms: [.macOS(.v14)]`, which is what
 * makes the claim true: SwiftPM compiles every target against that floor, so
 * an API that arrived later is a build error rather than a crash on the oldest
 * Mac we say we support. `jot/README.md` is the third, and it is the only one
 * a person reads.
 *
 * The drift fails in both directions and neither is visible from the other
 * side. A `Package.swift` raised without the plist ships an app macOS launches
 * on a system it cannot run on, which is a crash at startup with no
 * explanation. A plist raised without `Package.swift` refuses machines the
 * build would have suited. Nothing but this relates the two, because neither
 * Swift nor a property list can import the other, and the same argument
 * `appFlavor.test.ts` opens with applies here: the citation reads as coverage
 * long before anything is checking it.
 *
 * The README claim about the ARCHITECTURE is deliberately not asserted here.
 * It is a fact about the built artifact rather than about a file, so
 * `.github/workflows/jot.yml` asks the binary itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const manifest = read("jot/Package.swift");
const plist = read("jot/Resources/Info.plist");
const readme = read("jot/README.md");
const updater = read("jot/scripts/update-jot.sh");
const workflow = read(".github/workflows/jot.yml");

/**
 * The floor SwiftPM compiles against, from `platforms: [.macOS(.v14)]`.
 *
 * SwiftPM spells a major-only floor `.v14` and a point release `.v14_4`, so
 * the underscore is the decimal point. Returned as a dotted version, which is
 * what the other two files spell.
 */
function manifestFloor(): string | undefined {
    const raw = manifest.match(/\.macOS\(\.v(\d+)(?:_(\d+))?\)/);
    if (!raw) { return undefined; }
    return raw[2] ? `${raw[1]}.${raw[2]}` : `${raw[1]}.0`;
}

/** The `LSMinimumSystemVersion` string an Info.plist declares. */
function plistFloor(): string | undefined {
    return plist.match(
        /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
}

/** Every "macOS <version> or later" the README states. */
const stated = [...readme.matchAll(/macOS \*{0,2}(\d+(?:\.\d+)*)\*{0,2} or later/g)].map(
    (m) => m[1]!,
);

/** Two floors compared as numbers, with a missing component reading as zero. */
function sameVersion(a: string, b: string): boolean {
    const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const [left, right] = [parts(a), parts(b)];
    const width = Math.max(left.length, right.length);
    for (let i = 0; i < width; i++) {
        if ((left[i] ?? 0) !== (right[i] ?? 0)) { return false; }
    }
    return true;
}

describe("Jot's macOS floor", () => {
    it("Package.swift should declare a platform floor", () => {
        expect(
            manifestFloor(),
            "jot/Package.swift no longer declares platforms: [.macOS(...)]",
        ).toBeDefined();
    });

    it("Info.plist should declare LSMinimumSystemVersion", () => {
        // Absent, macOS launches the app on anything and the failure lands as
        // a startup crash on the oldest Mac rather than as a refusal.
        expect(
            plistFloor(),
            "jot/Resources/Info.plist no longer declares LSMinimumSystemVersion",
        ).toBeDefined();
    });

    it("the floor macOS enforces should be the floor the build compiles against", () => {
        const compiled = manifestFloor()!;
        const enforced = plistFloor()!;
        expect(
            sameVersion(compiled, enforced),
            `Package.swift compiles against macOS ${compiled} and Info.plist declares ${enforced}`,
        ).toBe(true);
    });

    it("the README should state a minimum macOS version", () => {
        // A floor is a fact somebody has to be able to look up, and the README
        // is the only one of the three a person reads. This is the assertion
        // that would otherwise be absent rather than wrong: the prose can be
        // deleted or reworded and every other check here still passes.
        expect(stated.length, "jot/README.md states no macOS minimum").toBeGreaterThan(0);
    });

    for (const [index, version] of stated.entries()) {
        it(`the README's stated minimum #${index + 1} should match the declared floor`, () => {
            const compiled = manifestFloor()!;
            expect(
                sameVersion(version, compiled),
                `jot/README.md advertises macOS ${version}, the build requires ${compiled}`,
            ).toBe(true);
        });
    }
});

describe("what the update paths refuse", () => {
    it("the by-hand updater should check the floor before it replaces anything", () => {
        // Ordering is the whole guarantee. Every failure below the quit is
        // recoverable by design; a refusal that arrived after it would have
        // replaced a working app with one that will not open.
        const check = updater.indexOf("LSMinimumSystemVersion");
        const quit = updater.indexOf("pkill -TERM");
        expect(check, "update-jot.sh no longer reads the bundle's floor").toBeGreaterThan(-1);
        expect(quit, "update-jot.sh no longer quits the running app").toBeGreaterThan(-1);
        expect(check, "the compatibility check has to run before the app is quit")
            .toBeLessThan(quit);
    });

    it("the by-hand updater should read the floor off the bundle rather than spell one", () => {
        // A fourth declaration would be one this file cannot see, and it would
        // be wrong on the day a release raises the floor: the question is
        // whether THIS Mac can run THAT download, so the download answers it.
        const floor = manifestFloor()!.split(".")[0]!;
        const script = updater
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .join("\n");
        expect(script).not.toMatch(new RegExp(`macOS ${floor}\\b`));
    });

    it("CI should assert what the built app runs on", () => {
        // The README's architecture claim is about an artifact, so the binary
        // is what has to be asked. Named here so the sentence and its only
        // check cannot drift apart silently.
        expect(workflow).toContain("lipo -archs");
        expect(workflow).toContain("LSMinimumSystemVersion");
    });
});
