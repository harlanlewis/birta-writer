/**
 * Drift guard for what Birta Writer Jot's About window points at.
 *
 * The window names one repository twice, for source and for bug reports, and
 * `Updater` polls that same repository for releases. Swift cannot read
 * package.json at runtime, so the string lives in `AboutInfo.swift` and nothing
 * but this relates it to the manifest the extension publishes from.
 *
 * The drift is silent in both directions a repository move can take it. Every
 * URL here still resolves, GitHub still renders an issues page, and an app that
 * fetched updates from one repository while filing issues against another would
 * look correct from every screen it draws.
 *
 * The copyright is checked here for the shape AGENTS.md calls a guard that is
 * ABSENT rather than wrong: the window draws the line only when the bundle
 * carries one, so a plist that stopped declaring it would ship a window with a
 * line missing, and every Swift test would still pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const about = readFileSync(join(REPO, "jot/Sources/BirtaJotCore/AboutInfo.swift"), "utf8");
const updater = readFileSync(join(REPO, "jot/Sources/BirtaJot/Updater.swift"), "utf8");
const plist = readFileSync(join(REPO, "jot/Resources/Info.plist"), "utf8");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

/** A `static let <name> = "value"` in the Swift, or a failure that says which. */
function swiftConstant(name: string): string {
    const value = about.match(new RegExp(`static let ${name}\\s*=\\s*"([^"]*)"`))?.[1];
    if (value === undefined) {
        throw new Error(`AboutInfo.swift no longer declares ${name} as a string literal`);
    }
    return value;
}

/** The `<string>` a plist key carries, or undefined when the key is absent. */
function plistString(key: string): string | undefined {
    return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

describe("Jot's About window", () => {
    it("should name the repository package.json publishes from", () => {
        const repository: string = pkg.repository.url.replace(/\.git$/, "");
        expect(`https://github.com/${swiftConstant("repository")}`).toBe(repository);
    });

    it("should send bug reports to package.json's issues page", () => {
        // AboutLink.issues is the source link plus /issues, which
        // AboutInfoTests holds; this is the other end of that derivation.
        expect(`https://github.com/${swiftConstant("repository")}/issues`).toBe(pkg.bugs.url);
    });

    it("should leave the updater with no repository string of its own", () => {
        // A second literal would be free to drift from the first, and the app
        // would update from one repository and file issues against another.
        expect(updater).toContain("AboutInfo.repository");
        expect(updater).not.toContain(`"${swiftConstant("repository")}"`);
    });

    it("should link to an https website", () => {
        expect(new URL(swiftConstant("website")).protocol).toBe("https:");
    });

    it("should have a copyright in the bundle to draw", () => {
        const copyright = plistString("NSHumanReadableCopyright");
        expect(copyright).toBeDefined();
        expect(copyright).toContain("©");
        expect(copyright!.length).toBeGreaterThan(0);
    });
});
