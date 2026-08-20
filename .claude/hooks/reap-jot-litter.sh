#!/bin/bash
# SessionEnd hook: clear the development litter a Jot run leaves on the machine.
#
# Running Birta Writer Jot puts two things outside every repo that no repo owns
# and the harness lock cannot see: WebKit helper processes, and a throwaway
# defaults domain per run. Both outlive the session that made them and belong
# to nobody a later reader can name, which is how a red suite becomes nobody's
# fault and how 220 stale plists accumulated over three days.
#
# A hook rather than a rule, for the reason this repository already has
# `no-piped-gate.sh` and `prose-guard`: the guidance existed, in
# `jot/scripts/measure.sh`'s header, and was broken repeatedly by sessions that
# had no reason to read it. Where guidance is broken repeatedly, the rule
# becomes code. A cleanup nobody has to remember is the only kind that runs.
#
# The safety is all in `reap.sh`, deliberately, so there is one place to read
# it: it never touches `/Applications`, never touches the app's own settings
# domain, and never ends a process another checkout started.
#
# Silent when there is nothing to do, and never fails the session: a teardown
# that can block an exit is a teardown people disable.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -n "$ROOT" ] || exit 0
[ -x "$ROOT/jot/scripts/reap.sh" ] || exit 0

# macOS only. The app does not exist anywhere else, so neither does its litter.
[ "$(uname -s)" = "Darwin" ] || exit 0

output="$(bash "$ROOT/jot/scripts/reap.sh" --reap 2>&1 || true)"
case "$output" in
    *"cleared 0,"*) ;;
    *) echo "$output" ;;
esac
exit 0
