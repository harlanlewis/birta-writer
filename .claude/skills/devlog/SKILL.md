---
name: devlog
description: Record, close, update, or audit Linear issues; triggers: record a bug, known bug, feature request, record a feature request, close an issue, audit the backlog, /devlog
version: 3.2.0
---
# Devlog: Linear issue lifecycle skill

## Purpose

Manage the full lifecycle of Linear issues (team: Birta Writer, `MAR-` prefix), using the Linear MCP tools (`mcp__claude_ai_Linear__save_issue`, `save_comment`, `get_issue`, `list_issues` etc., loaded via ToolSearch if deferred):

1. File: a Known Bug (a bug left unfixed this session, or pre-existing; never record bugs already fixed during development) or a Feature Request (planned work not yet started).
2. Close / update: move a shipped issue to `Done`, or re-scope one the code has outgrown.
3. Audit: reconcile the backlog against the CHANGELOG and git history, closing what's shipped and re-scoping stale tickets.

Issue tracking lives ONLY in Linear. Never create GitHub issues for this project.

***

## Step 1: Confirm the action

Ask with AskUserQuestion (skip if the user's request already makes the action unambiguous):

- File → Known Bug (unfixed)
- File → Feature Request
- File → Both
- Close / update an existing issue → § Closing & updating
- Audit the backlog → § Auditing the backlog

***

## Step 2A: Record a Known Bug

### Collect information (AskUserQuestion)

Ask all at once:

1. Title: a one-line description of the symptom (the issue title)
2. Details: reproduction steps, expected behavior, actual behavior
3. Root cause (optional): the cause and how you know it. Name the observation that established it. If you haven't established it, say `Hypothesis (unverified)` and give the one check that would confirm or kill it. A guess labelled as a guess is useful; a guess labelled as a finding is a trap.
4. Severity: High (feature unusable) / Medium (degrades the experience) / Low (minor defect)

### Create the issue

Call `save_issue` with:

- `team`: `Birta Writer`
- `title`: the symptom, no prefix (Linear labels replace the `[Bug]` convention)
- `labels`: `["#Bug"]`, plus the matching `phase-*` label when one clearly applies
- `priority`: 2 (High) / 3 (Medium) / 4 (Low), mapped from severity
- `state`: `Backlog`
- `description` (Markdown):

```markdown
## Problem description

<the symptom, as observed behavior>

## Reproduction steps

<steps, plus the OBSERVED output pasted verbatim — not the expected one.
 If it wasn't reproduced this session, write "Not reproduced — <why>" and
 say what evidence the report rests on instead.>

## Root cause analysis

<the cause AND the observation that established it. If it wasn't
 established, open with "Hypothesis (unverified):" and name the single
 check that would confirm or kill it — that check is the first thing the
 fixer should run. "N/A — to be investigated" is fine; a confident-sounding
 guess is not.>
```

***

## Step 2B: Record a Feature Request

### Collect information (AskUserQuestion)

Ask for the following fields:

1. Feature title: a one-line summary (the issue title)
2. Problem it solves: the user scenario / pain point
3. Desired outcome: the user's experience once the feature ships
4. Maturity: 0–100% (0% = idea only; 50% = partially implemented)
5. Priority: High / Medium / Low
6. Implementation approach (optional): the technical points involved and a rough plan
7. Affected files (optional): the files expected to change

### Create the issue

Call `save_issue` with:

- `team`: `Birta Writer`
- `title`: the feature summary, no prefix
- `labels`: `["#Improvement"]`, plus the matching `phase-*` label when one clearly applies
- `priority`: 2 (High) / 3 (Medium) / 4 (Low)
- `state`: `Backlog`
- `description` (Markdown):

```markdown
## Problem / scenario

<the problem it solves, the user pain point>

## Desired outcome

<the user experience once the feature ships>

## Maturity

<0% (idea only) / X% (partially implemented)>

## Implementation approach

<rough plan and technical points — a HYPOTHESIS unless you have actually
 tried it. Label anything untried, so a later session takes it as a
 starting point rather than a decision already made. N/A if none yet.>

## Affected files

<expected list of files to change, N/A if not yet clear>
```

***

## Evidence discipline: what makes a ticket safe to act on

A ticket is read weeks later by someone who has only the ticket. Everything in it is treated as established unless it says otherwise, so the filer's real job is marking which parts were *observed* and which were *believed*. Get this wrong and the cost lands on a future session, compounded: work built on a false cause looks correct and passes its own tests.

- Symptom and cause have different reliabilities, so label them separately. A sweep can be rigorous about *what* breaks and wrong about *why*, because the symptom was run and the cause was reasoned. (2026-07-25: one careful fidelity/performance audit filed six tickets. Every reproduction held up under later scrutiny; three causes were false. MAR-214 blamed round-trip protection for a `<br />` cell it never protected; MAR-219 described two refractor instances that are one object (`bare === core`); MAR-215's headline "91%" was 91% of a plugin-apply slice and 18% of dispatch. All three were fixed anyway, but each cost a session's detour first.)
- Never file a reproduction you haven't run. Paste the observed output, not the expected one; they diverge exactly when it matters. If it can't be reproduced in-session, write that in the ticket rather than filing the claim as fact.
- A number needs its denominator, its source, and its date. A ratio without a denominator is not a measurement ("91%" of what?), and a figure copied from a committed baseline is a *record*, not a reading: `e2e/perf/bundle-baseline.json` had drifted 62,824 B behind `main`, so a ticket's "only 34 KB of headroom" was quoted in good faith and wrong by 3×. Say what was measured, against what, and when, or omit the number.
- A prescribed fix is a hypothesis; mark it as one. A section headed "Fix, and why the obvious one is wrong" reads as settled engineering even when nobody tried it. Label an untried approach. (MAR-219's prescribed fix was in fact correct; its stated *reason* was not, so the fix survived and the justification had to be retracted.)
- Findings filed as a batch inherit the batch's blind spot. If a sweep produced ten tickets and you verified two, the other eight are unverified, so mark that in each ticket, not once in a summary nobody will read alongside the ticket.

The cheap version of all of this: before saving, reread the description and ask *which sentence here would a reader act on that I did not actually check?* Then either check it or label it.

***

## Label reference (team: Birta Writer)

- `#Bug`: defects, incorrect behavior
- `#Improvement`: new functionality, enhancements
- `#Chore`: maintenance, tooling, process
- `phase-0-fidelity`: round-trip fidelity & trust (existential)
- `phase-1-vscode-parity`: restore native VS Code capabilities in the webview (largely retired, shipped in 0.2.3)
- `phase-2-syntax`: markdown syntax coverage
- `phase-3-interaction`: interaction patterns that make the editor preferred
- `phase-4-differentiators`: ambitious power-user differentiators

Use existing labels only; do not create new ones without asking.

***

## Closing & updating

Filing is only half the loop. When work ships or a ticket drifts out of date, keep the backlog honest.

### Verify before you close: the code, not the CHANGELOG alone

A feature can ship with a different implementation than the ticket described (e.g. MAR-26 shipped a self-contained offline spell checker, not the "forward cSpell diagnostics" the ticket sketched). Before closing:

1. `get_issue` for the full description and its acceptance criteria.
2. Confirm the behavior actually exists in the working tree. Grep for the settings, plugin or files it promised, and check the CHANGELOG and `git log` for the shipping commit(s).
3. Only close on confirmation. If it's *partly* done, re-scope instead (below), don't close.

### Close a shipped issue

- `save_issue` with `id` and `state: "Done"`.
- `save_comment` (`issueId`) with a one-line completion note that cites the commit SHA(s) and the concrete evidence (settings keys, files, CHANGELOG entry). Note any divergence from the original plan.
- Never leave completed work in `In Progress` or `Backlog`. That was the MAR-34 failure mode (fully shipped, left In Progress).

### Re-scope a stale issue

When the code has outgrown a ticket's premise (e.g. MAR-35's three-zone design after the center zone was removed):

- `save_issue` with `id` and a rewritten `description` that opens with a dated `## Status: … — re-scoped <date>` note, states current reality (verified against named files/lines), and narrows the remaining work + acceptance criteria. Retain the original analysis at the bottom under a "for history" heading.
- `save_comment` summarizing what changed and why, citing the commit that made it stale.
- If a ticket is already correctly scoped to the remaining work, don't rewrite it; just add a confirmation comment that you verified it against current code.

### Correct a ticket whose premise turned out to be wrong

Fixing work is when a false cause finally surfaces, and the discovery dies with the session unless it's written down. Comment the correction on the ticket, even when you're closing it in the same breath, and state plainly which claim was wrong and what the evidence is.

This matters for two reasons beyond tidiness: the ticket is what a future reader trusts, and a wrong cause usually implies a wrong *fix direction* that someone will otherwise re-derive. (2026-07-25: MAR-214's "protection was the only thing preserving it" implied two candidate fixes, one of which (sub-line protection granularity) was substantial engine surgery. Once the premise was corrected, neither was needed. MAR-219's retraction similarly turned a claimed correctness fix into a bytes-only change, which is what the CHANGELOG then had to say.)

Do it whether the ticket's author was a previous session, an audit, or you.

***

## Auditing the backlog

Triggered by "audit the backlog", "what's next", or a completeness review. Goal: the open list reflects reality, and next work is obvious.

1. `list_issues` (team: Birta Writer) across `backlog`, `unstarted`, and `started` states.
2. Cross-check each against the CHANGELOG ("Unreleased" = shipped-but-untagged) and `git log`. Remember the two are complementary: the CHANGELOG lists shipped work (including untracked features), Linear lists planned work, so "not in Linear" never means "not shipped."
3. For anything that looks shipped, verify in code (above) before acting, then close or re-scope.
4. Report a prioritized "do next" using the `phase-*` spine (`phase-0-fidelity` first, because it's existential; then `2-syntax`, `3-interaction`, `4-differentiators`), ordered by `priority` within a phase, and honoring dependency/`blockedBy` links.
5. Summarize the net effect (X open → Y open, what closed, what re-scoped).

***

## Report the result

Print identifiers and URLs so the user can click through:

```
✅ Created  MAR-XX: https://linear.app/harlan/issue/MAR-XX
✅ Closed   MAR-YY: https://linear.app/harlan/issue/MAR-YY
♻️  Re-scoped MAR-ZZ: https://linear.app/harlan/issue/MAR-ZZ
```

If several issues are touched, list every one.

***

## Notes

- If the user's information is insufficient, proactively follow up so the issue has enough context.
- Autonomous sessions (e.g. `/grind`) must clear the filing bar before creating an issue (grind §3.6): a nameable user-observable symptom or demonstrated hazard, and a genuine reason it can't be done in-session (blocked on a user decision/design/upstream, or untouched territory). Fix-now beats filing; low-value findings are declined in the session report, not filed. A small-but-real item that genuinely can't be done now is an issue at `priority: Low`, never a line appended to a shared document: a checkbox in a document is a ticket with its tracking removed, and it goes unread for as long as it is carried. Never an omnibus "cleanups/follow-ups" ticket: one issue = one nameable outcome. Filing into `Backlog` is cheap for the filer and expensive for the queue.
- Filing planned work touches only Linear, so do not modify local files for it. Closing/auditing may read local files and git to verify, but still records outcomes only in Linear (plus the CHANGELOG when you also ship the feature).
- Check for duplicates first with `list_issues` (team: Birta Writer) before creating.
- Prefer batching independent Linear calls (multiple `save_issue` / `save_comment`) in one step.
