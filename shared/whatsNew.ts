/**
 * Whether the releases a user has not seen yet contain something worth a dot.
 *
 * The surface is a quiet unread indicator on the settings gear, cleared when
 * the dropdown opens. The gate below is what makes it mean anything: releases
 * are nightly CalVer and VS Code auto-updates silently, so a dot that lights on
 * every release is lit almost every day, and a channel that is always lit is one
 * users learn to ignore. That fatigue failure is the whole risk this feature
 * carries, and it is why the bar is deliberately high.
 *
 * WHAT COUNTS AS SIGNIFICANT, and why it is not "the release shipped something".
 * `docs/RELEASING.md` sets the taxonomy: "Security leads because the reader is
 * scanning it to decide whether to act, which is the same reason Breaking
 * changes lead." That is exactly the test a dot has to pass, so the bar is
 * a `Security`, `Removed` or `Deprecated` SECTION and nothing else. A breaking
 * change flagged inline inside `Changed`, which is how AGENTS.md says to write
 * one, is invisible to this parser; the bar is the section headings, and the
 * user-facing description says so rather than promising "breaking changes".
 *
 * Two cheaper signals were measured against the shipped CHANGELOG and rejected,
 * because both fire on most releases and would reproduce the fatigue failure:
 *
 *   - "the release was not stamped no-user-visible-changes" — nearly every
 *     release carries an entry, so this is a did-we-ship signal, not a
 *     significance one.
 *   - "the release has an `Added` section", the source `Highlights` is promoted
 *     out of — also a clear majority of releases.
 *
 * Re-measure before changing the bar rather than quoting a figure from here:
 *   awk '/^## \[/{v=$2} /^### /{print $2}' CHANGELOG.md | sort | uniq -c
 *
 * Everything here is pure so it can be tested without a VS Code host: the
 * extension reads the shipped `CHANGELOG.md` and passes its text in.
 */

/** Sections whose presence in an unseen release justifies the indicator. */
export const SIGNIFICANT_SECTIONS = ["Security", "Removed", "Deprecated"] as const;

/** `## [2026.814.0] - 2026, August 14`, and the `[Unreleased]` heading. */
const VERSION_HEADING = /^## \[([^\]]+)\]/;
/** `### Security` and its siblings. */
const SECTION_HEADING = /^### (.+?)\s*$/;

/** One stamped release: its version and the section names it carries. */
export interface ReleaseSections {
    version: string;
    sections: string[];
}

/**
 * Split a CHANGELOG into its stamped releases, newest first.
 *
 * `[Unreleased]` is skipped: it is not a version anyone can be running, and a
 * developer tree always has one.
 */
export function parseChangelog(text: string): ReleaseSections[] {
    const releases: ReleaseSections[] = [];
    let current: ReleaseSections | undefined;
    for (const line of text.split("\n")) {
        const version = VERSION_HEADING.exec(line);
        if (version) {
            current = version[1] === "Unreleased"
                ? undefined
                : { version: version[1], sections: [] };
            if (current) { releases.push(current); }
            continue;
        }
        const section = SECTION_HEADING.exec(line);
        if (section && current) { current.sections.push(section[1]); }
    }
    return releases;
}

/**
 * Compare two CalVer strings (`2026.814.0`) numerically, segment by segment.
 *
 * Lexicographic comparison is wrong here and quietly so: `2026.9.0` sorts above
 * `2026.814.0` as text. A non-numeric segment compares as 0 rather than
 * throwing, because a version this cannot read must not break the editor.
 */
export function compareVersions(a: string, b: string): number {
    const as = a.split(".");
    const bs = b.split(".");
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const an = Number(as[i] ?? 0);
        const bn = Number(bs[i] ?? 0);
        const av = Number.isFinite(an) ? an : 0;
        const bv = Number.isFinite(bn) ? bn : 0;
        if (av !== bv) { return av < bv ? -1 : 1; }
    }
    return 0;
}

/**
 * Should the gear carry an unread dot?
 *
 * `lastSeen` is undefined on a fresh install, which is deliberately NOT unread:
 * first-run and update are different events, and the platform encodes the same
 * distinction by auto-opening a walkthrough on install only. The caller records
 * the installed version at that point, so the NEXT update is the first signal.
 *
 * The window is exclusive of `lastSeen` and inclusive of `installed`, so a
 * release the user has already seen can never re-light the dot, and a downgrade
 * (installed below lastSeen) yields an empty window rather than every release.
 */
export function hasUnseenSignificantRelease(
    changelog: string,
    lastSeen: string | undefined,
    installed: string,
): boolean {
    if (!lastSeen || compareVersions(lastSeen, installed) >= 0) { return false; }
    return parseChangelog(changelog).some(
        (r) =>
            compareVersions(r.version, lastSeen) > 0
            && compareVersions(r.version, installed) <= 0
            && r.sections.some((s) => (SIGNIFICANT_SECTIONS as readonly string[]).includes(s)),
    );
}
