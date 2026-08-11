/**
 * Guards that every CHANGELOG section has a route into the generated release
 * notes (MAR-320).
 *
 * `CHANGELOG.md` carries six Keep a Changelog sections; the notes taxonomy was
 * designed against three of them. `Added`/`Changed`/`Fixed` were mapped and
 * written down, and `Removed`, `Deprecated` and `Security` were not — so a
 * Security entry, the one section a reader scans to decide whether to act, had
 * no defined destination. Observed before the fix, running the generator by
 * hand against a stamped section holding a Security entry:
 *
 *   ### Highlights
 *   - add a thing
 *   ### Fixes
 *   - stop a javascript: link from being clickable
 *   ### Other
 *   - internal cleanup
 *
 * That is the no-key path, and it is the worse of the two: it never read the
 * changelog at all. The reviewed, user-framed Security entry was replaced by a
 * commit subject, the `Removed` entry vanished, and a refactor was published.
 *
 * So the assertions here are about ROUTING, not wording. The load-bearing ones
 * are the two invariants — no entry line may be dropped, and the prompt's prose
 * mapping must still agree with the table the code uses. An expected-output
 * check would pass the day someone adds a seventh section with nowhere to go.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
    changelogNotes,
    commitNotes,
    NOTES_SECTIONS,
    PROMPT,
    // @ts-expect-error — plain-JS CLI module, intentionally untyped.
} from "../../scripts/gen-release-notes.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

/** A stamped section carrying one entry under every section we define. */
const FULL = `### Added

- A new capability.

### Changed

- An existing one behaves better.

### Deprecated

- An old setting will go away.

### Removed

- A setting that did nothing is gone.

### Fixed

- A bug a user could see.

### Security

- A \`javascript:\` link is no longer clickable. Nothing could run through one before this either.`;

/** Entry (non-heading, non-blank) lines of a changelog section. */
function entryLines(section: string): string[] {
    return section
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("###"));
}

describe("the notes taxonomy", () => {
    it("should give every Keep a Changelog section a route", () => {
        // This is the whole ticket in one assertion. Three of the six had none:
        // `Removed`, `Deprecated` and `Security` were carried into the changelog
        // because Keep a Changelog defines them, and no decision was ever made
        // on the notes side. A seventh section added to AGENTS.md without a
        // route lands here rather than in a release.
        const KEEP_A_CHANGELOG = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
        const routed = (NOTES_SECTIONS as [string, string][]).map(([from]) => from);

        expect([...routed].sort()).toEqual([...KEEP_A_CHANGELOG].sort());
    });
});

describe("changelogNotes", () => {
    it("a Security entry should reach the notes rather than being dropped", () => {
        const out = changelogNotes(FULL) as string;

        expect(out).toContain("### Security");
        expect(out).toContain("A `javascript:` link is no longer clickable.");
        // The qualifier is the half a reader needs to NOT act. Losing it turns
        // a defence-in-depth note into an alarm (AGENTS.md: don't inflate).
        expect(out).toContain("Nothing could run through one before this either.");
    });

    it("no entry of the changelog section should be lost on the way into the notes", () => {
        // The invariant, not the layout. Every route added or renamed has to
        // keep this true, including a section nobody has thought of yet.
        const out = changelogNotes(FULL) as string;
        const kept = new Set(out.split("\n"));

        expect(entryLines(FULL).filter((l) => !kept.has(l))).toEqual([]);
    });

    it("every changelog section should be renamed to its notes section", () => {
        const out = changelogNotes(FULL) as string;

        for (const [from, to] of NOTES_SECTIONS as [string, string][]) {
            expect(out, `${from} has no route into the notes`).toContain(`### ${to}`);
            if (from !== to) expect(out).not.toContain(`### ${from}`);
        }
    });

    it("Security should lead, because a reader scans it to decide whether to act", () => {
        // Placement is the only axis this taxonomy has for urgency
        // (docs/RELEASING.md, "What goes in"), so it is where the decision lives.
        const out = changelogNotes(FULL) as string;
        const headings = [...out.matchAll(/^### (.+)$/gm)].map((m) => m[1]);

        expect(headings[0]).toBe("Security");
        expect(headings).toEqual(["Security", "New", "Improved", "Fixed", "Deprecated", "Removed"]);
    });

    it("a section name the taxonomy does not know should be carried, not swallowed", () => {
        // Silent dropping is the defect this replaces, so an unmapped heading
        // fails towards publishing it under its own name.
        const out = changelogNotes("### Fixed\n\n- A bug.\n\n### Ephemera\n\n- Something odd.") as string;

        expect(out).toContain("- Something odd.");
        expect(out.indexOf("### Fixed")).toBeLessThan(out.indexOf("### Ephemera"));
    });

    it("a release with nothing user-visible should say so instead of listing commits", () => {
        // The stamper's marker has no `###` headings at all. Falling through to
        // the commit list here would publish the refactors the marker denies.
        const marker = "_No user-visible changes; internal work only._";

        expect(changelogNotes(marker)).toBe(marker);
    });

    it("no changelog section to read should defer to the commit list", () => {
        // Returning "" would print an empty release note body; returning null is
        // what lets the caller reach the commit fallback.
        expect(changelogNotes("")).toBeNull();
        expect(changelogNotes("### Fixed\n")).toBeNull();
    });
});

describe("commitNotes", () => {
    it("conventional-commit subjects should still bucket by type", () => {
        const out = commitNotes([
            "feat: add a thing",
            "fix: correct a thing\n\nCloses MAR-1",
            "perf: speed a thing up",
            "refactor: internal cleanup",
        ]);

        expect(out).toContain("### Highlights\n\n- add a thing");
        expect(out).toContain("### Improvements\n\n- speed a thing up");
        expect(out).toContain("### Fixes\n\n- correct a thing");
        expect(out).toContain("### Other\n\n- internal cleanup");
    });
});

describe("the prompt", () => {
    const prompt = PROMPT(FULL, ["feat: add a thing"]) as string;

    it("every notes section the code emits should be a section the prompt asks for", () => {
        // The mapping lives in two places by necessity — a table the fallback
        // applies and prose the model reads — so it is checked against itself.
        // Drifting them apart is how `Security` came to have no home at all.
        //
        // Asked of a prompt with NO source material, and anchored to a line
        // rather than `toContain`. Both matter: the changelog is pasted into
        // this same string, and it carries the very headings being checked for
        // — so an assertion made against the full prompt is satisfied by the
        // entry it is trying to route, and passes with the section deleted. It
        // did. Emptying the source material is what makes the section list the
        // only thing that can satisfy this.
        const sectionsOnly = PROMPT("", []) as string;
        for (const [, to] of NOTES_SECTIONS as [string, string][]) {
            expect(sectionsOnly, `the prompt has no "### ${to}" section`).toMatch(
                new RegExp(`^[ \\t]*### ${to}\\b`, "m"),
            );
        }
    });

    it("every changelog section should be named in the prompt's mapping rule", () => {
        const rule = /^- Map the CHANGELOG sections onto those: (.+?)\. /m.exec(prompt)?.[1];
        expect(rule, "the prompt no longer states a CHANGELOG-to-notes mapping").toBeTruthy();

        for (const [from, to] of NOTES_SECTIONS as [string, string][]) {
            expect(rule).toContain(`${from} → ${to}`);
        }
    });

    it("the changelog section should reach the model verbatim", () => {
        // The AI path's source material was never the problem — the entry
        // arrived intact and had nowhere to be put. Pin that it still arrives.
        expect(prompt).toContain(FULL);
    });
});

/**
 * The routing above is worth nothing if the entry point does not reach for it,
 * and that wiring is one `??` in a block no unit test imports. This repo has
 * shipped a guard attached to nothing before (see releaseWorkflow.test.ts), so
 * the script is run the way the release job runs it: as a CLI, in a throwaway
 * repo, with no ANTHROPIC_API_KEY.
 */
describe("the generator, run as the release job runs it", () => {
    const script = path.resolve(repoRoot, "scripts", "gen-release-notes.mjs");

    function generate(changelog: string): string {
        const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
        try {
            // Identity and signing are forced off the developer's global
            // config: a machine with commit.gpgsign on cannot commit here, and
            // the failure would surface as the generator exiting non-zero for
            // reasons that have nothing to do with release notes.
            const git = (...args: string[]) =>
                spawnSync(
                    "git",
                    ["-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args],
                    { cwd: dir, encoding: "utf8" },
                );
            git("init", "-q", ".");
            writeFileSync(join(dir, "CHANGELOG.md"), changelog, "utf8");
            git("add", "CHANGELOG.md");
            git("commit", "-qm", "refactor: internal cleanup");

            // The key is stripped, not merely unset: a developer with one
            // exported would otherwise take the AI path and hit the network.
            const env = { ...process.env, VERSION: "2026.805.0", RANGE: "HEAD" };
            delete env.ANTHROPIC_API_KEY;

            const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env });
            expect(r.status, r.stderr).toBe(0);
            return r.stdout;
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    it("a stamped Security entry should appear in the notes, not a commit subject", () => {
        const out = generate(`# Changelog\n\n---\n\n## [Unreleased]\n\n---\n\n## [2026.805.0] - 2026, August 5\n\n${FULL}\n`);

        expect(out).toContain("## Birta Writer 2026.805.0");
        expect(out).toContain("### Security");
        expect(out).toContain("A `javascript:` link is no longer clickable.");
        // The commit subject is the thing that used to be published in its place.
        expect(out).not.toContain("internal cleanup");
    });

    it("both registry links should close the notes, whichever body path produced them", () => {
        // The links are appended once, outside the AI/changelog/commit-list
        // branch, so this holds on the path a failed API call falls back to as
        // well as the one it fell from. Asserted on the no-key path because
        // that is the one a test can run.
        const withChangelog = generate(`# Changelog\n\n---\n\n## [Unreleased]\n\n---\n\n## [2026.805.0] - 2026, August 5\n\n${FULL}\n`);
        const withoutChangelog = generate("# Changelog\n\n---\n\n## [Unreleased]\n");

        for (const out of [withChangelog, withoutChangelog]) {
            expect(out).toContain(
                "https://marketplace.visualstudio.com/items?itemName=BirtaLabs.birta-writer",
            );
            expect(out).toContain("https://open-vsx.org/extension/BirtaLabs/birta-writer");
            // Below every section, not merely present: the notes are what the
            // reader came for, and the install line closes them.
            expect(out.indexOf("Install from")).toBeGreaterThan(out.lastIndexOf("###"));
        }
    });

    it("a tree with no changelog to read should still produce notes", () => {
        // The commit list is the floor, and it has to stay reachable: without it
        // a release with no CHANGELOG.md emits an empty body.
        const out = generate("# Changelog\n\n---\n\n## [Unreleased]\n");

        expect(out).toContain("### Other\n\n- internal cleanup");
    });
});

describe("the repository's own CHANGELOG.md", () => {
    const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

    it("every section heading should be one the release notes can route", () => {
        // An invented heading still reaches the notes, under its own name — but
        // it reaches them as a section the taxonomy never agreed to publish.
        // Catch it here, where it is one word to fix, not in a release.
        const known = new Set((NOTES_SECTIONS as [string, string][]).map(([from]) => from));
        const headings = [...changelog.matchAll(/^### (.+)$/gm)].map((m) => m[1]);

        expect(headings.length).toBeGreaterThan(0);
        expect([...new Set(headings)].filter((h) => !known.has(h))).toEqual([]);
    });
});
