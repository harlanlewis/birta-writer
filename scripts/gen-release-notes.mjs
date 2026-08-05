#!/usr/bin/env node
// Generate end-user release notes for a Birta Writer release.
//
// Reads the git commit range and this version's CHANGELOG section, then asks
// Claude to infer cursor.com/changelog-style highlights: a few tentpole items
// described for the benefit they deliver, followed by smaller improvements and
// fixes. If ANTHROPIC_API_KEY is absent or the API call fails, it degrades to
// the changelog section re-sectioned into the notes taxonomy, and only if there
// is no changelog to read to a categorized commit list — so a release never
// blocks on the model being reachable.
//
// Env:
//   RANGE              git revision range, e.g. "v0.3.1..HEAD" (default: last tag..HEAD)
//   VERSION            version being released, e.g. "0.3.2" (for the heading)
//   ANTHROPIC_API_KEY  optional; enables AI-authored highlights
//   ANTHROPIC_MODEL    optional; defaults to claude-haiku-4-5
//   OUT                optional output file; otherwise writes to stdout
//
// No dependencies — Node 20+ (global fetch).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { extractSection } from "./stamp-changelog.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const VERSION = process.env.VERSION || "unreleased";

function range() {
  if (process.env.RANGE) return process.env.RANGE;
  const last = sh("git tag -l 'v*' | sort -V | tail -1").trim();
  return last ? `${last}..HEAD` : "HEAD";
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** Raw commit subjects+bodies in the range, newest first. */
function commits() {
  const raw = sh(
    `git log ${range()} --no-merges --pretty=format:'%s%n%b%n===COMMIT==='`,
  );
  return raw
    .split("===COMMIT===")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * THIS release's changelog entries — already end-user framed.
 *
 * The release job stamps CHANGELOG.md before calling this, so the entries for
 * this version live under `## [<version>]` and `## [Unreleased]` is empty. Read
 * the stamped section, falling back to `[Unreleased]` when running by hand
 * against an unstamped tree.
 *
 * Reading `[Unreleased]` unconditionally is what made every nightly re-announce
 * the whole product: nothing ever rolled that section, so it accumulated every
 * entry ever written and each night's notes described all of them as new. The
 * v2026.804.0 notes ran to 112 lines of features that had shipped weeks earlier
 * (MAR-282).
 */
function releaseChangelog() {
  let text;
  try {
    text = readFileSync("CHANGELOG.md", "utf8");
  } catch {
    return "";
  }
  return extractSection(text, VERSION) ?? extractSection(text, "Unreleased") ?? "";
}

/**
 * Keep a Changelog heading → release-notes heading, in the order the notes
 * present them.
 *
 * This table is the mapping between the two taxonomies, and it is the SAME
 * mapping the prompt states in prose — keep the two in step. It exists because
 * three of the six changelog sections had no route into the notes at all: the
 * prompt named five sections and neither `Removed`, `Deprecated` nor `Security`
 * was among them, and the fallback did not read the changelog in the first
 * place (MAR-320).
 *
 * Security leads for the same reason Breaking changes do in the prompt: a
 * reader scans it to decide whether to act. Placement is how this taxonomy
 * expresses urgency — it has no separate axis for it (docs/RELEASING.md, "What
 * goes in").
 */
export const NOTES_SECTIONS = [
  ["Security", "Security"],
  ["Added", "New"],
  ["Changed", "Improved"],
  ["Fixed", "Fixed"],
  ["Deprecated", "Deprecated"],
  ["Removed", "Removed"],
];

/**
 * Fallback: re-section THIS release's changelog entries into the notes
 * taxonomy.
 *
 * Preferred over the commit list below, and not only because a Security entry
 * used to vanish here. Changelog entries are already written for a user, and
 * were reviewed as such; commit subjects are written for the next developer, so
 * bucketing them publishes `refactor: internal cleanup` under "Other" —
 * precisely what the observability rule says never goes in.
 *
 * Nothing in the section is dropped. An unrecognized `###` heading keeps its
 * own name and follows the mapped ones, and text above the first heading (the
 * stamper's `_No user-visible changes_` marker, which has no headings at all)
 * is carried through as-is. Silent dropping is the defect this replaces, so
 * "pass it through under its own name" is the safe direction to fail in.
 */
export function changelogNotes(changelog) {
  const body = (changelog || "").trim();
  if (!body) return null;

  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of body.split("\n")) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  // Recognized sections in taxonomy order, then the rest in source order.
  // Array#sort is stable, so the unrecognized tail keeps the order it was
  // written in rather than being shuffled by a tie.
  const rank = (s) => {
    const at = NOTES_SECTIONS.findIndex(([from]) => from === s.heading);
    return at === -1 ? NOTES_SECTIONS.length : at;
  };
  const parts = [preamble.join("\n").trim()];
  for (const s of [...sections].sort((a, b) => rank(a) - rank(b))) {
    const text = s.lines.join("\n").trim();
    if (!text) continue;
    const mapped = NOTES_SECTIONS.find(([from]) => from === s.heading);
    parts.push(`### ${mapped ? mapped[1] : s.heading}\n\n${text}`);
  }
  return parts.filter(Boolean).join("\n\n") || null;
}

/**
 * Last-ditch fallback: group conventional-commit subjects by type.
 *
 * Only reached when there is no changelog section to read — a tree with no
 * CHANGELOG.md, or an empty `[Unreleased]` run by hand before the stamp.
 */
export function commitNotes(list) {
  const buckets = { feat: [], fix: [], perf: [], other: [] };
  for (const c of list) {
    const subject = c.split("\n")[0];
    const m = subject.match(/^(\w+)(\(.+\))?!?:\s*(.+)$/);
    const type = m ? m[1] : "other";
    const desc = m ? m[3] : subject;
    (buckets[type] || buckets.other).push(desc);
  }
  const section = (title, items) =>
    items.length ? `### ${title}\n\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";
  return [
    section("Highlights", buckets.feat),
    section("Improvements", buckets.perf),
    section("Fixes", buckets.fix),
    section("Other", buckets.other),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

export const PROMPT = (changelog, list) => `You are writing end-user release notes for Birta Writer, a WYSIWYG Markdown editor extension for VS Code. Produce Markdown in the style of https://cursor.com/changelog: lead with the most significant new capabilities described for the benefit they deliver, then the rest, grouped by kind.

Rules:
- Matter-of-fact tone. State the capability and why it matters. No marketing adjectives ("powerful", "seamless", "delightful"), no exclamation marks.
- Structure exactly these sections, in this order, omitting any that would be empty:
  ## Breaking changes (only if any — changes that require the user to act; lead each with the action needed)
  ## Security     (security-relevant changes; bulleted, one line each. Reproduce the changelog's wording and scope — do not raise or lower the severity it states, and keep any sentence saying what was NOT exposed)
  ## Highlights   (the 1-4 most significant NEW capabilities; each a bold short title on its own line, then 1-2 plain sentences)
  ## New          (other new features; bulleted, one line each)
  ## Improved     (existing features that changed or got better, including user-visible performance; bulleted, one line each)
  ## Fixed        (user-visible bug fixes; bulleted, one line each)
  ## Deprecated   (still works, but is going away; bulleted, one line each)
  ## Removed      (gone; bulleted, one line each. A removal the user must act on is a Breaking change instead)
- Map the CHANGELOG sections onto those: Added → New, Changed → Improved, Fixed → Fixed, Security → Security, Deprecated → Deprecated, Removed → Removed. Every changelog entry lands in exactly one section; none may be dropped for want of somewhere to put it. Highlights is a promotion out of New, not a seventh source section.
- A first release with no prior public version has only Highlights + New — there is nothing to improve or fix against yet.
- Only describe what a user can observe. Drop anything invisible to them: refactors, internal performance, tooling, tests, dependency and version bumps. A performance win a user can feel ("faster launch") goes under Improved.
- Merge duplicates and superseded iterations — describe the final capability once, not its development history.
- Do NOT invent features. Only describe what the source material supports.
- Do not include a top-level version heading; that is added separately.

Source material follows.

=== CHANGELOG entries for THIS release (authoritative, already user-framed) ===
${changelog || "(none)"}

=== Commit log for this release range ===
${list.join("\n\n") || "(none)"}`;

async function aiNotes(changelog, list) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: PROMPT(changelog, list) }],
      }),
    });
    if (!res.ok) {
      console.error(`Anthropic API ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.error(`Release-notes generation failed, using fallback: ${err}`);
    return null;
  }
}

// Guarded so the pure pieces above can be imported and tested without the
// module running git and writing to stdout on import (same shape as
// stamp-changelog.mjs).
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const list = commits();
  const changelog = releaseChangelog();
  const body = (await aiNotes(changelog, list)) ?? changelogNotes(changelog) ?? commitNotes(list);
  const out = `## Birta Writer ${VERSION}\n\n${body}\n`;

  if (process.env.OUT) {
    writeFileSync(process.env.OUT, out);
    console.error(`Wrote release notes to ${process.env.OUT}`);
  } else {
    process.stdout.write(out);
  }
}
