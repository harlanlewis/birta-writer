#!/bin/bash
# gate.sh — run a gate command without masking its exit code.
#
# The failure this replaces: `pnpm test 2>&1 | tail -8` exits with tail's
# code, so a red gate reads green and the detail is gone. MAR-141 carried
# that as a prose warning ("Never pipe a gate through tail") and it was
# violated twice in one session anyway (2026-08-05); the no-piped-gate
# PreToolUse hook now blocks the shape, and this script is the sanctioned
# way to get what the pipe was reaching for — short output — without
# losing the verdict.
#
# Usage: gate.sh [--tail N] -- <command> [args...]
#
# Runs the command with stdout+stderr to a log file, prints the last N
# lines (default 20) plus an explicit exit line, and exits with the
# command's real code. The full log path is always printed, so a failure
# can be read in whole rather than re-run.
set -uo pipefail

TAIL_N=20
if [[ "${1:-}" == "--tail" ]]; then
    TAIL_N="${2:?--tail needs a number}"
    shift 2
fi
[[ "${1:-}" == "--" ]] && shift
if [[ $# -eq 0 ]]; then
    echo "usage: gate.sh [--tail N] -- <command> [args...]" >&2
    exit 2
fi

LOG="$(mktemp -t gate.XXXXXX)"
"$@" >"$LOG" 2>&1
CODE=$?

tail -n "$TAIL_N" "$LOG"
echo "── gate: exit=$CODE  cmd: $*  full log: $LOG"
exit "$CODE"
