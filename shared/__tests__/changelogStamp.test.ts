/**
 * Guards on the release-time CHANGELOG roll (MAR-282).
 *
 * Releases had never rolled `## [Unreleased]` into a version heading. Two
 * user-visible consequences, both live on the Marketplace at the time of
 * writing: the Changelog tab led with a section literally titled "Unreleased"
 * above a semver history that stopped a month earlier, and — because the notes
 * generator read that same ever-growing section — four consecutive nightly
 * releases re-announced the entire product as if new.
 *
 * The stamper is a pure text transform, so the interesting cases are all
 * checkable here. Two of them are regressions of bugs this file caught while
 * the stamper was being written, and both are the kind that produce a
 * plausible-looking file rather than an error:
 *
 *  - an UNANCHORED heading match. `indexOf("## [Unreleased]")` also finds the
 *    string inside ordinary prose, and this changelog's own header documents
 *    the section by name. The match returned the header paragraph as the
 *    section body and the rewrite silently dropped the file's title.
 *  - the `---` separator between versions belongs to the preceding section's
 *    range, so an unstripped body carries it and every roll buries another
 *    rule inside the version above.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
    stamp,
    extractSection,
    dateFromVersion,
    NO_USER_VISIBLE_CHANGES,
    // @ts-expect-error — plain-JS CLI module, intentionally untyped.
} from "../../scripts/stamp-changelog.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

/** A changelog whose header names `## [Unreleased]` in prose, as ours does. */
const FILE = `# Changelog

Entries are written under \`## [Unreleased]\`; the release rolls them.

---

## [Unreleased]

### Fixed

- **A thing** — was broken, now is not.

---

## [2026.804.0] - 2026, August 4

### Added

- **Another thing** — it exists.

---
`;

describe("dateFromVersion", () => {
    it("a CalVer version should yield the date it encodes", () => {
        expect(dateFromVersion("2026.805.0")).toBe("2026, August 5");
        expect(dateFromVersion("2026.1231.2")).toBe("2026, December 31");
        expect(dateFromVersion("2026.731.0")).toBe("2026, July 31");
    });

    it("a non-CalVer version should be refused rather than guessed at", () => {
        // The heading's date is derived, never read from a second clock, so a
        // version this cannot parse must stop the release rather than stamp a
        // heading whose date disagrees with the version beside it.
        expect(() => dateFromVersion("0.2.3")).toThrow(/not a CalVer version/);
        expect(() => dateFromVersion("2026.899.0")).toThrow(/does not encode a real date/);
    });
});

describe("extractSection", () => {
    it("a section followed by a rule should not include the rule", () => {
        expect(extractSection(FILE, "Unreleased")).toBe(
            "### Fixed\n\n- **A thing** — was broken, now is not.",
        );
    });

    it("a heading named only in prose should not be mistaken for the section", () => {
        // The header's `## [Unreleased]` sits inside a backticked span mid-line.
        const body = extractSection(FILE, "Unreleased");
        expect(body).not.toContain("Entries are written under");
    });

    it("an absent heading should be reported as absent rather than as empty", () => {
        expect(extractSection(FILE, "1999.101.0")).toBeNull();
    });
});

describe("stamp", () => {
    it("entries under [Unreleased] should move to the version heading", () => {
        const out = stamp(FILE, "2026.805.0");

        expect(out).toContain("## [2026.805.0] - 2026, August 5");
        expect(extractSection(out, "2026.805.0")).toBe(
            "### Fixed\n\n- **A thing** — was broken, now is not.",
        );
        expect(extractSection(out, "Unreleased")).toBe("");
    });

    it("the file's header and older versions should survive the roll", () => {
        const out = stamp(FILE, "2026.805.0");

        expect(out.startsWith("# Changelog\n")).toBe(true);
        expect(out).toContain("Entries are written under");
        expect(extractSection(out, "2026.804.0")).toBe(
            "### Added\n\n- **Another thing** — it exists.",
        );
        // Exactly one Unreleased heading, at the start of its own line.
        expect(out.match(/^## \[Unreleased\]/gm)).toHaveLength(1);
    });

    it("no line of the previous file should be lost", () => {
        const out = stamp(FILE, "2026.805.0");
        const kept = new Set(out.split("\n"));
        const dropped = FILE.split("\n").filter((l) => l.trim() && !kept.has(l));

        expect(dropped).toEqual([]);
    });

    it("an empty [Unreleased] should record that the release changed nothing visible", () => {
        // 2026.802.0 was exactly this: commits landed, nothing observable
        // changed. It gets a heading anyway so the version sequence has no gap.
        const once = stamp(FILE, "2026.805.0");
        const twice = stamp(once, "2026.806.0");

        expect(extractSection(twice, "2026.806.0")).toBe(NO_USER_VISIBLE_CHANGES);
        expect(extractSection(twice, "2026.805.0")).toContain("A thing");
    });

    it("a version the file already carries should be left untouched", () => {
        // A retried step must not write the heading twice. The check is on the
        // version, not on emptiness — an empty section is a legitimate stamp.
        const once = stamp(FILE, "2026.805.0");

        expect(stamp(once, "2026.805.0")).toBe(once);
    });

    it("a rule should never be left directly under text", () => {
        // `text\n---` is a setext heading in Markdown, so a missing blank line
        // silently turns the marker line into an <h2>.
        const twice = stamp(stamp(FILE, "2026.805.0"), "2026.806.0");

        expect(twice).not.toMatch(/^(?!\s*$).+\n-{3,}$/m);
    });

    it("[Unreleased] as the only section should not leave a dangling separator", () => {
        const minimal = "# Changelog\n\n## [Unreleased]\n\n- **A thing** — happened.\n";

        expect(stamp(minimal, "2026.805.0").trimEnd()).toMatch(/happened\.$/);
    });

    it("a file with no [Unreleased] section should fail loudly", () => {
        expect(() => stamp("# Changelog\n\n## [2026.804.0] - 2026, August 4\n", "2026.805.0")).toThrow(
            /no `## \[Unreleased\]` section/,
        );
    });
});

// Both changelogs, because the release job stamps both. A file that lost its
// `## [Unreleased]` heading makes stamp-changelog.mjs throw, at 04:00, in the
// job that cuts the release; proving that of one of the two files it is run
// against is half a guard.
describe.each([["CHANGELOG.md"], ["mac/CHANGELOG.md"]])("the repository's own %s", (file) => {
    const changelog = readFileSync(path.join(repoRoot, file), "utf8");

    it("every version heading should be CalVer", () => {
        // The pre-Marketplace semver releases were never publicly installable
        // and now live in docs/CHANGELOG-PRE-MARKETPLACE.md, which .vscodeignore
        // keeps out of the VSIX — so the Changelog tab shows only versions a
        // user could actually have installed. A semver heading reappearing here
        // means that archive has started leaking back into the shipped file.
        const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
        const versions = headings.filter((h) => h !== "Unreleased");

        expect(versions.length).toBeGreaterThan(0);
        for (const v of versions) expect(() => dateFromVersion(v)).not.toThrow();
    });

    it("should be stampable by the release job whatever state it is in", () => {
        // Stamped with a version the file can NEVER already carry, and phrased
        // to hold in both states this file alternates between: entries pending,
        // and empty because the nightly rolled it hours ago. Naming a plausible
        // version here instead would go red on every PR opened the morning
        // after a release — a self-inflicted break of exactly the kind the
        // release job must not cause.
        const pending = extractSection(changelog, "Unreleased");
        const out = stamp(changelog, "2999.101.0");

        expect(extractSection(out, "Unreleased")).toBe("");
        expect(extractSection(out, "2999.101.0")).toBe(
            pending === "" ? NO_USER_VISIBLE_CHANGES : pending,
        );
        const kept = new Set(out.split("\n"));
        expect(changelog.split("\n").filter((l) => l.trim() && !kept.has(l))).toEqual([]);
    });
});

/**
 * The shipped changelog must not open on an empty [Unreleased] heading.
 *
 * The repository needs that heading; the Marketplace Changelog tab does not,
 * and after a stamp the reader saw it above the version they installed. The
 * release job strips it from the packaged copy only (scripts/strip-empty-
 * unreleased.mjs), then restores the repository copy before committing back.
 */
describe("strip-empty-unreleased", () => {
    const script = resolve(__dirname, "../../scripts/strip-empty-unreleased.mjs");

    function runOn(content: string): { code: number; text: string } {
        const dir = mkdtempSync(join(tmpdir(), "strip-unreleased-"));
        const file = join(dir, "CHANGELOG.md");
        writeFileSync(file, content, "utf8");
        const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
        const text = readFileSync(file, "utf8");
        rmSync(dir, { recursive: true, force: true });
        return { code: r.status ?? 1, text };
    }

    const STAMPED =
        "# Changelog\n\n---\n\n## [Unreleased]\n\n---\n\n## [2026.805.0] - 2026, August 5\n\n- A shipped thing.\n";

    it("a stamped changelog should lose the empty section and keep the version", () => {
        const { code, text } = runOn(STAMPED);
        expect(code).toBe(0);
        expect(text).not.toContain("[Unreleased]");
        expect(text).toContain("## [2026.805.0] - 2026, August 5");
        expect(text).toContain("- A shipped thing.");
    });

    it("an Unreleased section holding entries should be refused, not emptied", () => {
        const withEntries = STAMPED.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Not yet shipped.\n");
        const { code, text } = runOn(withEntries);
        expect(code).not.toBe(0);
        expect(text).toContain("- Not yet shipped.");
    });

    it("a changelog with no Unreleased section should be left alone", () => {
        const none = "# Changelog\n\n---\n\n## [1.0.0] - 2026, January 1\n\n- Old.\n";
        const { code, text } = runOn(none);
        expect(code).toBe(0);
        expect(text).toBe(none);
    });
});
