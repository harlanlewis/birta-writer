#!/usr/bin/env bash
# Verify that a dispatched lane agent actually got the worktree it was asked
# for — before you report it as isolated.
#
# Requesting `isolation: "worktree"` is not the same as receiving it. When
# creation loses the race the agent does not fail: it runs in the main checkout
# and reports success (anthropics/claude-code#80156). In #39886 the tell was
# `worktreePath: "done"` — a status string where a path belonged — with
# `worktreeBranch: undefined`.
#
# Usage:
#   check-isolation.sh --path <worktreePath> [--branch <worktreeBranch>]
#
# Pass the values verbatim from the Agent tool's result. Anything that is not
# an existing directory registered as a linked worktree fails.
#
# Requires: git, jq.
#
# Output: one JSON object on stdout.
#   { isolated, path, branch, registered, is_main_checkout, main_toplevel, reason }
#
# Exit: 0 isolated | 1 NOT isolated (the agent is in your checkout) | 3 input error

set -euo pipefail

WT_PATH=""
WT_BRANCH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --path)   WT_PATH="${2:-}"; shift 2 ;;
    --branch) WT_BRANCH="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 3 ;;
  esac
done

# `dirname "$var"`, never `| xargs dirname`: xargs splits on whitespace, so a
# repo path containing a space made this guard fail with a shell error on every
# invocation — a checker that cannot run is a checker that guards nothing. The
# other scripts here already took the quoted form; this one had drifted.
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
[ -n "$common_dir" ] || { echo "Not a git repository." >&2; exit 3; }
main_toplevel=$(dirname "$common_dir")

emit() { # emit <isolated:true|false> <registered:true|false> <is_main:true|false> <exit> <reason>
  jq -n \
    --argjson isolated "$1" \
    --argjson registered "$2" \
    --argjson is_main "$3" \
    --arg path "$WT_PATH" \
    --arg branch "$WT_BRANCH" \
    --arg main_toplevel "$main_toplevel" \
    --arg reason "$5" \
    '{isolated: $isolated, path: $path, branch: $branch, registered: $registered,
      is_main_checkout: $is_main, main_toplevel: $main_toplevel, reason: $reason}'
  exit "$4"
}

if [ -z "$WT_PATH" ]; then
  emit false false false 1 "No worktreePath returned. The agent is running in the main checkout — treat everything it touches as landing on your branch."
fi

# The #39886 tell: a status string where a path belonged.
case "$WT_PATH" in
  /*) : ;;
  *) emit false false false 1 "worktreePath is not an absolute path: '$WT_PATH'. This is the known shape of a lost worktree race (a status string where a path belonged) — the agent is in the main checkout." ;;
esac

[ -d "$WT_PATH" ] || emit false false false 1 "worktreePath does not exist on disk: $WT_PATH"

wt_real=$(cd "$WT_PATH" && pwd -P)
main_real=$(cd "$main_toplevel" && pwd -P)

if [ "$wt_real" = "$main_real" ]; then
  emit false false true 1 "worktreePath IS the main checkout ($main_real). The agent is not isolated."
fi

if git worktree list --porcelain | grep -qxF "worktree $wt_real"; then
  registered=true
else
  registered=false
fi

if [ "$registered" != "true" ]; then
  emit false false false 1 "$wt_real is not a registered worktree of this repository (git worktree list does not know it)."
fi

if [ -z "$WT_BRANCH" ]; then
  emit true true false 0 "Worktree is real and registered, but no worktreeBranch was reported — confirm the agent's commits are landing on a branch of its own before merging."
fi

emit true true false 0 ""
