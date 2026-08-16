/**
 * The unread-dot gate.
 *
 * Two halves, deliberately: hand-written fixtures pin the window arithmetic
 * (which is where an off-by-one silently re-lights a dot the user just
 * cleared), and the REAL shipped `CHANGELOG.md` pins the parser against the
 * format it actually has to read. A fixture-only suite here would agree with
 * itself: the parser and the fixture would be written from the same idea of the
 * file, and the one thing that matters is that it reads the file on disk.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    parseChangelog,
    compareVersions,
    hasUnseenSignificantRelease,
    SIGNIFICANT_SECTIONS,
} from "../whatsNew";

const CHANGELOG = readFileSync(join(__dirname, "..", "..", "CHANGELOG.md"), "utf8");

const FIXTURE = `# Changelog

## [Unreleased]

### Security

- An unreleased fix nobody is running yet.

## [2026.814.0] - 2026, August 14

### Added

- A feature.

### Fixed

- A bug.

## [2026.813.0] - 2026, August 13

### Security

- A real one.

## [2026.812.0] - 2026, August 12

### Changed

- Something cosmetic.
`;

describe("parseChangelog", () => {
    it("a changelog with an Unreleased section should omit it from the releases", () => {
        const versions = parseChangelog(FIXTURE).map((r) => r.version);
        expect(versions).toEqual(["2026.814.0", "2026.813.0", "2026.812.0"]);
    });

    it("a release with several sections should carry all of their names", () => {
        const first = parseChangelog(FIXTURE)[0];
        expect(first.sections).toEqual(["Added", "Fixed"]);
    });

    it("an empty changelog should produce no releases rather than throwing", () => {
        expect(parseChangelog("")).toEqual([]);
    });
});

describe("compareVersions", () => {
    it("a CalVer segment that is numerically larger should outrank a longer string", () => {
        // The trap this exists for: as text, "2026.9.0" sorts ABOVE
        // "2026.814.0", which would put a newer release outside the window.
        expect(compareVersions("2026.814.0", "2026.9.0")).toBe(1);
    });

    it("two equal versions should compare equal", () => {
        expect(compareVersions("2026.814.0", "2026.814.0")).toBe(0);
    });

    it("a missing trailing segment should compare as zero", () => {
        expect(compareVersions("2026.814", "2026.814.0")).toBe(0);
    });

    it("an unparseable segment should compare as zero rather than throwing", () => {
        expect(compareVersions("2026.x.0", "2026.0.0")).toBe(0);
    });
});

describe("hasUnseenSignificantRelease", () => {
    it("a fresh install with no last-seen version should not be unread", () => {
        expect(hasUnseenSignificantRelease(FIXTURE, undefined, "2026.814.0")).toBe(false);
    });

    it("a delta containing a Security release should be unread", () => {
        expect(hasUnseenSignificantRelease(FIXTURE, "2026.812.0", "2026.814.0")).toBe(true);
    });

    it("a delta containing only Added and Fixed should NOT be unread", () => {
        // The whole point of the gate: shipping something is not significance,
        // or the dot is lit almost every day and stops meaning anything.
        expect(hasUnseenSignificantRelease(FIXTURE, "2026.813.0", "2026.814.0")).toBe(false);
    });

    it("the last-seen release's own sections should not count, only later ones", () => {
        // 2026.813.0 IS the Security release; having seen it, it must not
        // re-light the dot. This is the off-by-one the window arithmetic exists
        // to get right.
        expect(hasUnseenSignificantRelease(FIXTURE, "2026.813.0", "2026.813.0")).toBe(false);
    });

    it("a release newer than the installed build should not count", () => {
        // The shipped CHANGELOG can describe releases this build predates: it is
        // stamped at cut time and a user can be running an older VSIX.
        expect(hasUnseenSignificantRelease(FIXTURE, "2026.812.0", "2026.812.0")).toBe(false);
    });

    it("a downgrade should be quiet rather than treating every release as unseen", () => {
        expect(hasUnseenSignificantRelease(FIXTURE, "2026.814.0", "2026.812.0")).toBe(false);
    });

    it("an unreleased-only changelog should never be unread", () => {
        expect(hasUnseenSignificantRelease("## [Unreleased]\n\n### Security\n\n- x\n", "2026.1.0", "2026.9.0"))
            .toBe(false);
    });
});

describe("against the shipped CHANGELOG", () => {
    it("the real file should parse into stamped releases with sections", () => {
        // Pins the parser to the format on disk. A heading style change that
        // silently returned zero releases would leave the dot permanently dark,
        // which no fixture-only test can see.
        const releases = parseChangelog(CHANGELOG);
        expect(releases.length, "stamped releases parsed").toBeGreaterThan(5);
        expect(releases.some((r) => r.sections.length > 0), "releases carrying sections").toBe(true);
    });

    it("the real file should use the section names the gate looks for", () => {
        // If `Security` were spelled differently, every assertion above would
        // still pass and the gate would never fire in production. This is the
        // join between the taxonomy and the predicate.
        const names = new Set(parseChangelog(CHANGELOG).flatMap((r) => r.sections));
        expect([...names].sort()).toEqual(expect.arrayContaining(["Added", "Fixed"]));
        expect(
            SIGNIFICANT_SECTIONS.some((s) => names.has(s)),
            `no significant section present; found: ${[...names].sort().join(", ")}`,
        ).toBe(true);
    });

    it("the significance bar should stay well below every release, or it is not a gate", () => {
        // The fatigue failure is the risk this feature carries, so the property
        // is asserted rather than left to a comment: if the bar ever fires on
        // most releases it has stopped gating. Measured over whatever the file
        // holds, so it survives new releases.
        const releases = parseChangelog(CHANGELOG);
        const significant = releases.filter((r) =>
            r.sections.some((s) => (SIGNIFICANT_SECTIONS as readonly string[]).includes(s)),
        );
        expect(
            significant.length,
            `${significant.length} of ${releases.length} releases clear the bar`,
        ).toBeLessThan(releases.length / 2);
    });
});
