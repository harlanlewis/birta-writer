---
name: devlog
description: Record a known bug or feature request as a GitHub Issue; triggers: record a bug, known bug, feature request, record a feature request, /devlog
version: 1.0.0
---
# Devlog — GitHub Issue Recording Skill

## Purpose

File two kinds of entries as GitHub Issues (repository: `harlanlewis/markdown-writer`):

1. **Known Bug**: a bug left unfixed this session, or a pre-existing one (do not record bugs already fixed during development).
2. **Feature Request**: a planned feature that has not been started yet.

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

1. **Title**: a one-line description of the symptom (the Issue title)
2. **Details**: reproduction steps, expected behavior, actual behavior
3. **Root cause** (optional): the known root cause; write "to be investigated" if unknown
4. **Severity**: High (feature unusable) / Medium (degrades the experience) / Low (minor defect)

### Create the Issue

```bash
gh issue create \
  --repo harlanlewis/markdown-writer \
  --title "[Bug] <title>" \
  --label "bug,known-limitation" \
  --body "$(cat <<'EOF'
## Problem description

<details>

## Reproduction steps

<steps, or N/A if unknown>

## Root cause analysis

<root cause, or N/A if still to be investigated>

## Severity

<High / Medium / Low>

## Notes

> This Issue was created automatically by the `/devlog` skill to record a known but not-yet-fixed bug.
EOF
)"
```

**Label notes:**

- `bug`: built into GitHub, marks this as a bug
- `known-limitation`: custom, means known but not currently planned for a fix (confirm this label exists first, otherwise create it)

### Check for and create the custom label

Before running, check whether the `known-limitation` label exists:

```bash
gh label list --repo harlanlewis/markdown-writer | grep known-limitation
```

Create it if it does not exist:

```bash
gh label create "known-limitation" \
  --repo harlanlewis/markdown-writer \
  --description "A known but not-yet-fixed limitation or bug" \
  --color "FFA500"
```

***

## Step 2B: Record a Feature Request

### Collect information (AskUserQuestion)

Ask for the following fields:

1. **Feature title**: a one-line summary (the Issue title)
2. **Problem it solves**: the user scenario / pain point
3. **Desired outcome**: the user's experience once the feature ships
4. **Maturity**: 0–100% (0% = idea only; 50% = partially implemented)
5. **Priority**: High / Medium / Low
6. **Implementation approach** (optional): the technical points involved and a rough plan
7. **Affected files** (optional): the files expected to change

### Create the Issue

```bash
gh issue create \
  --repo harlanlewis/markdown-writer \
  --title "[Feature] <feature title>" \
  --label "enhancement,roadmap" \
  --body "$(cat <<'EOF'
## Problem / scenario

<the problem it solves, the user pain point>

## Desired outcome

<the user experience once the feature ships>

## Maturity

<0% (idea only) / X% (partially implemented)>

## Priority

<High / Medium / Low>

## Implementation approach

<rough plan and technical points, N/A if none yet>

## Affected files

<expected list of files to change, N/A if not yet clear>

## Notes

> This Issue was created automatically by the `/devlog` skill to record a planned feature request.
EOF
)"
```

**Label notes:**

- `enhancement`: built into GitHub, marks a feature request
- `roadmap`: custom, marks a planned feature on the roadmap (confirm it exists first, otherwise create it)

### Check for and create the custom label

```bash
gh label list --repo harlanlewis/markdown-writer | grep roadmap
```

Create it if it does not exist:

```bash
gh label create "roadmap" \
  --repo harlanlewis/markdown-writer \
  --description "A planned feature on the roadmap" \
  --color "0075CA"
```

***

## Step 3: Report the result

After the Issue is created successfully, print the Issue URL so the user can click through:

```
✅ Issue created: https://github.com/harlanlewis/markdown-writer/issues/XXX
```

If several Issues are created, list every URL.

***

## Notes

- Issue title prefixes: use `[Bug]` for bugs and `[Feature]` for requests, so they are easy to tell apart at a glance in the Issues list.
- Use the `gh` CLI; no browser interaction needed.
- If the user's information is insufficient, proactively follow up so the Issue has enough context.
- Do not modify any local files (neither devlog.md nor roadmap.md).
- For a Bug Issue with "High" severity, consider adding a `priority: high` label (if it exists).
