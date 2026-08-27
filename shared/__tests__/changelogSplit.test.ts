/**
 * The two changelogs are split by PRODUCT, and stay that way.
 *
 * `CHANGELOG.md` ships inside the VSIX and is what the VS Code Marketplace and
 * Open VSX render on their Changelog tabs. The Mac app is installable from
 * neither: it is an app attached to a GitHub Release. So an app entry in the
 * extension's changelog reaches an audience that cannot act on it, which is
 * the bar AGENTS.md sets for an entry earning its place. Before the split, 34
 * of the 40 entries in one release were about the app.
 *
 * This file is exempt from the retired-codename guard in
 * `noLegacyBrand.test.ts`, because it parses shipped history and must
 * recognize the spelling history used.
 *
 * `mac/CHANGELOG.md` is kept out of the VSIX by `.vscodeignore`'s `mac/**`, so
 * the split costs no new packaging rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const extension = read("CHANGELOG.md");
const app = read("mac/CHANGELOG.md");

const versions = (text: string): string[] =>
    [...text.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]!);

/** Top-level bullets, each joined with the lines that continue it. */
const entries = (text: string): string[] => {
    const out: string[] = [];
    for (const line of text.split("\n")) {
        if (line.startsWith("- ")) { out.push(line.slice(2)); }
        else if (out.length && line.trim() && !line.startsWith("#")) { out[out.length - 1] += ` ${line.trim()}`; }
    }
    return out;
};

/**
 * An entry written as an APP entry: the subject opens the sentence, after at
 * most one of the prefixes the convention allows.
 *
 * Two spellings, because the app's name changed under this guard and both have
 * to stay matched. `Jot` is what every entry already in `mac/CHANGELOG.md`
 * opens with and is the shape a misfile would still take from an older draft;
 * `for Mac` is the shape the convention now asks for, and it exists BECAUSE of
 * the rename. Both surfaces are called Birta Writer, so a bare "Birta Writer"
 * opening no longer says which product an entry is about and cannot be matched
 * here without firing on most of the editor's own entries. The disambiguator
 * moved from the product name into the convention, and this pattern is the
 * only thing holding that convention up.
 *
 * Deliberately narrow: it catches the way app entries are actually written
 * without firing on an editor entry that mentions the app in passing, which is
 * legitimate and exists. It cannot catch an app entry phrased to avoid the
 * opening, so it is a floor rather than a proof, and the test below is what
 * says how high the floor actually is.
 */
const MISFILE = /^(Breaking, in |Breaking: |In )?Birta (Writer )?(Jot|for Mac)\b/;

describe("the changelog split", () => {
    it("every version in the app's changelog should exist in the extension's", () => {
        // One release stamps both, so the app can never carry a version the
        // extension has never heard of. The reverse is expected and fine: most
        // releases change nothing about the app.
        const all = new Set(versions(extension));
        const orphans = versions(app).filter((v) => !all.has(v));
        expect(orphans, `versions only in mac/CHANGELOG.md: ${orphans.join(", ")}`).toEqual([]);
        expect(versions(app).length).toBeGreaterThan(0);
        expect(versions(extension).length).toBeGreaterThan(versions(app).length);
    });

    it("both changelogs should carry the Unreleased heading the stamp looks for", () => {
        // stamp-changelog.mjs finds the section BY NAME in each file. A file
        // that lost the heading would stamp nothing and fail silently.
        expect(versions(extension)).toContain("Unreleased");
        expect(versions(app)).toContain("Unreleased");
    });

    it("no entry in the extension's changelog should be written as an app entry", () => {
        const misfiled = entries(extension).filter((e) => MISFILE.test(e));
        expect(misfiled, `app entries in CHANGELOG.md: ${misfiled.map((e) => e.slice(0, 60)).join(" | ")}`)
            .toEqual([]);
        // The sweep has to have read something, or an empty parse reports clean.
        expect(entries(extension).length).toBeGreaterThan(100);
        expect(entries(app).length).toBeGreaterThan(10);
    });

    it("the misfile pattern should fire on each opening it knows, and on nothing else", () => {
        // The half the check above cannot supply. `toEqual([])` over a filter is
        // satisfied by a pattern that matches nothing at all, so a prefix
        // silently falling out of the alternation reads exactly like a clean
        // changelog. `Breaking: ` was such a prefix: `mac/CHANGELOG.md` moved
        // from `Breaking, in <subject>:` to a bare `Breaking: ` and this was
        // never widened, so the one shape a new breaking misfile would take was
        // the one shape it could not see.
        for (const opening of [
            "Birta Writer Jot has a Format menu, and everything the panel can do is in it.",
            "Birta Writer for Mac has a Format menu, and everything the panel can do is in it.",
            "In Birta Writer for Mac, the default note moved with the name.",
            "Breaking, in Birta Writer for Mac: the default note moved with the name.",
            "Breaking: Birta Writer for Mac cannot update itself to this release.",
        ]) {
            expect(MISFILE.test(opening), `${opening.slice(0, 40)} should be caught`).toBe(true);
        }
        // And it refuses an editor entry that names the app in passing, which is
        // legitimate and lives in `CHANGELOG.md` today: a pattern that caught
        // those would be deleted the first time somebody wrote one.
        for (const legitimate of [
            "Toggle a task item done from the keyboard, and the same chord on Birta Writer Jot's Edit menu.",
            "Actual Size, a command that puts the content font size back to its default.",
            "Birta Writer now reads the theme from the workbench.",
        ]) {
            expect(MISFILE.test(legitimate), `${legitimate.slice(0, 40)} should be left alone`).toBe(false);
        }
    });

    it("neither changelog should have a heading or rule glued to the line above it", () => {
        // Markdown reads `---` directly beneath a line of text as a setext
        // heading marker, and a `####` with no blank line above it lands inside
        // the list item it follows. Both render wrongly on the Marketplace
        // Changelog tab while looking almost right in a diff.
        //
        // The split shipped 16 of the first and 4 dropped `####` headings,
        // because the migration ran a LINE-level parse that treated `---` and
        // `####` as continuations of the entry above. Neither the suite nor the
        // content check caught it: that check filtered lines starting with `-`,
        // which silently excluded `---` as well.
        for (const [name, text] of [["CHANGELOG.md", extension], ["mac/CHANGELOG.md", app]] as const) {
            const lines = text.split("\n");
            let fenced = false;
            const glued = lines.flatMap((line, i) => {
                if (line.startsWith("```")) { fenced = !fenced; return []; }
                if (fenced) { return []; }
                return i > 0 && lines[i - 1]!.trim() !== "" && (line === "---" || /^#{2,4} /.test(line))
                    ? [`${name}:${i + 1} ${line.slice(0, 40)}`]
                    : [];
            });
            expect(glued, `structure glued to the line above: ${glued.join(", ")}`).toEqual([]);
            expect(lines.length).toBeGreaterThan(20);
        }
    });

    it("the app's changelog should be excluded from the VSIX", () => {
        // Via `mac/**` rather than a rule of its own; if that line ever goes,
        // this file starts shipping to the Marketplace again.
        expect(read(".vscodeignore")).toMatch(/^mac\/\*\*$/m);
    });

    // A version heading must hold each section AT MOST ONCE, and nothing was
    // asking. The way this file gets edited is by inserting a `### Changed`
    // near the top of `## [Unreleased]` without looking for the one that is
    // already further down, and the result reads as an ordinary changelog: two
    // Changed sections, entries split across them, neither obviously wrong on
    // its own. It shipped once that way with every check green.
    //
    // It matters beyond tidiness because the release path reads these
    // sections. `scripts/stamp-changelog.mjs` rolls `[Unreleased]` into a
    // version heading and the notes generator lifts top items into Highlights,
    // so a duplicated section is one those two may only half see.
    //
    // Derived from the file rather than from a list of section names kept
    // here, so a section this repo has never used yet is covered the day it
    // first appears.
    it("no version heading should carry the same section twice", () => {
        for (const [name, text] of [["CHANGELOG.md", extension], ["mac/CHANGELOG.md", app]] as const) {
            const lines = text.split("\n");
            let version: string | null = null;
            let seen = new Set<string>();
            let checked = 0;
            for (const line of lines) {
                const versionHeading = /^## \[([^\]]+)\]/.exec(line);
                if (versionHeading) {
                    version = versionHeading[1]!;
                    seen = new Set();
                    continue;
                }
                const section = /^### (.+)$/.exec(line);
                if (!section || version === null) { continue; }
                const title = section[1]!.trim();
                expect(seen.has(title),
                    `${name}: "${version}" carries "### ${title}" more than once`).toBe(false);
                seen.add(title);
                checked += 1;
            }
            // A sweep that reached nothing passes, so the walk has to report
            // what it reached. Counted INDEPENDENTLY rather than against a
            // number written here: a literal floor is a guess about a file that
            // grows, and the first version of this line said 10 for a file
            // with 8 sections, which is the failure mode it was meant to
            // prevent. Every section in both files sits under a version
            // heading, so the walk must have seen all of them.
            const total = (text.match(/^### .+$/gm) ?? []).length;
            expect(total, `${name}: no sections at all`).toBeGreaterThan(0);
            expect(checked, `${name}: the walk skipped sections`).toBe(total);
        }
    });

    // The floor above only proves sections were counted, not that a duplicate
    // would have been caught. This runs the same rule over a fixture that IS
    // broken, in the exact shape the real defect took, so the check is known to
    // discriminate rather than assumed to.
    it("the duplicate-section rule should reject a heading that repeats a section", () => {
        const broken = [
            "## [Unreleased]",
            "",
            "### Changed",
            "",
            "- one",
            "",
            "### Added",
            "",
            "- two",
            "",
            "### Changed",
            "",
            "- three",
        ].join("\n");
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const line of broken.split("\n")) {
            const section = /^### (.+)$/.exec(line);
            if (!section) { continue; }
            const title = section[1]!.trim();
            if (seen.has(title)) { duplicates.push(title); }
            seen.add(title);
        }
        expect(duplicates).toEqual(["Changed"]);
    });
});
