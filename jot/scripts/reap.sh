#!/usr/bin/env bash
# Clear the development litter a Birta Writer Jot run leaves outside every repo.
#
# Running the app puts two things on the machine that no repo owns and the
# harness lock cannot see: WebKit helper processes, and a throwaway defaults
# domain per run. Both accumulate silently, both outlive the session that made
# them, and neither belongs to anybody a later reader can name, which is how a
# red suite becomes nobody's fault.
#
# This exists because the rule was prose. It lived in `measure.sh`'s header,
# which is not where somebody writing ten lines of Swift to answer one question
# reads it, and the litter accumulated for days under three separate sessions.
# Where guidance is broken repeatedly, the rule becomes code: the same
# tradition as `.claude/hooks/no-piped-gate.sh` and `.claude/prose-guard`.
#
#   bash jot/scripts/reap.sh            report what is there, change nothing
#   bash jot/scripts/reap.sh --reap     also remove it
#
# `--check` is `--reap`'s opposite twin: report, and exit nonzero if there is
# anything to report, so a hook or a gate can fail on litter.
#
# What it will NOT touch, and these are the whole of its safety:
#
#   - `/Applications/Birta Writer Jot.app`. That is the user's installed copy,
#     not a development build, and a session that killed it would take away a
#     running app somebody is using.
#   - `com.birtalabs.jot.plist`. That is the app's REAL settings domain: a
#     person's hotkey, their note location, their agent command. It is also a
#     prefix of every throwaway one, so the rule is that a domain strictly
#     UNDER it is scratch and the domain itself never is.
#   - A process this checkout did not start. Another worktree's session runs
#     the same binary name, and the process table is machine-wide; the working
#     directory is what tells them apart.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd -P)"

MODE="report"
case "${1:-}" in
    --reap) MODE="reap" ;;
    --check) MODE="check" ;;
    "") ;;
    *) echo "usage: reap.sh [--reap|--check]" >&2; exit 2 ;;
esac

FOUND=0
CLEARED=0

# ── Processes ────────────────────────────────────────────────────────────────
#
# SIGTERM through the app's own handler, never SIGKILL. WebKit's helpers are
# XPC services rather than children of the app, so nothing reaps them for us:
# they exit because the app asks them to, and a hard kill leaves a GPU, a
# Networking and a WebContent process behind per launch.
#
# Selected by pattern and acted on by pid, which is the shape that keeps a
# pattern from acting on a set nobody has looked at: every match is printed
# with the directory it was started from before anything is sent to it.
for pid in $(pgrep -f "jot/build/Birta Writer Jot.app" || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
    if [ -z "$cwd" ]; then
        echo "  process $pid: cannot tell which checkout started it, leaving it alone"
        continue
    fi
    case "$cwd" in
        "$ROOT"|"$ROOT"/*) ;;
        *) echo "  process $pid: started from $cwd, another checkout's, leaving it alone"; continue ;;
    esac
    FOUND=$((FOUND + 1))
    if [ "$MODE" = "reap" ]; then
        echo "  process $pid: ending (started from $cwd)"
        kill "$pid" 2>/dev/null || true
    else
        echo "  process $pid: a development build of this checkout is still running"
    fi
done

# ── Throwaway defaults domains ───────────────────────────────────────────────
#
# `defaults delete` empties a domain and `cfprefsd` writes the file back, so
# the plist outlives the run whatever the script did. The file has to go too.
shopt -s nullglob
for plist in "$HOME"/Library/Preferences/com.birtalabs.jot.*.plist; do
    name="$(basename "$plist" .plist)"
    # Anything strictly under the prefix is a throwaway, and that is exact
    # rather than a heuristic: the app reads `com.birtalabs.jot`, its own
    # bundle id, and the ONLY thing that ever names a different domain is
    # `BIRTA_JOT_DEFAULTS_SUITE` (`Preferences.swift`), which exists so a
    # checking run never writes the person's own settings. So a sub-domain is
    # a run's scratch space by construction, whatever it was called.
    #
    # An earlier version of this matched a trailing process id, which is the
    # shape the committed scripts use. It left `policy.22286.NO` and
    # `seedtest` behind, both from ad-hoc probes, which are precisely the
    # thing this is for.
    if [ "$name" = "com.birtalabs.jot" ]; then continue; fi
    FOUND=$((FOUND + 1))
    if [ "$MODE" = "reap" ]; then
        defaults delete "$name" >/dev/null 2>&1 || true
        rm -f "$plist"
        CLEARED=$((CLEARED + 1))
    fi
done
shopt -u nullglob

# Counted with a glob rather than `ls`, because `set -o pipefail` turns an
# empty match into a failing pipeline and `set -e` then exits the script
# before it can report. The success case is the one where the glob matches
# nothing, so that is the case this must survive.
shopt -s nullglob
LEFTOVERS=("$HOME"/Library/Preferences/com.birtalabs.jot.*.plist)
shopt -u nullglob

case "$MODE" in
    reap)
        # What it CLEARED, not what is left. What is left is zero after a
        # successful run by definition, so a summary phrased that way says the
        # same thing whether the run did anything or nothing, and a caller
        # cannot tell the two apart.
        echo "reap: cleared $CLEARED, ${#LEFTOVERS[@]} left, and the app's own settings are untouched."
        ;;
    check)
        if [ "$FOUND" -gt 0 ]; then
            echo "reap: $FOUND thing(s) left on the machine. Run: bash jot/scripts/reap.sh --reap" >&2
            exit 1
        fi
        echo "reap: nothing left behind."
        ;;
    report)
        if [ "$FOUND" -gt 0 ]; then
            echo "reap: $FOUND thing(s) to clear. Run: bash jot/scripts/reap.sh --reap"
        else
            echo "reap: nothing left behind."
        fi
        ;;
esac
