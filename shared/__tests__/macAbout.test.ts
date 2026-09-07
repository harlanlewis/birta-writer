/**
 * Drift guard for what the Mac app's About window points at.
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
 * The copyright and the two menu rows are checked here for the shape AGENTS.md
 * calls a guard that is ABSENT rather than wrong. The window draws the
 * copyright only when the bundle carries one, so a plist that stopped
 * declaring it would ship a window with a line missing; and nothing in the
 * Swift suite constructs an `AppDelegate`, so the rows that open the window
 * are the one part of this feature no XCTest can reach.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const about = readFileSync(join(REPO, "mac/Sources/BirtaWriterCore/AboutInfo.swift"), "utf8");
const updater = readFileSync(join(REPO, "mac/Sources/BirtaWriter/Updater.swift"), "utf8");
const app = readFileSync(join(REPO, "mac/Sources/BirtaWriter/App.swift"), "utf8");
const appMenu = readFileSync(join(REPO, "mac/Sources/BirtaWriter/AppMenu.swift"), "utf8");
const plist = readFileSync(join(REPO, "mac/Resources/Info.plist"), "utf8");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

/** A `static let <name> = "value"` in the Swift, or a failure that says which. */
function swiftConstant(name: string): string {
    const value = about.match(new RegExp(`static let ${name}\\s*=\\s*"([^"]*)"`))?.[1];
    if (value === undefined) {
        throw new Error(`AboutInfo.swift no longer declares ${name} as a string literal`);
    }
    return value;
}

/**
 * One Swift function's body, brace-matched from its signature.
 *
 * A rename is a thrown error naming the function rather than an empty string
 * quietly satisfying every assertion made about it.
 */
function swiftFunctionBody(source: string, name: string): string {
    const signature = source.indexOf(`func ${name}(`);
    if (signature === -1) {
        throw new Error(`no Swift source read here declares ${name}`);
    }
    const open = source.indexOf("{", signature);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        if (source[i] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    throw new Error(`${name} has no closing brace`);
}

/** The `<string>` a plist key carries, or undefined when the key is absent. */
function plistString(key: string): string | undefined {
    return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

describe("the Mac app's About window", () => {
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

    it("should leave the updater with no unstamped-version string of its own", () => {
        // The same shape as the repository above, and the same failure. Both
        // sides read the sentinel a build carries until the release job stamps
        // a real version over it: the About window decides on it whether to
        // say a number or "Development build", and `Updater` compares every
        // published release against it. Two literals are free to drift, and
        // the day one moved the window would name a version the updater did
        // not recognise as unstamped.
        expect(updater).toContain("AboutInfo.unstampedVersion");
        expect(updater).not.toContain(`"${swiftConstant("unstampedVersion")}"`);
    });

    it("should link to an https website", () => {
        expect(new URL(swiftConstant("website")).protocol).toBe("https:");
    });

    it("should be reachable from the app menu and from the menu-bar item's menu", () => {
        // An accessory app's app menu is invisible, so the status-menu row is
        // the route most installs actually have: lose it and there is no way to
        // the window at all.
        //
        // Both menus draw ONE section, built by `AppMenu.addAppSection`, so
        // this reads the row where it is written and then reads that both
        // builders ask for it. `AppMenuTests` reads the two built menus back
        // and holds their rows equal; this is the half of that pair CI runs,
        // because the Swift suite is `mac/scripts/test.sh` and no workflow
        // calls it.
        //
        // FOLLOW THE NAME. `buildStatusMenu` and not `buildStatusItem`: the
        // menu-bar ITEM comes and goes with a setting while the menu it shows
        // is built once. `mainMenu` and not `buildMainMenu`: the bar's
        // construction moved out of the installer so a test could read it back
        // without assigning `NSApp.windowsMenu`, and this check followed it
        // rather than being weakened. A guard that names a function is a guard
        // a rename empties, with nothing to say it is reading no rows.
        const section = swiftFunctionBody(appMenu, "addAppSection");
        expect(section).toContain("#selector(AppDelegate.menuOpenAbout)");
        expect(section).toContain('addItem(withTitle: "About ');
        for (const builder of ["mainMenu", "buildStatusMenu"]) {
            expect(swiftFunctionBody(app, builder), builder).toContain("AppMenu.addAppSection(");
        }
    });

    it("should offer the update check from the menu-bar item's menu as well", () => {
        // With no Dock icon this menu is the only one most installs ever open,
        // and an update they cannot ask for is an update they wait a day for.
        //
        // The row is the table's, and the section adds the table's rows to
        // whichever menu it is building, which is what puts one row on both
        // surfaces rather than a copy on each.
        expect(appMenu).toContain("#selector(AppDelegate.menuCheckForUpdates)");
        expect(swiftFunctionBody(appMenu, "addAppSection")).toContain("add(.app, to: nsMenu");
    });

    it("should have a copyright in the bundle to draw", () => {
        const copyright = plistString("NSHumanReadableCopyright");
        expect(copyright).toBeDefined();
        expect(copyright).toContain("©");
        expect(copyright!.length).toBeGreaterThan(0);
    });
});
