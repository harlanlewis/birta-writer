#!/usr/bin/env bash
# Merge one lane branch into the session's integration branch, with the guards
# /grind's SKILL.md § 6 requires. These live in code rather than prose because
# the first two are exactly the checks an agent skips when it is mid-flow and
# a completion notification has just arrived.
#
# Usage:
#   merge-lane.sh --branch <lane-branch> [--into <integration-branch>]
#                 [--gate "<command>"] [--ticket <id>]
#
# Guards, in order — each refuses rather than proceeding:
#   1. Not inside a linked worktree. A merge run from inside one merges into
#      THAT worktree's branch, reports success, and leaves the integration
#      branch untouched. Detected structurally (git-dir != git-common-dir), so
#      it holds wherever the worktree lives, not just under .claude/worktrees/.
#   2. Clean working tree. An arriving lane must never be merged on top of your
#      own uncommitted edits — that is how a lane's changes end up inside your
#      commit or lost in a conflict resolution.
#   3. The lane branch exists and carries commits.
#
# If --gate is given, it runs after the merge; a failing gate reverts to the
# exact pre-merge SHA (not HEAD~N, which is wrong for a merge commit).
#
# Requires: git, jq.
#
# Output: one JSON object on stdout.
#   { status, branch, into, commits, files[], conflict_files[],
#     pre_merge_sha, merged_sha, gate_output, reason }
#
# Exit: 0 merged | 1 conflict (aborted) | 2 gate failed (reverted)
#       3 refused or input error | 4 nothing to merge

set -euo pipefail

BRANCH=""
INTO=""
GATE=""
TICKET=""

emit() { # emit <status> <exit> [reason]
  jq -n \
    --arg status "$1" \
    --arg branch "$BRANCH" \
    --arg into "$INTO" \
    --arg ticket "$TICKET" \
    --arg pre "${PRE_MERGE_SHA:-}" \
    --arg merged "${MERGED_SHA:-}" \
    --arg gate_output "${GATE_OUTPUT:-}" \
    --arg reason "${3:-}" \
    --argjson commits "${COMMITS:-0}" \
    --argjson files "${FILES_JSON:-[]}" \
    --argjson conflict_files "${CONFLICT_JSON:-[]}" \
    '{status: $status, branch: $branch, into: $into, ticket: $ticket,
      commits: $commits, files: $files, conflict_files: $conflict_files,
      pre_merge_sha: $pre, merged_sha: $merged,
      gate_output: $gate_output, reason: $reason}'
  exit "$2"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --into)   INTO="${2:-}"; shift 2 ;;
    --gate)   GATE="${2:-}"; shift 2 ;;
    --ticket) TICKET="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) BRANCH="$BRANCH"; emit "refused" 3 "Unknown argument: $1" ;;
  esac
done

[ -n "$BRANCH" ] || emit "refused" 3 "Missing --branch. Usage: merge-lane.sh --branch <lane-branch> [--into <branch>] [--gate \"<cmd>\"]"

# --- Guard 1: refuse to run from inside a linked worktree ---------------------
git_dir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null || echo "")
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
[ -n "$git_dir" ] || emit "refused" 3 "Not a git repository."
if [ "$git_dir" != "$common_dir" ]; then
  emit "refused" 3 "Refusing to merge: this is a linked worktree ($git_dir). Merging here would merge into the worktree's own branch, report success, and leave the integration branch untouched. cd to $(dirname "$common_dir") first."
fi

# --- Guard 2: no uncommitted TRACKED changes ---------------------------------
# `--untracked-files=no` on purpose. The hazard this guard names is your own
# edits being attributed to a merge commit or lost in a conflict resolution,
# and only tracked changes can do that. Counting untracked files instead made
# the guard refuse over a scratch note or a probe script — measured: it refused
# over its OWN untracked copy in the test repo — and a guard that fires
# spuriously is one the next agent works around. The single hazard untracked
# files do pose is covered upstream: git refuses a merge that would overwrite
# one ("The following untracked working tree files would be overwritten"),
# leaving the file intact. Verified before relaxing this, not assumed.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  emit "dirty" 3 "Refusing to merge: the working tree has uncommitted changes. Commit your own lane (or stash deliberately) first — merging onto a dirty tree is how a lane's changes get attributed to your commit or lost in a conflict resolution."
fi

# --- Guard 3: the lane branch exists -----------------------------------------
git rev-parse --verify --quiet "$BRANCH" >/dev/null || emit "refused" 3 "Branch not found: $BRANCH"

# --- Switch to the integration branch ----------------------------------------
if [ -n "$INTO" ]; then
  current=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current" != "$INTO" ]; then
    git checkout "$INTO" >/dev/null 2>&1 || emit "refused" 3 "Cannot check out --into branch: $INTO"
  fi
else
  INTO=$(git rev-parse --abbrev-ref HEAD)
fi

COMMITS=$(git rev-list --count "HEAD..$BRANCH")
FILES_JSON=$(git diff --name-only "HEAD...$BRANCH" | jq -R . | jq -s .)

# A lane that committed nothing is a report to re-read, not a merge to run.
if [ "$COMMITS" -eq 0 ]; then
  emit "empty" 4 "$BRANCH has no commits ahead of $INTO. The lane reported work it did not commit — re-read its handoff before believing it shipped."
fi

PRE_MERGE_SHA=$(git rev-parse HEAD)

if ! git merge --no-edit "$BRANCH" >/dev/null 2>&1; then
  CONFLICT_JSON=$(git diff --name-only --diff-filter=U | jq -R . | jq -s .)
  git merge --abort 2>/dev/null || true
  emit "conflict" 1 "Merge aborted. Resolve by hand (both sides are yours), or rebrief the lane to sync and finish it. Either way this is a lane-plan finding: say which prediction was wrong and rebrief every queued lane sharing these files."
fi

MERGED_SHA=$(git rev-parse HEAD)

# --- Optional gate, reverting to the exact pre-merge SHA on failure -----------
if [ -n "$GATE" ]; then
  set +e
  gate_raw=$(eval "$GATE" 2>&1)
  gate_ec=$?
  set -e
  GATE_OUTPUT=$(printf '%s' "$gate_raw" | tail -c 4000)
  if [ $gate_ec -ne 0 ]; then
    git reset --hard "$PRE_MERGE_SHA" >/dev/null 2>&1
    MERGED_SHA=""
    emit "gate_failed" 2 "Gate failed (exit $gate_ec); merge reverted to $PRE_MERGE_SHA. The failure belongs to this lane — rebrief it with the output rather than patching over it here."
  fi
fi

emit "merged" 0 ""
