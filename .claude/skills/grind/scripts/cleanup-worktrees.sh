#!/usr/bin/env bash
# Remove this session's agent worktrees once their lanes have merged.
#
# The two rules that matter are enforced here rather than remembered: never
# remove a worktree whose agent is still running (its commits would land on a
# branch you just deleted), and never remove the one your own shell is inside.
#
# Usage:
#   cleanup-worktrees.sh [--preserve <id,id,...>] [--delete-branches]
#                        [--force-branches] [--dry-run]
#
#   --preserve         Agent ids or worktree directory names still running.
#                      Accepts "agent-abc123" or bare "abc123".
#   --delete-branches  Also delete merged worktree-agent-* branches (git
#                      branch -d, which refuses unmerged work — that refusal is
#                      the point, not an obstacle).
#   --force-branches   Escalate a refused delete to -D. Only after confirming
#                      the commits are on main; squash-merges leave branches
#                      looking unmerged to git.
#   --dry-run          Report what would happen; change nothing.
#
# Requires: git, jq. Written for bash 3.2 (macOS /bin/bash) — no associative
# arrays.
#
# Output: one JSON object on stdout.
#   { worktrees_removed[], preserved[], skipped[], branches_deleted[],
#     branches_kept[], errors[], dry_run }
#
# Exit: 0 complete (even with nothing to do) | 1 completed with errors
#       3 refused (running from inside a worktree) or input error
#
# Canonical source: harlanlewis-skills/tools/lane-scripts/, exercised by its
# test.sh in CI. Copies under a repo's .claude/skills/grind/scripts/ are
# vendored on purpose — an agent skill has to be self-contained, and the plugin
# cache path is $HOME-absolute and content-hashed, so pointing at it would rot
# on the next plugin update. Edit HERE and re-sync (tools/lane-scripts/sync.sh);
# a fix made in a vendored copy reaches one repo only. Measured: three of these
# four scripts were already stale in a sibling repo within an hour of shipping.

set -euo pipefail

PRESERVE=""
DELETE_BRANCHES=false
FORCE_BRANCHES=false
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --preserve)        PRESERVE="${2:-}"; shift 2 ;;
    --delete-branches) DELETE_BRANCHES=true; shift ;;
    --force-branches)  FORCE_BRANCHES=true; shift ;;
    --dry-run)         DRY_RUN=true; shift ;;
    -h|--help)         sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 3 ;;
  esac
done

git_dir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null || echo "")
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
[ -n "$git_dir" ] || { echo "Not a git repository." >&2; exit 3; }
if [ "$git_dir" != "$common_dir" ]; then
  echo "Refusing to clean up from inside a linked worktree. cd to $(dirname "$common_dir") first." >&2
  exit 3
fi

repo_root=$(dirname "$common_dir")
cd "$repo_root"
cwd_real=$(pwd -P)
repo_root_real="$cwd_real"

is_preserved() { # is_preserved <worktree-dir-name>
  name="$1"
  bare="${name#agent-}"
  printf '%s' ",$PRESERVE," | tr -d '[:space:]' | grep -q ",$name," && return 0
  printf '%s' ",$PRESERVE," | tr -d '[:space:]' | grep -q ",$bare," && return 0
  return 1
}

removed="[]"; preserved="[]"; deleted="[]"; kept="[]"; skipped="[]"; errors="[]"
push() { printf '%s' "$1" | jq --arg v "$2" '. + [$v]'; }

git worktree prune 2>/dev/null || true

# Enumerate from git, not from a glob of .claude/worktrees/.
#
# Where the harness puts a worktree is not ours to assume — anthropics/
# claude-code#49986 reports Claude Desktop hardcoding its own path — and a glob
# that misses one reports `worktrees_removed: []` with no errors, which reads
# exactly like "nothing to clean". Measured: with an `agent-*` worktree
# registered outside `.claude/worktrees/`, the glob form saw only the inside
# one and exited 0. `git worktree list` knows every one of them, wherever it
# lives. Selection is still by the `agent-*` directory name, so a worktree of
# your own is never a candidate.
worktree_paths=$(git worktree list --porcelain | sed -n 's/^worktree //p')

while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  [ -d "$wt" ] || continue
  name=$(basename "$wt")
  # Report what was considered and passed over, rather than passing over it in
  # silence. Enumerating from git fixed *location* blindness; selection is still
  # by the `agent-*` name, so a worktree the harness names differently is still
  # skipped — and the old output said only `worktrees_removed: []`, which reads
  # as "nothing to clean" rather than "I did not look at that one". Measured: a
  # `claude-abc123` worktree was invisible in the output, with no errors.
  case "$name" in agent-*) : ;; *) skipped=$(push "$skipped" "$wt (not an agent-* worktree)"); continue ;; esac
  # Never the main checkout, whatever it happens to be named.
  [ "$(cd "$wt" && pwd -P)" != "$repo_root_real" ] || { skipped=$(push "$skipped" "$wt (the main checkout)"); continue; }

  if is_preserved "$name"; then
    preserved=$(push "$preserved" "$wt")
    continue
  fi

  wt_real=$(cd "$wt" 2>/dev/null && pwd -P) || { errors=$(push "$errors" "Cannot resolve $wt"); continue; }
  case "$cwd_real" in
    "$wt_real"|"$wt_real"/*)
      errors=$(push "$errors" "Skipped $wt: your shell is inside it")
      continue ;;
  esac

  if $DRY_RUN; then
    removed=$(push "$removed" "$wt")
    continue
  fi

  if git worktree remove "$wt" >/dev/null 2>&1; then
    removed=$(push "$removed" "$wt")
  elif [ -n "$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    # `git worktree remove` refuses a worktree with uncommitted changes, and
    # that refusal is the point — the same reasoning as --force-branches above.
    # Escalating to `rm -rf` here would silently destroy a lane's unmerged
    # work, and report it as "(forced)" success. Surface it instead; the fix is
    # to commit the lane or remove it by hand once you have looked at it.
    errors=$(push "$errors" "Kept $wt: it has uncommitted changes. Commit the lane (or remove it by hand) — refusing to rm -rf unmerged work.")
  elif rm -rf "$wt" 2>/dev/null; then
    removed=$(push "$removed" "$wt (forced)")
  else
    errors=$(push "$errors" "Failed to remove $wt")
  fi
done <<EOF
$worktree_paths
EOF

$DRY_RUN || git worktree prune 2>/dev/null || true

if $DELETE_BRANCHES; then
  for branch in $(git branch --list 'worktree-agent-*' --format='%(refname:short)'); do
    name="${branch#worktree-}"
    if is_preserved "$name"; then
      kept=$(push "$kept" "$branch (agent still running)")
      continue
    fi
    if $DRY_RUN; then
      kept=$(push "$kept" "$branch (dry run — would delete)")
      continue
    fi
    if git branch -d "$branch" >/dev/null 2>&1; then
      deleted=$(push "$deleted" "$branch")
    elif $FORCE_BRANCHES && git branch -D "$branch" >/dev/null 2>&1; then
      deleted=$(push "$deleted" "$branch (forced)")
    else
      kept=$(push "$kept" "$branch (unmerged — verify its commits are on main before forcing)")
    fi
  done
fi

jq -n \
  --argjson removed "$removed" --argjson preserved "$preserved" \
  --argjson deleted "$deleted" --argjson kept "$kept" \
  --argjson skipped "$skipped" \
  --argjson errors "$errors" --argjson dry "$DRY_RUN" \
  '{worktrees_removed: $removed, preserved: $preserved, skipped: $skipped,
    branches_deleted: $deleted, branches_kept: $kept,
    errors: $errors, dry_run: $dry}'

[ "$(printf '%s' "$errors" | jq 'length')" -gt 0 ] && exit 1
exit 0
