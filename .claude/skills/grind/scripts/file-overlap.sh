#!/usr/bin/env bash
# Measure which lanes touch the same files. Measured, never predicted — the
# conflict a lane plan predicts is routinely not the one that happens, and the
# files a process instruction makes universal are the ones plan-reasoning misses.
#
# Two modes:
#
#   Pairwise overlap between lane branches (run at each completion):
#     file-overlap.sh --base <integration-branch> <ref> <ref> [<ref>...]
#
#   Actual vs. predicted for one lane (run when its handoff lands):
#     file-overlap.sh --base <integration-branch> --actual <ref> \
#                     --expected "webview/editor.ts,webview/serialization.ts"
#
# A file in `unexpected` is a queued-lane rebrief, and it is far cheaper to find
# here than in the merge.
#
# Requires: git, jq.
#
# Output: one JSON object on stdout.
#   pairwise: { base, refs[], changed{ref: [files]}, overlaps[{a, b, files[]}], any_overlap }
#   actual:   { base, actual, expected[], touched[], unexpected[], untouched_expected[] }
#
# Exit: 0 no overlap / no unexpected files | 1 overlap or unexpected files found
#       3 input error

set -euo pipefail

BASE=""
ACTUAL=""
EXPECTED=""
REFS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base)     BASE="${2:-}"; shift 2 ;;
    --actual)   ACTUAL="${2:-}"; shift 2 ;;
    --expected) EXPECTED="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "Unknown argument: $1" >&2; exit 3 ;;
    *) REFS="$REFS $1"; shift ;;
  esac
done

[ -n "$BASE" ] || { echo "Missing --base <integration-branch>." >&2; exit 3; }
git rev-parse --verify --quiet "$BASE" >/dev/null || { echo "Base ref not found: $BASE" >&2; exit 3; }

changed_files() { # changed_files <ref> — files the ref changed relative to BASE
  git diff --name-only "$BASE...$1"
}

# --- Mode 2: actual vs. predicted --------------------------------------------
if [ -n "$ACTUAL" ]; then
  git rev-parse --verify --quiet "$ACTUAL" >/dev/null || { echo "Ref not found: $ACTUAL" >&2; exit 3; }
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  changed_files "$ACTUAL" | sort -u > "$tmp/touched"
  printf '%s' "$EXPECTED" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | sort -u > "$tmp/expected" || true

  comm -23 "$tmp/touched" "$tmp/expected" > "$tmp/unexpected"
  comm -13 "$tmp/touched" "$tmp/expected" > "$tmp/missing"

  jq -n \
    --arg base "$BASE" --arg actual "$ACTUAL" \
    --argjson expected "$(jq -R . < "$tmp/expected" | jq -s .)" \
    --argjson touched "$(jq -R . < "$tmp/touched" | jq -s .)" \
    --argjson unexpected "$(jq -R . < "$tmp/unexpected" | jq -s .)" \
    --argjson missing "$(jq -R . < "$tmp/missing" | jq -s .)" \
    '{base: $base, actual: $actual, expected: $expected, touched: $touched,
      unexpected: $unexpected, untouched_expected: $missing}'

  [ -s "$tmp/unexpected" ] && exit 1
  exit 0
fi

# --- Mode 1: pairwise overlap -------------------------------------------------
set -- $REFS
[ $# -ge 2 ] || { echo "Pairwise mode needs at least two refs (or use --actual/--expected)." >&2; exit 3; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

i=0
for ref in "$@"; do
  git rev-parse --verify --quiet "$ref" >/dev/null || { echo "Ref not found: $ref" >&2; exit 3; }
  i=$((i + 1))
  changed_files "$ref" | sort -u > "$tmp/set.$i"
done

changed_json="{}"
i=0
for ref in "$@"; do
  i=$((i + 1))
  changed_json=$(printf '%s' "$changed_json" | jq \
    --arg ref "$ref" \
    --argjson files "$(jq -R . < "$tmp/set.$i" | jq -s .)" \
    '. + {($ref): $files}')
done

overlaps="[]"
any=false
i=0
for a in "$@"; do
  i=$((i + 1))
  j=0
  for b in "$@"; do
    j=$((j + 1))
    [ $j -gt $i ] || continue
    comm -12 "$tmp/set.$i" "$tmp/set.$j" > "$tmp/both"
    [ -s "$tmp/both" ] || continue
    any=true
    overlaps=$(printf '%s' "$overlaps" | jq \
      --arg a "$a" --arg b "$b" \
      --argjson files "$(jq -R . < "$tmp/both" | jq -s .)" \
      '. + [{a: $a, b: $b, files: $files}]')
  done
done

jq -n \
  --arg base "$BASE" \
  --argjson refs "$(printf '%s\n' "$@" | jq -R . | jq -s .)" \
  --argjson changed "$changed_json" \
  --argjson overlaps "$overlaps" \
  --argjson any "$any" \
  '{base: $base, refs: $refs, changed: $changed, overlaps: $overlaps, any_overlap: $any}'

[ "$any" = "true" ] && exit 1
exit 0
