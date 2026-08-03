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
#   4. HEAD is on a branch. A merge onto a detached HEAD moves no branch, so
#      the "merge" survives only in the reflog — success reported, target
#      untouched, the same shape as guard 1.
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
# Statuses: merged | conflict | merge_failed | gate_failed | dirty | refused |
#   empty. `conflict` means git produced conflicted paths and they are listed;
#   `merge_failed` means git refused without conflicts (an untracked file in the
#   way is the usual cause) and its message is in `reason` — the two need
#   different responses, which is why they are not one status.
#
# Exit: 0 merged | 1 conflict or merge_failed (both leave the tree untouched)
#       2 gate failed (reverted) | 3 refused or input error | 4 nothing to merge
#
# Canonical source: harlanlewis-skills/tools/lane-scripts/, exercised by its
# test.sh in CI. Copies under a repo's .claude/skills/grind/scripts/ are
# vendored on purpose — an agent skill has to be self-contained, and the plugin
# cache path is $HOME-absolute and content-hashed, so pointing at it would rot
# on the next plugin update. Edit HERE and re-sync (tools/lane-scripts/sync.sh);
# a fix made in a vendored copy reaches one repo only. Measured: three of these
# four scripts were already stale in a sibling repo within an hour of shipping.

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

# --- Guard 4: HEAD is on a branch --------------------------------------------
# A merge onto a detached HEAD succeeds, prints nothing unusual, and moves no
# branch: the integration branch stays where it was and the merge is reachable
# only from the reflog once anything checks out. That is the same failure shape
# as merging from inside a worktree (Guard 1) — success reported, target
# untouched — so it is refused the same way. Measured before adding this: with
# a detached HEAD the script returned `{"status":"merged","into":"HEAD"}` while
# main did not move.
git symbolic-ref -q HEAD >/dev/null || emit "refused" 3 "Refusing to merge: HEAD is detached, so a merge would move no branch and be reachable only from the reflog. Check out the integration branch (or pass --into <branch>) first."

COMMITS=$(git rev-list --count "HEAD..$BRANCH")
FILES_JSON=$(git diff --name-only "HEAD...$BRANCH" | jq -R . | jq -s .)

# A lane that committed nothing is a report to re-read, not a merge to run.
if [ "$COMMITS" -eq 0 ]; then
  emit "empty" 4 "$BRANCH has no commits ahead of $INTO. The lane reported work it did not commit — re-read its handoff before believing it shipped."
fi

PRE_MERGE_SHA=$(git rev-parse HEAD)

# Not every failed merge is a conflict, and the difference decides what the
# agent should do next. git also refuses a merge that would clobber an untracked
# file — the very case Guard 2 leaves open on purpose — and that refusal
# produces NO conflicted paths. Reporting it as `conflict` handed the agent an
# empty `conflict_files` and told it to "resolve by hand" something with nothing
# to resolve, while git's own message (which names the file) was thrown away by
# `2>&1` into /dev/null. Keep git's stderr and classify on the conflict list.
set +e
merge_out=$(git merge --no-edit "$BRANCH" 2>&1)
merge_ec=$?
set -e
if [ $merge_ec -ne 0 ]; then
  CONFLICT_JSON=$(git diff --name-only --diff-filter=U | jq -R . | jq -s .)
  git merge --abort 2>/dev/null || true
  if [ "$(printf '%s' "$CONFLICT_JSON" | jq 'length')" -gt 0 ]; then
    emit "conflict" 1 "Merge aborted. Resolve by hand (both sides are yours), or rebrief the lane to sync and finish it. Either way this is a lane-plan finding: say which prediction was wrong and rebrief every queued lane sharing these files."
  fi
  emit "merge_failed" 1 "git refused the merge and produced no conflicts, so there is nothing to resolve by hand — read its message and clear what it names (an untracked file in the way is the common one; it was left intact). Nothing in the tree was changed. git said: $(printf '%s' "$merge_out" | tail -c 1000)"
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
