#!/usr/bin/env node
// Generate end-user release notes for a Birta Writer release.
//
// Reads the git commit range and the CHANGELOG "[Unreleased]" section, then asks
// Claude to infer cursor.com/changelog-style highlights: a few tentpole items
// described for the benefit they deliver, followed by smaller improvements and
// fixes. If ANTHROPIC_API_KEY is absent or the API call fails, it degrades to a
// categorized commit list so a release never blocks on the model being reachable.
//
// Env:
//   RANGE              git revision range, e.g. "v0.3.1..HEAD" (default: last tag..HEAD)
//   VERSION            version being released, e.g. "0.3.2" (for the heading)
//   ANTHROPIC_API_KEY  optional; enables AI-authored highlights
//   ANTHROPIC_MODEL    optional; defaults to claude-sonnet-5
//   OUT                optional output file; otherwise writes to stdout
//
// No dependencies — Node 20+ (global fetch).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const VERSION = process.env.VERSION || "unreleased";
const RANGE =
  process.env.RANGE ||
  (() => {
    const last = sh("git tag -l 'v*' | sort -V | tail -1").trim();
    return last ? `${last}..HEAD` : "HEAD";
  })();

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** Raw commit subjects+bodies in the range, newest first. */
function commits() {
  const raw = sh(
    `git log ${RANGE} --no-merges --pretty=format:'%s%n%b%n===COMMIT==='`,
  );
  return raw
    .split("===COMMIT===")
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The prose under "## [Unreleased]" in CHANGELOG.md — already end-user framed. */
function unreleasedChangelog() {
  let text;
  try {
    text = readFileSync("CHANGELOG.md", "utf8");
  } catch {
    return "";
  }
  const start = text.indexOf("## [Unreleased]");
  if (start === -1) return "";
  const rest = text.slice(start + "## [Unreleased]".length);
  const next = rest.search(/\n## \[/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Fallback: group conventional-commit subjects by type. */
function fallbackNotes(list) {
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

const PROMPT = (changelog, list) => `You are writing end-user release notes for Birta Writer, a WYSIWYG Markdown editor extension for VS Code. Produce Markdown in the style of https://cursor.com/changelog: lead with the most significant new capabilities described for the benefit they deliver, then the rest, grouped by kind.

Rules:
- Matter-of-fact tone. State the capability and why it matters. No marketing adjectives ("powerful", "seamless", "delightful"), no exclamation marks.
- Structure exactly these sections, in this order, omitting any that would be empty:
  ## Breaking changes (only if any — changes that require the user to act; lead each with the action needed)
  ## Highlights   (the 1-4 most significant NEW capabilities; each a bold short title on its own line, then 1-2 plain sentences)
  ## New          (other new features; bulleted, one line each)
  ## Improved     (existing features that changed or got better, including user-visible performance; bulleted, one line each)
  ## Fixed        (user-visible bug fixes; bulleted, one line each)
- A first release with no prior public version has only Highlights + New — there is nothing to improve or fix against yet.
- Only describe what a user can observe. Drop anything invisible to them: refactors, internal performance, tooling, tests, dependency and version bumps. A performance win a user can feel ("faster launch") goes under Improved.
- Merge duplicates and superseded iterations — describe the final capability once, not its development history.
- Do NOT invent features. Only describe what the source material supports.
- Do not include a top-level version heading; that is added separately.

Source material follows.

=== CHANGELOG [Unreleased] (authoritative, already user-framed) ===
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

const list = commits();
const changelog = unreleasedChangelog();
const body = (await aiNotes(changelog, list)) ?? fallbackNotes(list);
const out = `## Birta Writer ${VERSION}\n\n${body}\n`;

if (process.env.OUT) {
  writeFileSync(process.env.OUT, out);
  console.error(`Wrote release notes to ${process.env.OUT}`);
} else {
  process.stdout.write(out);
}
