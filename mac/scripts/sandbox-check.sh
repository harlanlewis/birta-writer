#!/usr/bin/env bash
# The store channel, run for real: build the app inside the App Sandbox and
# check the three things only a sandboxed process can show.
#
#   bash mac/scripts/sandbox-check.sh
#
#   bundle     the build is sandboxed and carries no `bwr`.
#   save       a file handed over through LaunchServices (the Finder's path)
#              takes an edit and a save. The sandbox grants that file and not
#              its folder, so a save that stages its temp beside the file is
#              refused (`AtomicFile`'s replacement-directory route).
#   relaunch   a folder and a file handed over on one launch are still readable
#              on the next, which is what the bookmarks are for
#              (`SandboxAccess`). Without them every path the app stored is
#              denied after a quit.
#
# The DEVELOPMENT flavour, so the sandbox container is the dev id's and the
# release's is never created. Everything the run writes is under a temporary
# folder or its own defaults domain inside that container, and both go at the
# end; the container keeps the default note the app makes on first launch.
#
# Reads the system log for sandbox denials (`log stream`), so it needs no
# privileges but does need the run to be alone: another sandboxed copy of the
# dev build would put its denials in the same stream. Outside the harness lock
# for the reason measure.sh is: it launches the app, not a browser.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Resolved, because the process table reports /private/var where mktemp
# answers /var, and the process is found by its path.
WORK="$(cd "$(mktemp -d -t birta-sandbox-check)" && pwd -P)"
APPDIR="$WORK/build"
BUNDLE_ID="com.birtalabs.birta-writer-dev"
CONTAINER="$HOME/Library/Containers/$BUNDLE_ID/Data"
SUITE="$BUNDLE_ID.sandbox-check.$$"
SUITE_PLIST="$CONTAINER/Library/Preferences/$SUITE.plist"
PID=""
LS=""
FAILED=0

# One exit trap, for the reason measure.sh gives: a second one would replace
# it. SIGTERM, never SIGKILL, so WebKit's helpers are asked to go.
end_app() {
    # Also a copy LaunchServices started whose pid was never learned: a launch
    # that failed to find it would otherwise leave it running after the exit.
    [ -n "$PID" ] || PID="$(pid_of_exe)"
    [ -n "$PID" ] || return 0
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    PID=""
}
cleanup() {
    end_app
    [ -z "$LS" ] || kill "$LS" 2>/dev/null || true
    # `defaults delete` first, by the plist's path since the domain lives in
    # the container: removing the file alone leaves cfprefsd holding the
    # domain, and it writes the plist back (measure.sh says the same).
    defaults delete "${SUITE_PLIST%.plist}" >/dev/null 2>&1 || true
    rm -f "$SUITE_PLIST" "$CONTAINER/Documents/Birta Writer/.debug-message.json"
    rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '%-10s %s\n' "$1" "$2"; }
fail() { say "$1" "FAILED: $2"; FAILED=1; }

node esbuild.mjs --production > "$WORK/esbuild.log" 2>&1
bash mac/scripts/build-app.sh --dev --store --out "$APPDIR" > "$WORK/build.log" 2>&1
APP="$APPDIR/Birta Writer [DEV].app"
EXE="$APP/Contents/MacOS/BirtaWriterDev"

# ── bundle ──────────────────────────────────────────────────────────────
if codesign -d --entitlements - "$APP" 2>/dev/null | grep -q 'com.apple.security.app-sandbox'; then
    if [ "$(ls "$APP/Contents/MacOS")" = "BirtaWriterDev" ]; then
        say bundle "ok: sandboxed, one binary"
    else
        fail bundle "Contents/MacOS holds $(ls "$APP/Contents/MacOS" | tr '\n' ' ')"
    fi
else
    fail bundle "the build carries no app-sandbox entitlement"
fi

# The test files, outside the container and outside anything granted.
OUTSIDE="$WORK/outside"
mkdir -p "$OUTSIDE/folder/sub"
printf '# Folder note\n' > "$OUTSIDE/folder/A.md"
printf '# Nested\n' > "$OUTSIDE/folder/sub/B.md"
printf '# Handed over\n\nbody\n' > "$OUTSIDE/Handed.md"
mkdir -p "$CONTAINER/Documents/Birta Writer"
# A launch handed a path starts from no remembered windows, so what opens is
# what the step asked for. A plain relaunch keeps them: putting back what the
# last launch had open is exactly what is being checked.
defaults_write() { defaults write "${SUITE_PLIST%.plist}" "$@"; }
defaults_write hasSeenWelcome -bool YES

# This build's process, matched on the executable path as a fixed string:
# the bundle name holds [DEV], which a pattern would read as a class.
pid_of_exe() {
    local pid
    # Nothing to match before the build has named its executable, and an
    # empty path would match every dev copy on the machine, somebody's own
    # among them. The path is under this run's temporary folder, so a set
    # one can only ever be this run's.
    [ -n "${EXE:-}" ] || return 0
    for pid in $(pgrep -f 'MacOS/BirtaWriterDev' || true); do
        if [ "$(ps -o command= -p "$pid" | cut -c1-${#EXE})" = "$EXE" ]; then echo "$pid"; return 0; fi
    done
    return 0
}

# launch <tag> [path]: through LaunchServices with a path (the Finder's
# route, which grants it), or straight from the binary without one (a plain
# relaunch, which grants nothing).
launch() {
    local tag=$1 target=${2:-}
    [ -z "$target" ] || defaults delete "${SUITE_PLIST%.plist}" openSet >/dev/null 2>&1 || true
    LOG="$WORK/$tag.stderr"
    : > "$LOG"
    if [ -n "$target" ]; then
        open -n -a "$APP" --env BIRTA_MAC_MEASURE=1 --env "BIRTA_MAC_DEFAULTS_SUITE=$SUITE" --stderr "$LOG" "$target"
        for _ in $(seq 1 100); do PID="$(pid_of_exe)"; [ -n "$PID" ] && break; sleep 0.1; done
        [ -n "$PID" ] || { fail "$tag" "LaunchServices started no copy of $EXE"; exit 1; }
    else
        BIRTA_MAC_MEASURE=1 BIRTA_MAC_DEFAULTS_SUITE="$SUITE" "$EXE" 2>"$LOG" &
        PID=$!
    fi
    for _ in $(seq 1 300); do grep -q '^mac-measure ready ' "$LOG" && break; sleep 0.1; done
    grep -q '^mac-measure ready ' "$LOG" || { fail "$tag" "the app never became ready"; cat "$LOG" >&2; exit 1; }
    sleep 2
}
# The page's debug channel: a message file beside the default note, then SIGURG.
post() { printf '%s' "$1" > "$CONTAINER/Documents/Birta Writer/.debug-message.json"; kill -URG "$PID"; sleep 2; }
# Denials on the handed-over paths and what is inside them. Not their
# parents: the app reads up a folder's ancestry for its title, which the
# sandbox refuses on every launch, the Finder's own included, and which no
# grant the person made was ever going to cover.
denials_of() { grep 'deny' "$WORK/sandbox.log" | grep -cE -- "$1" || true; }

log stream --style compact --predicate 'sender == "Sandbox"' > "$WORK/sandbox.log" 2>&1 &
LS=$!
sleep 1

# ── save ────────────────────────────────────────────────────────────────
launch save "$OUTSIDE/Handed.md"
post '{"type":"__testInsertText","text":"SANDBOX-CHECK "}'
post '{"type":"__birtaSave"}'
end_app
if grep -q 'SANDBOX-CHECK' "$OUTSIDE/Handed.md"; then
    say save "ok: the edit reached the file"
else
    fail save "the file did not take the edit ($(grep -c 'write failed' "$WORK/save.stderr" || true) write failures logged)"
fi
[ -z "$(ls -A "$OUTSIDE" | grep '\.tmp$' || true)" ] || fail save "a temp file was left beside the note"

# ── relaunch ────────────────────────────────────────────────────────────
launch grant "$OUTSIDE/folder"
end_app
GRANTED="$OUTSIDE/folder( |/)|$OUTSIDE/Handed\.md( |$)"
before="$(denials_of "$GRANTED")"
launch relaunch
end_app
after="$(denials_of "$GRANTED")"
if [ "$after" -gt "$before" ]; then
    fail relaunch "$((after - before)) sandbox denials on the handed-over paths after a relaunch"
    grep 'deny' "$WORK/sandbox.log" | grep -E -- "$GRANTED" | tail -5 >&2
elif ! grep -q '^birta-trace listing path=\. entries=' "$WORK/relaunch.stderr"; then
    fail relaunch "the folder window put back no listing"
else
    say relaunch "ok: the folder and the file are readable after a quit"
fi

exit $FAILED
