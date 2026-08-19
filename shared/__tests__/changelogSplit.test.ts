/**
 * The two changelogs are split by PRODUCT, and stay that way.
 *
 * `CHANGELOG.md` ships inside the VSIX and is what the VS Code Marketplace and
 * Open VSX render on their Changelog tabs. Jot is installable from neither: it
 * is an app attached to a GitHub Release. So a Jot entry in the extension's
 * changelog reaches an audience that cannot act on it, which is the bar
 * AGENTS.md sets for an entry earning its place. Before the split, 34 of the 40
 * entries in one release were about Jot.
 *
 * `jot/CHANGELOG.md` is kept out of the VSIX by `.vscodeignore`'s `jot/**`, so
 * the split costs no new packaging rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const extension = read("CHANGELOG.md");
const jot = read("jot/CHANGELOG.md");

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

describe("the changelog split", () => {
    it("every version in Jot's changelog should exist in the extension's", () => {
        // One release stamps both, so Jot can never carry a version the
        // extension has never heard of. The reverse is expected and fine: most
        // releases change nothing about the app.
        const all = new Set(versions(extension));
        const orphans = versions(jot).filter((v) => !all.has(v));
        expect(orphans, `versions only in jot/CHANGELOG.md: ${orphans.join(", ")}`).toEqual([]);
        expect(versions(jot).length).toBeGreaterThan(0);
        expect(versions(extension).length).toBeGreaterThan(versions(jot).length);
    });

    it("both changelogs should carry the Unreleased heading the stamp looks for", () => {
        // stamp-changelog.mjs finds the section BY NAME in each file. A file
        // that lost the heading would stamp nothing and fail silently.
        expect(versions(extension)).toContain("Unreleased");
        expect(versions(jot)).toContain("Unreleased");
    });

    it("no entry in the extension's changelog should be written as a Jot entry", () => {
        // A shape check, not a semantic one, and deliberately narrow: it catches
        // the way Jot entries are actually written (the subject opens the
        // sentence) without firing on an editor entry that mentions Jot in
        // passing, which is legitimate and exists. It cannot catch a Jot entry
        // phrased to avoid the opening, so it is a floor rather than a proof.
        const misfiled = entries(extension).filter((e) =>
            /^(Breaking, in |In )?Birta (Writer )?Jot\b/.test(e));
        expect(misfiled, `Jot entries in CHANGELOG.md: ${misfiled.map((e) => e.slice(0, 60)).join(" | ")}`)
            .toEqual([]);
        // The sweep has to have read something, or an empty parse reports clean.
        expect(entries(extension).length).toBeGreaterThan(100);
        expect(entries(jot).length).toBeGreaterThan(10);
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
        for (const [name, text] of [["CHANGELOG.md", extension], ["jot/CHANGELOG.md", jot]] as const) {
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

    it("Jot's changelog should be excluded from the VSIX", () => {
        // Via `jot/**` rather than a rule of its own; if that line ever goes,
        // this file starts shipping to the Marketplace again.
        expect(read(".vscodeignore")).toMatch(/^jot\/\*\*$/m);
    });
});
