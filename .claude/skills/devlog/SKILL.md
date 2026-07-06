---
name: devlog
description: Record a known bug or feature request as a Linear issue; triggers: record a bug, known bug, feature request, record a feature request, /devlog
version: 2.0.0
---
# Devlog — Linear issue recording skill

## Purpose

File two kinds of entries as Linear issues (team: **Markdown Editor**, `MAR-` prefix), using the Linear MCP tools (`mcp__claude_ai_Linear__save_issue` etc. — load via ToolSearch if deferred):

1. **Known Bug**: a bug left unfixed this session, or a pre-existing one (do not record bugs already fixed during development).
2. **Feature Request**: a planned feature that has not been started yet.

Issue tracking lives ONLY in Linear. Never create GitHub issues for this project.

***

## Step 1: Confirm the entry type

Ask with AskUserQuestion:

- Known Bug (unfixed)
- Feature Request
- Both

***

## Step 2A: Record a Known Bug

### Collect information (AskUserQuestion)

Ask all at once:

1. **Title**: a one-line description of the symptom (the issue title)
2. **Details**: reproduction steps, expected behavior, actual behavior
3. **Root cause** (optional): the known root cause; write "to be investigated" if unknown
4. **Severity**: High (feature unusable) / Medium (degrades the experience) / Low (minor defect)

### Create the issue

Call `save_issue` with:

- `team`: `Markdown Editor`
- `title`: the symptom, no prefix (Linear labels replace the `[Bug]` convention)
- `labels`: `["#Bug"]`, plus the matching `phase-*` label when one clearly applies
- `priority`: 2 (High) / 3 (Medium) / 4 (Low), mapped from severity
- `state`: `Backlog`
- `description` (Markdown):

```markdown
## Problem description

<details>

## Reproduction steps

<steps, or N/A if unknown>

## Root cause analysis

<root cause, or N/A if still to be investigated>
```

***

## Step 2B: Record a Feature Request

### Collect information (AskUserQuestion)

Ask for the following fields:

1. **Feature title**: a one-line summary (the issue title)
2. **Problem it solves**: the user scenario / pain point
3. **Desired outcome**: the user's experience once the feature ships
4. **Maturity**: 0–100% (0% = idea only; 50% = partially implemented)
5. **Priority**: High / Medium / Low
6. **Implementation approach** (optional): the technical points involved and a rough plan
7. **Affected files** (optional): the files expected to change

### Create the issue

Call `save_issue` with:

- `team`: `Markdown Editor`
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

<rough plan and technical points, N/A if none yet>

## Affected files

<expected list of files to change, N/A if not yet clear>
```

***

## Label reference (team: Markdown Editor)

- `#Bug` — defects, incorrect behavior
- `#Improvement` — new functionality, enhancements
- `#Chore` — maintenance, tooling, process
- `phase-0-fidelity` — round-trip fidelity & trust (existential)
- `phase-1-vscode-parity` — restore native VS Code capabilities in the webview
- `phase-2-syntax` — markdown syntax coverage
- `phase-3-interaction` — interaction patterns that make the editor preferred
- `phase-4-differentiators` — ambitious power-user differentiators

Use existing labels only; do not create new ones without asking.

***

## Step 3: Report the result

After the issue is created, print its identifier and URL so the user can click through:

```
✅ Created MAR-XX: https://linear.app/harlan/issue/MAR-XX
```

If several issues are created, list every URL.

***

## Notes

- If the user's information is insufficient, proactively follow up so the issue has enough context.
- Do not modify any local files; planned work lives only in Linear.
- Check for duplicates first with `list_issues` (team: Markdown Editor) before creating.
