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
const release = read(".github/workflows/release.yml");
const inApp = read("jot/Sources/BirtaJot/Updater.swift");
const requirements = read("jot/Sources/BirtaJotCore/SystemRequirements.swift");

/**
 * A source file with its comment-only lines removed.
 *
 * Every assertion below is about what a file DOES, and each of these files
 * carries a comment explaining the very thing being asserted. Searching the
 * raw text would let the explanation stand in for the check: delete the check,
 * keep the paragraph saying why it is there, and the guard is still green.
 */
function code(source: string, marker: string): string {
    return source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(marker))
        .join("\n");
}

/**
 * One workflow step's body, comments removed.
 *
 * Scoped to the step, because the earlier build step is full of `test -f`
 * lines and a guard that counted those would pass on somebody else's work.
 */
function workflowStep(name: string): string {
    const block = workflow.split(/^\s*- name: /m).find((part) => part.startsWith(name));
    return code(block ?? "", "#");
}

/**
 * The `runs-on` label one job declares, or undefined when the job is gone.
 *
 * A rename returns undefined rather than an empty string, so the assertion
 * below fails naming the job instead of comparing two absences and passing.
 */
function jobRunner(source: string, job: string): string | undefined {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`  ${job}:`));
    if (start === -1) { return undefined; }
    for (const line of lines.slice(start + 1)) {
        // The next job at the same indent ends this one's block.
        if (/^ {2}\S/.test(line)) { return undefined; }
        const runner = line.match(/^\s*runs-on:\s*(\S+)/);
        if (runner) { return runner[1]; }
    }
    return undefined;
}

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

/**
 * Every macOS version number the README names.
 *
 * Every one of them, rather than the ones spelled "macOS 14 or later": a
 * phrasing list is a list the next phrasing never joins, and the README said
 * the floor twice in two shapes before this matched only one of them. The
 * cost is that a sentence naming some other macOS version for some other
 * reason would fail here, which is a rewording rather than a wrong answer.
 */
const stated = [...readme.matchAll(/macOS \*{0,2}(\d+(?:\.\d+)*)\*{0,2}/g)].map((m) => m[1]!);

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
    it("the by-hand updater should check both axes before it replaces anything", () => {
        // Ordering is the whole guarantee. Every failure below the quit is
        // recoverable by design; a refusal that arrived after it would have
        // replaced a working app with one that will not open. Both axes are
        // held to it, because the architecture one is the case that actually
        // happens today and an ordering guard over the floor alone would not
        // have noticed it moving.
        const script = code(updater, "#");
        const floor = script.indexOf("LSMinimumSystemVersion");
        const architecture = script.indexOf("lipo -archs");
        const quit = script.indexOf("pkill -TERM");
        expect(floor, "update-jot.sh no longer reads the bundle's floor").toBeGreaterThan(-1);
        expect(architecture, "update-jot.sh no longer reads the bundle's architectures")
            .toBeGreaterThan(-1);
        expect(quit, "update-jot.sh no longer quits the running app").toBeGreaterThan(-1);
        expect(floor, "the floor check has to run before the app is quit").toBeLessThan(quit);
        expect(architecture, "the architecture check has to run before the app is quit")
            .toBeLessThan(quit);
    });

    it("the in-app updater should check compatibility before it arms the swap", () => {
        // The same ordering, held the same way, because the claim is that BOTH
        // paths preflight and a guard over one of them is a guard over half a
        // claim. `Updater` hands the swap to a script that runs once this
        // process is gone, so `swap.run()` is the point of no return: a
        // refusal after it has already replaced the copy somebody is using.
        // The check is private to one method with no seam to call, so the
        // source order is what there is to assert.
        const source = code(inApp, "//");
        const check = source.indexOf("SystemRequirements.refusal(");
        const armed = source.indexOf("swap.run()");
        expect(check, "Updater.swift no longer asks whether this Mac can run the download")
            .toBeGreaterThan(-1);
        expect(armed, "Updater.swift no longer arms the swap").toBeGreaterThan(-1);
        expect(check, "the compatibility check has to run before the swap is armed")
            .toBeLessThan(armed);
    });

    it("neither Swift side of the check should spell a floor of its own", () => {
        // The bundle being installed is what answers, so a release that raises
        // the floor is judged against its own number. A literal here would be
        // a fourth declaration, invisible to the three this file relates, and
        // wrong on exactly the day it mattered.
        const floor = manifestFloor()!.split(".")[0]!;
        for (const [name, source] of [
            ["SystemRequirements.swift", requirements],
            ["Updater.swift", inApp],
        ] as const) {
            expect(
                code(source, "//"),
                `${name} spells the macOS floor instead of reading it off the bundle`,
            ).not.toMatch(new RegExp(`macOS ${floor}\\b`));
        }
    });

    it("the by-hand updater should read the floor off the bundle rather than spell one", () => {
        // A fourth declaration would be one this file cannot see, and it would
        // be wrong on the day a release raises the floor: the question is
        // whether THIS Mac can run THAT download, so the download answers it.
        const floor = manifestFloor()!.split(".")[0]!;
        expect(
            code(updater, "#"),
            "update-jot.sh spells the macOS floor instead of reading it off the bundle",
        ).not.toMatch(new RegExp(`macOS ${floor}\\b`));
    });

    it("CI should assert what the built app runs on", () => {
        // The README's architecture claim is about an artifact, so the binary
        // is what has to be asked. Named here so the sentence and its only
        // check cannot drift apart silently.
        //
        // Asserted on the assertions, not on the words around them. Reading
        // `lipo -archs` into a variable and echoing it checks nothing, and the
        // step's own comment names `LSMinimumSystemVersion` while explaining
        // why the check is there, so a guard that searched the file for either
        // string would pass with both checks deleted and the comment left.
        const step = workflowStep("what the built app runs on");
        expect(step, "the workflow no longer asks the built app what it runs on").not.toBe("");
        const checks = step
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("test "));
        expect(step, "CI no longer reads the built binary's architectures").toContain("lipo -archs");
        expect(step, "CI no longer reads the built bundle's floor").toContain(
            "LSMinimumSystemVersion",
        );
        expect(
            checks.filter((line) => line.includes("arm64")).length,
            "CI reads the architectures but asserts nothing about them",
        ).toBeGreaterThan(0);
        expect(
            checks.length,
            "CI reads both facts but does not assert both of them",
        ).toBeGreaterThanOrEqual(2);
    });

    it("the job that asserts the architecture should build on the runner that publishes it", () => {
        // The README's Apple Silicon sentence is about the app attached to a
        // release, and the assertion above runs in `jot.yml`, which builds a
        // different app in a different workflow. That stands only while both
        // build on the same kind of machine, since neither passes `--arch` and
        // the runner is therefore what decides. Nothing else relates them: move
        // `jot-app` to an Intel runner and the published download changes
        // architecture while the guard on the claim keeps passing.
        const asserted = jobRunner(workflow, "jot-test");
        const published = jobRunner(release, "jot-app");
        expect(asserted, "jot.yml no longer declares a jot-test job with a runner").toBeDefined();
        expect(published, "release.yml no longer declares a jot-app job with a runner").toBeDefined();
        expect(
            published,
            `release.yml builds the published app on ${published} and jot.yml asserts its architecture on ${asserted}`,
        ).toBe(asserted);
    });
});
