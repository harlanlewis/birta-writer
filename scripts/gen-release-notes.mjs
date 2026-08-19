#!/usr/bin/env node
// Generate end-user release notes for a Birta Writer release.
//
// Reads this version's section of BOTH changelogs (the extension's and Jot's,
// which are split by product) and condenses them into
// cursor.com/changelog-style notes: a few tentpole items described for the
// benefit they deliver, followed by smaller improvements and fixes.
//
// Which section an entry lands in is decided HERE, by the NOTES_SECTIONS table,
// and Claude is asked only to condense a paragraph to a line and to pick the
// tentpoles. It is called once per changelog section and never sees a heading,
// so it cannot move an entry between sections. It did: v2026.813.0 published
// four `Fixed` entries under `Improved`.
//
// If ANTHROPIC_API_KEY is absent, a call fails, or a reply does not hold one
// line per entry, it degrades to the changelog section re-sectioned into the
// notes taxonomy, and only if there is no changelog to read to a categorized
// commit list. So a release never blocks on the model being reachable, and
// never publishes notes the changelog does not support.
//
// Env:
//   RANGE              git revision range, e.g. "v0.3.1..HEAD" (default: last tag..HEAD)
//   VERSION            version being released, e.g. "0.3.2" (for the heading)
//   ANTHROPIC_API_KEY  optional; enables AI-condensed notes
//   ANTHROPIC_MODEL    optional; defaults to claude-haiku-4-5
//   ANTHROPIC_BASE_URL optional; defaults to https://api.anthropic.com
//   OUT                optional output file; otherwise writes to stdout
//
// No dependencies — Node 20+ (global fetch).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { extractSection } from "./stamp-changelog.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
// Read per call, not once at import: pointing this at a stub is the only way
// the AI path is reachable from a test, and a test cannot set an environment
// variable before an ESM import of the module that would read it
// (shared/__tests__/releaseNotes.test.ts).
const apiBase = () => process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
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
  const sections = [];
  for (const file of ["CHANGELOG.md", "jot/CHANGELOG.md"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const body = extractSection(text, VERSION) ?? extractSection(text, "Unreleased") ?? "";
    if (body.trim()) sections.push(body.trim());
  }
  return mergeByHeading(sections);
}

/**
 * Both changelogs, merged so each Keep a Changelog heading appears once with
 * every entry under it.
 *
 * The two files are split by PRODUCT, because the Marketplace renders only the
 * extension's. A GitHub Release carries both the VSIX and the Jot app, so its
 * notes cover both, and concatenating the files whole would hand the notes two
 * `### Added` headings and let the section table sort the same heading twice.
 * Order follows the first file that used a heading, so the extension's sections
 * lead.
 */
export function mergeByHeading(sections) {
  const order = [];
  const byHeading = new Map();
  for (const section of sections) {
    let heading = null;
    for (const line of section.split("\n")) {
      if (line.startsWith("### ")) {
        heading = line.trim();
        if (!byHeading.has(heading)) { byHeading.set(heading, []); order.push(heading); }
        continue;
      }
      if (heading) byHeading.get(heading).push(line);
    }
  }
  // No headings on either side means both are the no-user-visible-changes
  // marker, and printing it once per product would announce nothing twice.
  if (!order.length) return [...new Set(sections)].join("\n\n").trim();
  return order
    .map((h) => `${h}\n${byHeading.get(h).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}`)
    .join("\n\n")
    .trim();
}

/**
 * Keep a Changelog heading → release-notes heading, in the order the notes
 * present them.
 *
 * This table is the mapping between the two taxonomies, and it is the ONLY
 * thing that decides where an entry is published, on both body paths. The
 * prompt no longer states it, because a prompt that states it is a prompt that
 * can be disregarded. It exists because three of the six changelog sections had
 * no route into the notes at all: the prompt named five sections and neither
 * `Removed`, `Deprecated` nor `Security` was among them, and the fallback did
 * not read the changelog in the first place (MAR-320).
 *
 * Security leads for the same reason Breaking changes do: a
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
 * The notes taxonomy in the order the notes present it (docs/RELEASING.md,
 * "What goes in"). Every `NOTES_SECTIONS` destination appears here, in the same
 * relative order, plus the two headings no changelog section maps onto:
 * `Highlights` is a promotion out of `Added`, and `Breaking changes` a
 * promotion out of `Removed`. Both are defined by PROMOTIONS below.
 */
export const NOTES_ORDER = [
  "Breaking changes",
  "Security",
  "Highlights",
  "New",
  "Improved",
  "Fixed",
  "Deprecated",
  "Removed",
];

/**
 * A changelog section whose entries may be lifted into a heading of their own.
 *
 * A promotion MOVES an entry: it appears under the promoted heading or under
 * the section's own, never both. `min`/`max` bound how many may be lifted, and
 * are enforced against the model's answer rather than requested politely.
 */
export const PROMOTIONS = {
  Added: {
    heading: "Highlights",
    min: 1,
    max: 4,
    choose: "the 1 to 4 most significant new capabilities",
  },
  Removed: {
    heading: "Breaking changes",
    min: 0,
    max: Infinity,
    choose: "only those a user must act on, which may be none of them",
  },
};

/**
 * Split a stamped changelog section into its `###` sections, keeping every line
 * exactly as written.
 *
 * Both body paths read the changelog through this, so they agree on what a
 * section is. Text above the first heading is the preamble, which is how the
 * stamper's `_No user-visible changes_` marker survives having no headings.
 */
export function parseSections(body) {
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of (body || "").trim().split("\n")) {
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
  return { preamble: preamble.join("\n").trim(), sections };
}

/**
 * A section's items: its bullet entries, marker stripped and continuation
 * lines folded in, and any `####` sub-heading grouping them.
 *
 * Returns null for a section that is not a bullet list under optional
 * sub-headings, which is the shape the AI path condenses one-for-one. Prose
 * before the first bullet is the case that matters: counting it as part of no
 * entry would drop it silently, and there is no count for the caller to check
 * it against.
 *
 * A sub-heading is carried through rather than condensed, and never reaches
 * the model. A large release groups its entries under `####` headings, and a
 * section is condensed on its own, so the model cannot see which entries a
 * heading spans and must not be asked to reproduce one. Treating a sub-heading
 * as unparseable instead is what made a release's whole AI path fall back:
 * `2026.803.0` and `2026.731.0` both group this way.
 */
export function sectionItems(lines) {
  const items = [];
  let open = false;
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (/^#{4,}\s+/.test(text)) {
      items.push({ kind: "heading", text });
      open = false;
    } else if (/^[-*]\s+/.test(text)) {
      items.push({ kind: "entry", text: text.replace(/^[-*]\s+/, "") });
      open = true;
    } else if (open) {
      items[items.length - 1].text += ` ${text}`;
    } else {
      return null;
    }
  }
  return items;
}

/** Just the entry texts of `sectionItems`, in order, or null on the same shapes. */
export function bulletEntries(lines) {
  const items = sectionItems(lines);
  return items && items.filter((i) => i.kind === "entry").map((i) => i.text);
}

/**
 * A section's items rendered back to markdown, each entry taking its published
 * text from `lines` by position.
 *
 * A null in `lines` is an entry lifted into a promotion, which prints under
 * that heading INSTEAD of here. A sub-heading left with nothing under it goes
 * with them, since a heading over no entries names an empty group.
 */
export function renderItems(items, lines) {
  const out = [];
  let at = -1;
  for (const item of items) {
    if (item.kind === "heading") {
      out.push(item);
      continue;
    }
    at += 1;
    if (lines[at] != null) out.push({ kind: "entry", text: lines[at] });
  }

  const parts = [];
  for (const [i, item] of out.entries()) {
    if (item.kind === "heading") {
      if (out[i + 1]?.kind === "entry") parts.push(item.text);
      continue;
    }
    const last = parts[parts.length - 1];
    if (last?.startsWith("- ")) parts[parts.length - 1] = `${last}\n- ${item.text}`;
    else parts.push(`- ${item.text}`);
  }
  return parts.join("\n\n");
}

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

  const { preamble, sections } = parseSections(body);

  // Recognized sections in taxonomy order, then the rest in source order.
  // Array#sort is stable, so the unrecognized tail keeps the order it was
  // written in rather than being shuffled by a tie.
  const rank = (s) => {
    const at = NOTES_SECTIONS.findIndex(([from]) => from === s.heading);
    return at === -1 ? NOTES_SECTIONS.length : at;
  };
  const parts = [preamble];
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

/**
 * Where to install this version, closing every release body.
 *
 * A GitHub release page offers a `.vsix` asset and nothing else: it is the
 * worst of the three ways to install and the only one the page shows, because
 * it does not update itself, so a reader who takes it has opted out of every
 * later release without being told. Naming the registries in the body is what
 * puts the maintained paths in front of that reader at all.
 *
 * Both are stated unconditionally because the release publishes to both from
 * one artifact. If a registry is ever dropped, this line is part of dropping
 * it — a link here that no longer resolves is worse than no link.
 */
export const INSTALL_LINKS =
  "Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=BirtaLabs.birta-writer)" +
  " or [Open VSX](https://open-vsx.org/extension/BirtaLabs/birta-writer).";

/**
 * Condense ONE changelog section, and nothing else.
 *
 * The model is never asked where an entry belongs. It receives the entries of
 * a single section and returns one line for each, in the order given; the
 * caller puts them under the heading NOTES_SECTIONS already decided. Placement
 * is therefore structural, and the model keeps the job it is actually good at,
 * which is turning a paragraph into a line.
 *
 * It does see two headings, and neither is a placement decision. The section's
 * own name is context for the rewrite, and a promotion names its destination
 * because choosing WHICH entries lead is the one judgement delegated here. The
 * choice is still bounded structurally: `validateSection` enforces the
 * promotion's min and max against the answer.
 *
 * Asking for the whole document in one call is what published v2026.813.0 with
 * four `Fixed` entries under `Improved`: the mapping was stated in this prompt
 * and stated correctly, and a prompt is an instruction rather than a
 * constraint.
 *
 * The commit log is deliberately not source material here. The changelog entry
 * is authoritative and already user-framed, so a second, developer-framed
 * account of the same change can only invite invention.
 */
export const SECTION_PROMPT = (heading, entries, promotion) => `You are condensing the CHANGELOG entries of one release section into end-user release notes for Birta Writer, a WYSIWYG Markdown editor extension for VS Code, in the style of https://cursor.com/changelog.

Below are the ${entries.length} \`${heading}\` entries of this release, numbered. Rewrite each as ONE line.

Rules:
- Matter-of-fact tone. State the capability and why it matters. No marketing adjectives ("powerful", "seamless", "delightful"), no exclamation marks.
- Keep the entry's own claim and its scope. Never state a capability the entry does not, and never widen or narrow one it does. Keep any clause saying what was NOT affected: a reader scans that to decide whether to act.
- Lead with what the user gets, then the single qualification that matters most. The line replaces a paragraph, so most of the paragraph goes.
- Reproduce setting keys, command names and key chords exactly as written, keeping their backticks.
- Exactly one line per entry, in the order given. Never merge two entries, split one, or leave one out.${
  promotion
    ? `
- Also choose ${promotion.choose} for a \`${promotion.heading}\` section that opens the notes, and describe each of those more fully: a short title of a few words, then one or two plain sentences. A chosen entry belongs to that section INSTEAD of its own, so still write its one line above.`
    : ""
}

Reply with JSON and nothing else. No prose, no code fence.
{"lines": [${entries.length} strings, one per entry, in order]${
  promotion ? `, "promoted": [{"entry": <the entry's number>, "title": "...", "summary": "..."}]` : ""
}}

Entries:
${entries.map((e, i) => `${i + 1}. ${e}`).join("\n\n")}`;

/** The model's reply, as JSON, tolerating a code fence it was asked not to use. */
function parseReply(text) {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(body);
}

/**
 * A validated {lines, promoted} for one section, or null.
 *
 * The count check is the guard that makes this path safe to publish: a reply
 * holding a different number of lines than the section had entries has either
 * merged, split or dropped an entry, and there is no way to tell which. A
 * rejection costs a retry and then the deterministic path, never the release.
 * Publishing notes that contradict the CHANGELOG is the failure to avoid;
 * blocking a release on a model being reachable, or being well behaved, is not
 * an improvement on it.
 *
 * What this cannot check is whether line 3 describes entry 3. Order is asked
 * for and assumed.
 */
export function validateSection(reply, entries, promotion) {
  const bad = (why) => {
    console.error(`Release-notes reply rejected: ${why}.`);
    return null;
  };
  const lines = reply?.lines;
  if (!Array.isArray(lines)) return bad("no lines array");
  if (lines.length !== entries.length)
    return bad(`${lines.length} lines for ${entries.length} entries`);
  if (lines.some((l) => typeof l !== "string" || !l.trim() || l.includes("\n")))
    return bad("a line is empty, not a string, or not one line");

  const promoted = reply?.promoted ?? [];
  if (!promotion) return { lines, promoted: [] };
  if (!Array.isArray(promoted)) return bad("promoted is not an array");
  if (promoted.length < promotion.min || promoted.length > promotion.max)
    return bad(`${promoted.length} promoted into ${promotion.heading}`);
  const seen = new Set();
  for (const p of promoted) {
    if (!Number.isInteger(p?.entry) || p.entry < 1 || p.entry > entries.length)
      return bad(`promoted entry ${p?.entry} is not one of 1..${entries.length}`);
    if (seen.has(p.entry)) return bad(`entry ${p.entry} promoted twice`);
    seen.add(p.entry);
    if (typeof p.title !== "string" || !p.title.trim()) return bad("a promoted entry has no title");
    if (typeof p.summary !== "string" || !p.summary.trim())
      return bad("a promoted entry has no summary");
  }
  return { lines, promoted };
}

/**
 * A degradation the release job must be able to SEE.
 *
 * Nothing here ever fails a release over its notes, so every fallback is a
 * message in a green run. `::warning` is what puts one in the run summary
 * rather than only in the log body, where the notes silently reverting to the
 * raw changelog looks exactly like success.
 */
function warn(reason) {
  console.error(`::warning title=Release notes::AI path abandoned, published the fallback: ${reason}`);
}

async function ask(prompt) {
  const res = await fetch(`${apiBase()}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
    // One call per section, sequentially, so a wedged endpoint stalls the
    // release job for the sum of their timeouts rather than one of them.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * Sections published as the changelog wrote them, never condensed.
 *
 * `Security` is written to a standard the rest of the changelog is not: say
 * what an attacker could and could not do, then stop, and never inflate or
 * deflate (AGENTS.md). A reader scans it to decide whether to act, and the
 * sentence saying what was NOT exposed is half of that decision. Condensing a
 * paragraph to a line is exactly the operation that loses a qualifier, so this
 * section does not go to the model at all. Its entries then read longer than
 * the notes around them, which is the correct emphasis rather than a lapse.
 */
export const VERBATIM = new Set(["Security"]);

/**
 * One section's condensed lines, retried once, or null.
 *
 * The retry is the whole reason this is a function. A malformed reply is
 * usually a one-off, and without a second attempt a single stray code fence
 * costs the release its condensed notes entirely. Two attempts and no more:
 * past that it is not a slip, and the deterministic path is right there.
 */
async function condense(heading, entries, promotion) {
  const prompt = SECTION_PROMPT(heading, entries, promotion);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ok = validateSection(parseReply(await ask(prompt)), entries, promotion);
      if (ok) return ok;
    } catch (err) {
      console.error(`Release-notes section "${heading}" attempt ${attempt} failed: ${err}`);
    }
  }
  console.error(`Release-notes section "${heading}" did not survive two attempts.`);
  return null;
}

/**
 * Assemble validated per-section replies into the notes body.
 *
 * Emission order is NOTES_ORDER, then any heading the taxonomy does not know,
 * in the order the changelog wrote it. An unknown heading is carried under its
 * own name for the same reason the fallback carries it: silent dropping is the
 * defect both paths exist to avoid.
 */
export function assembleNotes(preamble, built) {
  const known = NOTES_ORDER.filter((h) => built.has(h));
  const rest = [...built.keys()].filter((h) => !NOTES_ORDER.includes(h));
  const parts = [preamble];
  for (const heading of [...known, ...rest]) parts.push(`### ${heading}\n\n${built.get(heading)}`);
  return parts.filter(Boolean).join("\n\n") || null;
}

/**
 * The AI path: one call per changelog section, reassembled by the table.
 *
 * Any section that fails abandons the whole path rather than half of it. A body
 * mixing condensed lines with untouched changelog paragraphs would read as an
 * editorial choice nobody made.
 */
export async function aiNotes(changelog) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { preamble, sections } = parseSections(changelog);
  if (!sections.length) return null;

  const built = new Map();
  const push = (heading, text) =>
    built.set(heading, built.has(heading) ? `${built.get(heading)}\n\n${text}` : text);

  try {
    for (const section of sections) {
      const items = sectionItems(section.lines);
      if (!items) {
        warn(`section "${section.heading}" is not a bullet list`);
        return null;
      }
      const entries = items.filter((i) => i.kind === "entry").map((i) => i.text);
      if (!entries.length) continue;

      const mapped = NOTES_SECTIONS.find(([from]) => from === section.heading)?.[1] ?? section.heading;

      if (VERBATIM.has(section.heading)) {
        push(mapped, renderItems(items, entries));
        continue;
      }

      const promotion = Object.hasOwn(PROMOTIONS, section.heading)
        ? PROMOTIONS[section.heading]
        : undefined;
      const ok = await condense(section.heading, entries, promotion);
      if (!ok) {
        warn(`section "${section.heading}" was not condensed`);
        return null;
      }

      const lifted = new Set(ok.promoted.map((p) => p.entry));
      for (const p of ok.promoted) push(promotion.heading, `**${p.title}**\n${p.summary}`);
      const kept = renderItems(
        items,
        ok.lines.map((l, i) => (lifted.has(i + 1) ? null : l)),
      );
      if (kept) push(mapped, kept);
    }
  } catch (err) {
    warn(`generation failed: ${err}`);
    return null;
  }

  return assembleNotes(preamble, built);
}

// Guarded so the pure pieces above can be imported and tested without the
// module running git and writing to stdout on import (same shape as
// stamp-changelog.mjs).
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const list = commits();
  const changelog = releaseChangelog();
  const body = (await aiNotes(changelog)) ?? changelogNotes(changelog) ?? commitNotes(list);
  // Appended here rather than inside any one of the three body paths, so the
  // links survive the AI path failing over to either fallback. The release job
  // then appends the verification footer after this, which is the one thing
  // that belongs below it.
  const out = `## Birta Writer ${VERSION}\n\n${body}\n\n${INSTALL_LINKS}\n`;

  if (process.env.OUT) {
    writeFileSync(process.env.OUT, out);
    console.error(`Wrote release notes to ${process.env.OUT}`);
  } else {
    process.stdout.write(out);
  }
}
