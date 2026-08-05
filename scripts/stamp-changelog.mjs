#!/usr/bin/env node
// Roll CHANGELOG.md's `## [Unreleased]` section into a version heading (MAR-282).
//
// Releases had never done this. The file ships inside the VSIX and is what the
// Marketplace renders on its Changelog tab, so a user installing 2026.804.0
// opened the tab and read "Unreleased" above a semver history that stopped at
// 0.2.3 — three-plus weeks stale, and for versions that were never publicly
// installable. The same omission fed the WHOLE cumulative section to
// gen-release-notes.mjs every night, so four consecutive GitHub Releases
// re-announced the entire product as if new.
//
// The release job runs this before packaging, then commits the result back to
// main. Nothing here is version bookkeeping: the heading's date is DERIVED from
// the CalVer version rather than read from a clock, so the heading and the
// version it names cannot drift apart (docs/RELEASING.md: "the version is the
// release date").
//
// Usage: VERSION=2026.805.0 node scripts/stamp-changelog.mjs [path]
//        (defaults to CHANGELOG.md in the working directory)

import { readFileSync, writeFileSync } from "node:fs";

/** Marker for a release that landed commits but changed nothing a user can see. */
export const NO_USER_VISIBLE_CHANGES = "_No user-visible changes; internal work only._";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split the file around a `## [heading]` section: what precedes it, its body,
 * and what follows.
 *
 * The heading must be matched ANCHORED TO THE START OF A LINE. An unanchored
 * `indexOf("## [Unreleased]")` — which is what this file and gen-release-notes
 * both used to do — also matches the string where it appears inside ordinary
 * prose, and this changelog's own header names the section it documents. That
 * match silently returned the header paragraph as the section and dropped the
 * file's title on write.
 *
 * The `---` rule separating versions is furniture, not content: it sits inside
 * the preceding section's range, so it has to be stripped or every stamped
 * section would swallow the separator above the next one (and the model
 * generating release notes would be handed a stray rule as source material).
 */
export function splitSection(text, heading) {
    const re = new RegExp(`^## \\[${escape(heading)}\\][^\\n]*\\n`, "m");
    const m = re.exec(text);
    if (!m) return null;
    const before = text.slice(0, m.index);
    const rest = text.slice(m.index + m[0].length);
    const next = rest.search(/\n## \[/);
    const raw = next === -1 ? rest : rest.slice(0, next);
    const after = next === -1 ? "" : rest.slice(next + 1);
    return { before, body: raw.trim().replace(/(^|\n)-{3,}$/, "").trim(), after };
}

/** The body under a `## [heading]` section, or null when there is no such heading. */
export function extractSection(text, heading) {
    return splitSection(text, heading)?.body ?? null;
}

/**
 * CalVer encodes the release date, so derive the heading's date from the
 * version instead of reading a clock. A second clock read could land on the
 * other side of midnight from the one that produced the version.
 */
export function dateFromVersion(version) {
    const m = /^(\d{4})\.(\d{3,4})\.(\d+)$/.exec(version);
    if (!m) throw new Error(`not a CalVer version: ${version} (expected YYYY.MMDD.N)`);
    const [, year, mmdd] = m;
    const month = Math.floor(Number(mmdd) / 100);
    const day = Number(mmdd) % 100;
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        throw new Error(`version ${version} does not encode a real date`);
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Replace `## [Unreleased]` with an empty `## [Unreleased]` followed by
 * `## [version] - date` carrying what Unreleased held.
 *
 * Idempotent on the VERSION, not on emptiness: re-running for a version the
 * file already carries is a no-op, so a retried step cannot write the heading
 * twice. An *empty* Unreleased is NOT a no-op — it stamps the marker above,
 * which is the honest record for a release like 2026.802.0 that carried
 * commits but nothing observable, and keeps the version sequence gap-free.
 */
export function stamp(text, version) {
    const date = dateFromVersion(version);
    if (splitSection(text, version)) return text;

    const section = splitSection(text, "Unreleased");
    if (!section) throw new Error("CHANGELOG.md has no `## [Unreleased]` section to stamp");
    const { before, body, after } = section;

    const stamped = body === "" ? NO_USER_VISIBLE_CHANGES : body;
    // A `---` directly under text would be read as a setext heading underline,
    // so the blank line before it is load-bearing, not cosmetic.
    const tail = after === "" ? "" : `---\n\n${after}`;
    return `${before}## [Unreleased]\n\n---\n\n## [${version}] - ${date}\n\n${stamped}\n\n${tail}`;
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
    const version = process.env.VERSION;
    if (!version) {
        console.error("stamp-changelog: VERSION is required (e.g. VERSION=2026.805.0)");
        process.exit(1);
    }
    const path = process.argv[2] ?? "CHANGELOG.md";
    const before = readFileSync(path, "utf8");
    const after = stamp(before, version);
    if (after === before) {
        console.error(`stamp-changelog: ${path} already carries ${version} — nothing to do.`);
    } else {
        writeFileSync(path, after);
        console.error(`stamp-changelog: rolled [Unreleased] into ${version} in ${path}.`);
    }
}
