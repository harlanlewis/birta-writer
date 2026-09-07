/**
 * One place writes a sentence about a version, so every surface says it alike.
 *
 * `UpdatePolicy.plain` strips the tag's leading `v`, because the tag carries
 * one by release convention and nothing a reader sees does: the bundle's
 * `CFBundleShortVersionString` has none, so the About window has none. The
 * spelling only holds if every sentence goes through that function, and it is
 * private precisely so no caller can hand in its own.
 *
 * That protects the sentences INSIDE `UpdatePolicy`, and `UpdatePolicyTests`
 * sweeps those for the `v`. What neither can see is a sentence written
 * somewhere else. Two were: `Updater` spelled its own "Downloading …" and
 * "Installing …" status lines from the raw tag, on the same status line
 * `installOnQuitNotice` writes to. Install on Next Launch runs the first and
 * then the third back to back, so the panel read "Downloading v2026.905.0…"
 * and then "2026.905.0 goes in after you next quit": one version, two
 * spellings, seconds apart, in one place. Both were found by reading rather
 * than by a run, and the Swift sweep passed the whole time, because the
 * strings it sweeps were never the ones that were wrong.
 *
 * So this asks the question the sweep cannot: does any Swift source outside
 * `UpdatePolicy` interpolate a version into a user-facing string? It lives in
 * TypeScript for the same reason `macAbout.test.ts` does, which is that a
 * check over Swift SOURCE has no home in XCTest, and the repository already
 * reads Swift from here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SOURCES = join(REPO, "mac/Sources");

/** The one file allowed to spell a version, and the one that strips the `v`. */
const AUTHORITY = "UpdatePolicy.swift";

/**
 * The one file that writes a version sentence and is not `UpdatePolicy`.
 *
 * `AboutInfo`'s "Version 2026.905.0" reads `CFBundleShortVersionString`, which
 * never carries a `v` because nothing puts one there, so this is not an
 * exception to the spelling: it is the surface every other one is being held
 * TO. Routing it through `UpdatePolicy` would make the About window depend on
 * the updater to say what build it is, which is backwards.
 *
 * One entry, and it is one on purpose. The list started with three, and the
 * other two were exemptions for files that never tripped the check: an
 * exemption nothing needs is a file quietly outside the sweep, which is the
 * shape that lets the next sentence land there unseen. Anything added here
 * says why, and is verified to be needed by taking it out and watching this
 * go red.
 */
const NOT_SENTENCES = new Set(["AboutInfo.swift"]);

/** Every `.swift` under mac/Sources, with its path relative to that root. */
function swiftFiles(dir: string, prefix = ""): { name: string; path: string; text: string }[] {
    const out: { name: string; path: string; text: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const here = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...swiftFiles(here, join(prefix, entry.name)));
        } else if (entry.name.endsWith(".swift")) {
            out.push({ name: entry.name, path: join(prefix, entry.name), text: readFileSync(here, "utf8") });
        }
    }
    return out;
}

/**
 * A RELEASE version interpolated into a string literal, on one line.
 *
 * The names are matched whole, and the two things that forced that are both
 * real lines in this tree rather than hypotheticals: a looser pattern read
 * `\(os.majorVersion)` in the macOS version string as an app version, and read
 * the `tags=\(tags.count)` of a measurement line as a release tag. Both are
 * kept below as negative cases, because a pattern this check cannot be shown
 * to discriminate is a check that passes on an empty match set and tells
 * nobody.
 */
const SPELLS_A_VERSION = /"[^"\n]*\\\([^)\n]*\b(?:tag|version|currentVersion)\b[^)\n]*\)[^"\n]*"/;

describe("the Mac app's version spelling", () => {
    const files = swiftFiles(SOURCES);

    it("should have found the Swift sources at all", () => {
        // An enumeration that reached nothing passes every check below by
        // saying nothing, so the sweep asserts its own reach before its
        // verdict. The floor is deliberately far under the real count: what
        // it rules out is an empty walk, not a file added or removed.
        expect(files.length).toBeGreaterThan(40);
        expect(files.map((f) => f.name)).toContain(AUTHORITY);
    });

    it("should write every sentence naming a version in UpdatePolicy alone", () => {
        const offenders: string[] = [];
        for (const file of files) {
            if (file.name === AUTHORITY || NOT_SENTENCES.has(file.name)) continue;
            for (const [index, line] of file.text.split("\n").entries()) {
                // Comments quote these sentences to explain them, which is the
                // documentation working rather than a second copy of the bug.
                if (line.trim().startsWith("///") || line.trim().startsWith("//")) continue;
                if (SPELLS_A_VERSION.test(line)) {
                    offenders.push(`${file.path}:${index + 1}: ${line.trim()}`);
                }
            }
        }
        expect(offenders, `these spell a version outside ${AUTHORITY}, so nothing holds them to the `
            + `spelling every other surface uses; give the sentence a function there instead`)
            .toEqual([]);
    });

    it("should still catch a sentence written outside UpdatePolicy", () => {
        // The arm that proves the pattern discriminates. Without it the check
        // above passes just as well with a regex that matches nothing, which
        // is the shape it is easiest to ship by accident: an empty offender
        // list reads as good news either way.
        expect(SPELLS_A_VERSION.test('say("Downloading \\(release.tag)…")')).toBe(true);
        expect(SPELLS_A_VERSION.test('onStatus?("Installing \\(staged.tag)…")')).toBe(true);
        // And that it is not simply matching every interpolation it sees. The
        // middle two are the lines an earlier pattern here actually caught,
        // kept because a version of this check that reads the macOS version
        // as a release would be abandoned rather than fixed.
        expect(SPELLS_A_VERSION.test('say("Could not reach \\(host).")')).toBe(false);
        expect(SPELLS_A_VERSION.test('systemVersion: "macOS \\(os.majorVersion).\\(os.minorVersion)",')).toBe(false);
        expect(SPELLS_A_VERSION.test('+ " rows=\\(wherePopUp.numberOfItems) tags=\\(tags.count)"')).toBe(false);
        expect(SPELLS_A_VERSION.test("let tag = release.tag")).toBe(false);
    });
});
