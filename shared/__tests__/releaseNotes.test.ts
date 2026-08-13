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
 * are invariants: no entry line may be dropped, every destination the table
 * names must be printable, and a line may surface only under the heading its
 * own changelog section maps to. An expected-output check would pass the day
 * someone adds a seventh section with nowhere to go.
 *
 * The last of those is asserted of the AI path against a stub API, which is the
 * only way to reach it. Before the stub, every claim about that path was a
 * claim about its prompt, and v2026.813.0 shipped four `Fixed` entries under
 * `Improved` with the whole file green.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createServer, type Server } from "node:http";
import {
    aiNotes,
    assembleNotes,
    bulletEntries,
    changelogNotes,
    commitNotes,
    NOTES_ORDER,
    NOTES_SECTIONS,
    PROMOTIONS,
    SECTION_PROMPT,
    validateSection,
    VERBATIM,
    // @ts-expect-error — plain-JS CLI module, intentionally untyped.
} from "../../scripts/gen-release-notes.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

/** A stamped section carrying one entry under every section we define. */
const FULL = `### Added

- A new capability.

- A second, lesser new capability.

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

describe("the emission order", () => {
    it("every mapped section should appear in NOTES_ORDER, in the same relative order", () => {
        // NOTES_ORDER is what the AI path emits by; NOTES_SECTIONS is what both
        // paths route by. A destination missing from the order would be built
        // and then never printed, which is the silent-drop failure again in a
        // new place.
        const order = NOTES_ORDER as string[];
        const mapped = (NOTES_SECTIONS as [string, string][]).map(([, to]) => to);

        expect(mapped.filter((to) => !order.includes(to))).toEqual([]);
        expect(mapped).toEqual(order.filter((h) => mapped.includes(h)));
    });

    it("every promotion should target a heading the order knows and no section maps onto", () => {
        // A promotion is a heading with no source section, so nothing else
        // checks that it can be printed, and nothing else checks that it does
        // not collide with a mapped destination.
        const order = NOTES_ORDER as string[];
        const mapped = new Set((NOTES_SECTIONS as [string, string][]).map(([, to]) => to));

        for (const [from, p] of Object.entries(PROMOTIONS as Record<string, { heading: string }>)) {
            expect(order, `${p.heading} is promoted out of ${from} but never printed`).toContain(
                p.heading,
            );
            expect(mapped.has(p.heading), `${p.heading} is both a destination and a promotion`).toBe(
                false,
            );
            expect((NOTES_SECTIONS as [string, string][]).some(([s]) => s === from)).toBe(true);
        }
    });
});

describe("the sections published verbatim", () => {
    it("every one should be a changelog section that exists", () => {
        // A typo here is silent: the set is consulted by name, so a heading
        // spelled wrong simply never matches and the section is condensed after
        // all, which is the outcome the set exists to prevent.
        const known = new Set((NOTES_SECTIONS as [string, string][]).map(([from]) => from));

        expect([...(VERBATIM as Set<string>)].filter((h) => !known.has(h))).toEqual([]);
    });
});

describe("bulletEntries", () => {
    it("a section's bullets should each become one entry", () => {
        expect(bulletEntries(["", "- One.", "", "- Two.", ""])).toEqual(["One.", "Two."]);
    });

    it("a wrapped entry should stay one entry rather than becoming two", () => {
        expect(bulletEntries(["- One", "  continued.", "- Two."])).toEqual([
            "One continued.",
            "Two.",
        ]);
    });

    it("prose before the first bullet should refuse the section rather than lose it", () => {
        // There is no entry for it to belong to, so a count check downstream
        // cannot notice it going missing.
        expect(bulletEntries(["Some prose.", "- One."])).toBeNull();
    });
});

describe("SECTION_PROMPT", () => {
    it("the model should be given entries and never a destination heading", () => {
        // The whole point of the per-section call: an instruction not to move an
        // entry is a request, and v2026.813.0 is what a request bought. Not
        // naming the destination at all is the constraint that replaced it.
        const prompt = SECTION_PROMPT("Changed", ["An existing one behaves better."], undefined) as string;

        expect(prompt).toContain("An existing one behaves better.");
        // The source section is named, because the model needs to know what
        // kind of entry it is condensing. Nothing else in the taxonomy is: a
        // destination it cannot name is a destination it cannot choose.
        for (const heading of NOTES_ORDER as string[]) {
            expect(prompt, `the prompt names the "${heading}" destination`).not.toContain(heading);
        }
    });

    it("a promoted section should ask for the promotion, and no other should", () => {
        const added = SECTION_PROMPT("Added", ["A new capability."], PROMOTIONS.Added) as string;
        const fixed = SECTION_PROMPT("Fixed", ["A bug."], undefined) as string;

        expect(added).toContain("promoted");
        expect(added).toContain(PROMOTIONS.Added.choose);
        expect(fixed).not.toContain("promoted");
    });

    it("every entry should reach the model verbatim", () => {
        // The source material was never the problem: entries arrived intact and
        // were then put in the wrong place. Pin that they still arrive.
        const entries = entryLines(FULL).map((l) => l.replace(/^-\s+/, ""));
        const prompt = SECTION_PROMPT("Added", entries, undefined) as string;

        expect(entries.filter((e) => !prompt.includes(e))).toEqual([]);
    });
});

describe("validateSection", () => {
    const entries = ["One.", "Two."];

    it("one line per entry should be accepted", () => {
        expect(validateSection({ lines: ["a", "b"] }, entries, undefined)).toEqual({
            lines: ["a", "b"],
            promoted: [],
        });
    });

    it("a reply with the wrong number of lines should be refused", () => {
        // Merged, split or dropped: there is no way to tell which, so the only
        // safe reading is that the reply no longer describes these entries.
        expect(validateSection({ lines: ["a"] }, entries, undefined)).toBeNull();
        expect(validateSection({ lines: ["a", "b", "c"] }, entries, undefined)).toBeNull();
    });

    it("a reply that is not a list of one-line strings should be refused", () => {
        expect(validateSection({}, entries, undefined)).toBeNull();
        expect(validateSection({ lines: ["a", ""] }, entries, undefined)).toBeNull();
        expect(validateSection({ lines: ["a", "b\nc"] }, entries, undefined)).toBeNull();
    });

    it("a promotion outside its bounds or its entry range should be refused", () => {
        const p = PROMOTIONS.Added as { min: number; max: number };
        const ok = (promoted: unknown) => validateSection({ lines: ["a", "b"], promoted }, entries, p);

        expect(ok([{ entry: 1, title: "T", summary: "S" }])).toBeTruthy();
        expect(ok([]), "Highlights may not be empty when there is a New section").toBeNull();
        expect(ok([{ entry: 3, title: "T", summary: "S" }])).toBeNull();
        expect(
            ok([
                { entry: 1, title: "T", summary: "S" },
                { entry: 1, title: "T", summary: "S" },
            ]),
        ).toBeNull();
        expect(ok([{ entry: 1, title: "", summary: "S" }])).toBeNull();
    });
});

describe("assembleNotes", () => {
    it("sections should be emitted in taxonomy order, not the order they were built", () => {
        const built = new Map([
            ["Fixed", "- a"],
            ["Highlights", "**T**\nS"],
            ["Security", "- s"],
        ]);

        expect([...(assembleNotes("", built) as string).matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(
            ["Security", "Highlights", "Fixed"],
        );
    });

    it("a heading the taxonomy does not know should follow the ones it does", () => {
        const built = new Map([
            ["Ephemera", "- odd"],
            ["Fixed", "- a"],
        ]);
        const out = assembleNotes("", built) as string;

        expect(out.indexOf("### Fixed")).toBeLessThan(out.indexOf("### Ephemera"));
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

    function generate(changelog: string, extraEnv: Record<string, string> = {}): string {
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
            const env = { ...process.env, VERSION: "2026.805.0", RANGE: "HEAD", ...extraEnv };
            if (!extraEnv.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;

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

/**
 * The AI path, end to end, against a stub standing in for the API.
 *
 * This is the path that shipped the defect, and until now it was the one path
 * no test could reach: it is a network call, so every assertion above it was
 * made about the prompt rather than about what came back. The stub makes the
 * reply the test's variable, which is what lets placement be asserted at all.
 */
describe("the AI path", () => {
    let server: Server;
    let reply: (prompt: string) => unknown;

    /** Echoes its section back, so a line can be traced to the section it came from. */
    const echo = (prompt: string) => {
        const heading = /Below are the \d+ `(.+?)` entries/.exec(prompt)?.[1];
        const count = [...prompt.matchAll(/^\d+\. /gm)].length;
        const lines = Array.from({ length: count }, (_, i) => `${heading} entry ${i + 1}`);
        return prompt.includes('"promoted"')
            ? { lines, promoted: [{ entry: 1, title: `${heading} title`, summary: "A summary." }] }
            : { lines };
    };

    beforeEach(async () => {
        reply = echo;
        server = createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const prompt = JSON.parse(body).messages[0].content;
                res.setHeader("content-type", "application/json");
                res.end(
                    JSON.stringify({
                        content: [{ type: "text", text: JSON.stringify(reply(prompt)) }],
                    }),
                );
            });
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address() as { port: number };
        process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
        process.env.ANTHROPIC_API_KEY = "stub";
    });

    afterEach(async () => {
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_API_KEY;
        await new Promise((r) => server.close(r));
    });

    /** Notes body split into `heading -> body`. */
    function sectionsOf(notes: string): Map<string, string> {
        const out = new Map<string, string>();
        let current: string | null = null;
        for (const line of notes.split("\n")) {
            const h = /^### (.+)$/.exec(line);
            if (h) out.set((current = h[1]), "");
            else if (current) out.set(current, `${out.get(current)}${line}\n`);
        }
        return out;
    }

    it("an entry should be published under the section its changelog section maps to", async () => {
        // The regression, stated as an invariant rather than an example. The
        // model is the variable here and it cannot move anything: it is never
        // told a destination, and the reply it gives is filed by the table.
        // v2026.813.0 published four `Fixed` entries under `Improved`.
        const sections = sectionsOf((await aiNotes(FULL)) as string);

        for (const [from, to] of NOTES_SECTIONS as [string, string][]) {
            const mine = `${from} entry`;
            for (const [heading, body] of sections) {
                const belongs = heading === to || heading === PROMOTIONS[from]?.heading;
                expect(
                    body.includes(mine),
                    `a ${from} entry was published under ${heading}`,
                ).toBe(belongs && body.includes(mine));
                if (!belongs) expect(body).not.toContain(mine);
            }
        }
    });

    it("a promoted entry should leave its own section rather than appear twice", async () => {
        const sections = sectionsOf((await aiNotes(FULL)) as string);

        expect(sections.get("Highlights")).toContain("**Added title**");
        expect(sections.get("New")).toContain("Added entry 2");
        // Entry 1 was lifted; publishing it in both places would double-count
        // the release's headline feature.
        expect(sections.get("New")).not.toContain("Added entry 1");
    });

    it("sections should be emitted in taxonomy order", async () => {
        const headings = [...sectionsOf((await aiNotes(FULL)) as string).keys()];

        // Spelled out rather than derived from NOTES_ORDER, which would assert
        // the order against itself. `Removed` is absent because its only entry
        // was promoted, which is what a promotion moving an entry looks like
        // from the outside.
        expect(headings).toEqual([
            "Breaking changes",
            "Security",
            "Highlights",
            "New",
            "Improved",
            "Fixed",
            "Deprecated",
        ]);
    });

    it("a reply with the wrong number of lines should abandon the whole path", async () => {
        // Not just the section: a body mixing condensed lines with untouched
        // changelog paragraphs would read as an editorial choice nobody made.
        reply = (prompt) =>
            prompt.includes("`Fixed`") ? { lines: [] } : (echo(prompt) as Record<string, unknown>);

        expect(await aiNotes(FULL)).toBeNull();
    });

    it("a one-off malformed reply should be retried rather than costing the release its notes", async () => {
        let seen = 0;
        reply = (prompt) => (prompt.includes("`Fixed`") && seen++ === 0 ? { lines: [] } : echo(prompt));

        expect(sectionsOf((await aiNotes(FULL)) as string).get("Fixed")).toContain("Fixed entry 1");
    });

    it("a Security entry should be published as the changelog wrote it", async () => {
        // Never condensed, so the model cannot drop the clause saying what was
        // NOT exposed. The stub would replace the whole entry with "Security
        // entry 1", which is what reaching the model at all would look like.
        const sections = sectionsOf((await aiNotes(FULL)) as string);

        expect(sections.get("Security")).toContain(
            "A `javascript:` link is no longer clickable. Nothing could run through one before this either.",
        );
        expect(sections.get("Security")).not.toContain("Security entry");
    });

    it("an unreachable API should fall back rather than throw", async () => {
        process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

        expect(await aiNotes(FULL)).toBeNull();
    });

    it("a section the taxonomy does not know should keep its own name", async () => {
        const sections = sectionsOf((await aiNotes("### Ephemera\n\n- Something odd.")) as string);

        expect(sections.get("Ephemera")).toContain("Ephemera entry 1");
    });

    it("a changelog with no sections should defer rather than invent one", async () => {
        // The stamper's `_No user-visible changes_` marker. Sending it to the
        // model would produce notes for a release that has none.
        expect(await aiNotes("_No user-visible changes; internal work only._")).toBeNull();
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
