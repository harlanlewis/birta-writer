/**
 * Guard for the distribution seam in Birta Writer for Mac: the channel a build
 * arrived by (`BirtaWriterCore.Distribution`), read off the App Sandbox, and
 * the four things the store's sandbox takes away.
 *
 * The rule itself is pure and `DistributionTests` covers it over its whole
 * space. What no Swift test can reach is the WIRING, and this seam is the
 * shape AGENTS.md names as a guard that can be ABSENT rather than wrong: a
 * fact nobody reads is a seam with no consumer, and a consumer that reads the
 * flavour alone where it should read the conjunction is a store build that
 * offers to replace itself. Both pass every green run.
 *
 * This reads the Swift as text, the way `appFlavor.test.ts` and
 * `firstRunGates.test.ts` do, because that is what the things being related
 * have in common: a sandboxed process and a `swift test` process are never the
 * same process, so the store arm of every site below is unreachable under the
 * Swift suite and only the text can say whether it is wired at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SOURCES = join(REPO, "mac", "Sources");
const APP_TARGET = join(SOURCES, "BirtaWriter");

/** Every `.swift` file under `dir`, as repo-relative path and contents. */
function swiftSources(dir: string): { path: string; source: string }[] {
    const found: { path: string; source: string }[] = [];
    const walk = (at: string) => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const full = join(at, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith(".swift")) {
                found.push({ path: full.slice(REPO.length + 1), source: readFileSync(full, "utf8") });
            }
        }
    };
    walk(dir);
    return found;
}

const all = swiftSources(SOURCES);
const app = swiftSources(APP_TARGET);
const seam = readFileSync(join(SOURCES, "BirtaWriterCore", "Distribution.swift"), "utf8");

/** The files whose source matches `re`, by path. */
const readers = (files: typeof all, re: RegExp): string[] =>
    files.filter((f) => re.test(f.source)).map((f) => f.path).sort();

describe("the distribution seam", () => {
    it("the sweep should have reached the tree, or every absence below is decoration", () => {
        // The app target alone is dozens of files; a walk that found fewer
        // than this has the wrong directory and would pass every "no file
        // reads X" assertion for the wrong reason.
        expect(all.length).toBeGreaterThan(100);
        expect(app.length).toBeGreaterThan(30);
    });

    it("the sandbox should be read off the variable macOS actually sets", () => {
        // A typo here is a store build that never learns it is one, and
        // offers four things the sandbox then refuses. Held as the exact
        // declaration so the constant stays a constant rather than becoming
        // an expression this cannot read.
        expect(seam).toContain('public static let sandboxContainerVariable = "APP_SANDBOX_CONTAINER_ID"');
        expect(seam).toContain("environment[sandboxContainerVariable] != nil");
    });

    it("the app target should read whether a build updates itself through the resolver alone", () => {
        // The flavour's answer is half of the question, and a site that reads
        // it alone is a store build that offers to replace itself. Core keeps
        // the two operands (`AppFlavor.updatesItself`, the resolver that
        // conjoins them, and `RowAvailability`'s own arm) and the app target
        // reads only the conjunction.
        const direct = readers(app, /(AppFlavor\.current|flavour)\.updatesItself\b/);
        expect(direct, "reads the flavour's answer alone").toEqual([]);
        const viaResolver = readers(app, /\.updatesItself\(flavour:/);
        // The two gates the seam's header names, at least.
        expect(viaResolver).toContain("mac/Sources/BirtaWriter/Updater.swift");
        expect(viaResolver).toContain("mac/Sources/BirtaWriter/App.swift");
    });

    it("every fact the channel decides should have a reader outside the seam", () => {
        const outsideSeam = all.filter((f) => !f.path.endsWith("Distribution.swift"));
        const facts: Record<string, RegExp> = {
            offersAgent: /\.offersAgent\b/,
            offersTerminalCommand: /\.offersTerminalCommand\b/,
            readsInstalledEditorThemes: /\.readsInstalledEditorThemes\b/,
            "updatesItself(flavour:)": /\.updatesItself\(flavour:/,
        };
        for (const [fact, re] of Object.entries(facts)) {
            expect(readers(outsideSeam, re), `${fact} has no consumer`).not.toEqual([]);
        }
        // And the seam declares each of them, so the regexes above are
        // matching the real names and not a near miss.
        for (const fact of ["offersAgent", "offersTerminalCommand", "readsInstalledEditorThemes"]) {
            expect(seam).toContain(`public var ${fact}: Bool`);
        }
        expect(seam).toContain("public func updatesItself(flavour: AppFlavor) -> Bool");
    });

    it("the agent capability should be withdrawn through the one availability the row also reads", () => {
        // `Prefs.bootConfig` filters `agent` by `agentAvailable`, and that is
        // the only route by which the channel reaches the page. A channel read
        // anywhere else would be a second reader of the fact, which is what
        // the host-profile rules forbid, and a channel read nowhere here is a
        // store build whose page still offers `/ai`.
        const prefs = readFileSync(join(APP_TARGET, "Preferences.swift"), "utf8");
        const getter = /static var agentAvailable: Bool \{([\s\S]*?)\n    \}/.exec(prefs);
        expect(getter, "Prefs.agentAvailable moved; fix the anchor").not.toBeNull();
        expect(getter![1]).toContain("distribution: Distribution.current");
    });

    it("the settings window should take the channel the way it takes the flavour", () => {
        // The window's own header says why: a `static let` read at the point
        // of use is the test process's, so every store arm would be
        // unreachable under `swift test`. The one production caller passes
        // `.current` explicitly, and so must every test caller.
        const window = readFileSync(join(APP_TARGET, "SettingsWindow.swift"), "utf8");
        expect(window).toContain("let distribution: Distribution");
        expect(window).toMatch(/init\(flavour: AppFlavor,\s*\n\s*distribution: Distribution,/);
        const appSwift = readFileSync(join(APP_TARGET, "App.swift"), "utf8");
        expect(appSwift).toMatch(/flavour: \.current,\s*\n\s*distribution: \.current,/);
    });

    it("every construction of the two windows, tests included, should pass the channel", () => {
        // The parameter is required, so a caller that omits it fails to
        // compile; but the compile runs on the macOS job and this runs on
        // every platform. The first push of this seam left ten test callers
        // without it, because the rewrite was fed a hand-made file list, so
        // the count here comes from the tree and never from a list.
        const tests = swiftSources(join(REPO, "mac", "Tests"));
        const ctor = /(?:SettingsWindowController\(|WelcomeView\()\s*flavour: (?:\.\w+|flavour),/g;
        let seen = 0;
        const missing: string[] = [];
        for (const f of [...app, ...tests]) {
            for (const m of f.source.matchAll(ctor)) {
                seen += 1;
                const call = f.source.slice(m.index!, m.index! + 200);
                if (!/distribution: (\.current|\.direct|\.appStore|distribution)/.test(call)) {
                    missing.push(`${f.path}:${f.source.slice(0, m.index!).split("\n").length}`);
                }
            }
        }
        expect(seen, "the sweep found no constructions; fix the pattern").toBeGreaterThan(20);
        expect(missing).toEqual([]);
    });

    it("the first-run screen should take the channel too, since it draws the same update row", () => {
        // The miss this guard caught on its first run: Settings was wired and
        // the welcome screen, which draws the same row from the same rule,
        // still read the flavour alone. Both are held the same way now.
        const welcome = readFileSync(join(APP_TARGET, "WelcomeView.swift"), "utf8");
        expect(welcome).toContain("let distribution: Distribution");
        expect(welcome).toMatch(/init\(flavour: AppFlavor,\s*\n\s*distribution: Distribution,/);
        const coordinator = readFileSync(join(APP_TARGET, "Coordinator.swift"), "utf8");
        expect(coordinator).toMatch(/WelcomeView\(flavour: \.current,\s*\n\s*distribution: \.current,/);
    });
});
