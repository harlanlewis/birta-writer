#!/usr/bin/env bash
# A file changed on disk by something other than the app, while the app has it
# open, is never written over without somebody saying so (MAR-469).
#
#   bash mac/scripts/check-external-change.sh
#
# Beside mac/scripts/check-cli.sh, and unlike it this one launches the app:
# what is asserted is what the RUNNING app does to a file a shell changed
# underneath it, which nothing short of the app can answer. The rule it wires
# is `BirtaWriterCore.DiskDrift`, whose own tests hold the decision; what this
# holds is that the decision is reached at a summon and before a write, on the
# real write path, with the real `AtomicFile`.
#
# The file is bound as the scratchpad of a throwaway defaults domain rather
# than opened with `bwr`: the command hands its path to LaunchServices, which
# starts whichever copy of the app is installed rather than the one this tree
# built. The binding is the same either way, one window over one path.
#
# The shell's change is a plain `printf >`, deliberately uncoordinated: a file
# presenter hears only coordinated writes, so this is the case where nothing
# but the stat can notice, which is the floor the fix promises.
#
# Driven the way mac/scripts/measure.sh drives the app (SIGUSR1 toggles the
# panel, SIGURG posts the debug message beside the scratchpad), and it needs
# the same things: the screen unlocked and awake, and the machine's front
# window left alone while it runs.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="mac/build/Birta Writer.app/Contents/MacOS/BirtaWriter"
bash mac/scripts/build-fresh.sh

if ioreg -n Root -d1 -a 2>/dev/null | grep -A1 CGSSessionScreenIsLocked | grep -q "<true/>"; then
    echo "the screen is locked, and this drives a panel that has to be on screen. Unlock and rerun." >&2
    exit 1
fi

DIR="$(cd "$(mktemp -d -t mac-external-change)" && pwd -P)"
NOTE="$DIR/Note.md"
export BIRTA_MAC_SCRATCHPAD="$NOTE"
export BIRTA_MAC_DEFAULTS_SUITE="com.birtalabs.birta-writer.external-change.$$"
LOG="$(mktemp -t mac-external-change)"
printf 'first line\n' > "$NOTE"

BIRTA_MAC_MEASURE=1 "$APP" 2>"$LOG" &
PID=$!
# SIGTERM through the app's own handler, never SIGKILL, which orphans WebKit's
# helpers. The ONE exit trap: a second `trap ... EXIT` replaces this one.
end_app() {
    [ -n "${PID:-}" ] || return 0
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
}
trap 'end_app; rm -rf "$DIR"; defaults delete "$BIRTA_MAC_DEFAULTS_SUITE" >/dev/null 2>&1 || true; rm -f "$HOME/Library/Preferences/$BIRTA_MAC_DEFAULTS_SUITE.plist"; rm -f "$LOG"' EXIT

failures=0
checks=0
fail() { echo "FAIL $*" >&2; failures=$((failures + 1)); }

marks() { grep -c "^mac-measure $1 " "$LOG" || true; }
traces() { grep -c "^birta-trace $1" "$LOG" || true; }
wait_for() { # wait_for <mark> <timeout-s>
    local n=0
    while ! grep -q "^mac-measure $1 " "$LOG"; do
        sleep 0.1; n=$((n+1))
        if [ $n -gt $(( $2 * 10 )) ]; then echo "timeout waiting for $1" >&2; cat "$LOG" >&2; exit 1; fi
    done
}
post() { # post <json>: hand the running app one debug message
    printf '%s' "$1" > "$DIR/.debug-message.json"
    kill -URG "$PID"
}
# SIGUSR1 is a toggle, not a direction; `show` marks `visible` and `hide`
# marks nothing, so the direction a toggle went is read back rather than
# assumed (measure.sh's `hide_panel` has the long form of why).
show_panel() {
    local before n=0
    before=$(marks visible)
    kill -USR1 "$PID"
    while [ "$(marks visible)" -le "$before" ]; do
        sleep 0.1; n=$((n+1))
        if [ $n = 15 ]; then kill -USR1 "$PID"; fi
        if [ $n -gt 60 ]; then echo "panel never became visible" >&2; cat "$LOG" >&2; exit 1; fi
    done
    sleep 0.8
}
hide_panel() {
    local before
    before=$(marks visible)
    kill -USR1 "$PID"; sleep 1.5
    if [ "$(marks visible)" -gt "$before" ]; then
        kill -USR1 "$PID"; sleep 1.5
        if [ "$(marks visible)" -gt "$before" ]; then
            echo "the app cannot come forward, so the panel will not dismiss. Rerun with the machine to itself." >&2
            exit 1
        fi
    fi
}
expect_bytes() { # expect_bytes <want> <what>
    checks=$((checks + 1))
    local got
    got="$(cat "$NOTE")"
    if [ "$got" != "$1" ]; then
        fail "$2: the file holds '$got', wanted '$1'"
    fi
}
expect_trace() { # expect_trace <pattern> <at-least> <what>
    checks=$((checks + 1))
    local got
    got=$(traces "$1")
    if [ "$got" -lt "$2" ]; then
        fail "$3: $got '$1' traces, wanted at least $2"
        grep -E "^birta-trace (writeattempt|diskdrift)" "$LOG" | tail -12 | sed 's/^/    /' >&2
    fi
}

wait_for ready 20
show_panel

echo "a clean buffer, changed outside while hidden"
hide_panel
printf 'changed outside\n' > "$NOTE"
show_panel
# The summon re-read it; an explicit save is a write that cannot be a toggle
# gone the wrong way, so it is the one that proves nothing was written over.
post '{"type":"__birtaSaveNow"}'; sleep 1.5
expect_bytes "changed outside" "a summon after an outside change does not write the old buffer back"
expect_trace "diskdrift reread" 1 "the summon re-read the file"
hide_panel
expect_bytes "changed outside" "hiding after the re-read does not write the old buffer back"

echo "a coordinated change, while the panel is up and nobody summons"
# The presenter's own path, which the `printf` above deliberately cannot
# reach: a write made through `NSFileCoordinator` is what an editor that
# coordinates its saves makes, and it is the only kind a presenter hears. What
# this asks is that the note re-reads itself with nobody touching the app.
cat > "$DIR/coordinated-write.swift" <<'SWIFT'
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let text = CommandLine.arguments[2]
var error: NSError?
NSFileCoordinator().coordinate(writingItemAt: url, options: [], error: &error) { target in
    try? text.write(to: target, atomically: false, encoding: .utf8)
}
if let error { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1) }
SWIFT
show_panel
before_rereads=$(traces "diskdrift reread")
swift "$DIR/coordinated-write.swift" "$NOTE" "coordinated change
" || fail "the coordinated write itself failed"
sleep 2.5
checks=$((checks + 1))
if [ "$(traces "diskdrift reread")" -le "$before_rereads" ]; then
    fail "a coordinated change was not noticed while the panel was up"
fi
expect_bytes "coordinated change" "noticing a coordinated change writes nothing"

echo "an edited buffer, changed outside while it is up"
show_panel
printf 'changed again\n' > "$NOTE"
# An edit the file does not hold, made after the outside change: the buffer
# and the disk now both differ from what the app last read.
post '{"type":"__testInsertText","text":"typed here "}'; sleep 1.5
expect_bytes "changed again" "an edited buffer does not autosave over an outside change"
expect_trace "diskdrift conflict" 1 "the conflict was noticed"
post '{"type":"__birtaSaveNow"}'; sleep 1.5
expect_bytes "changed again" "Cmd+S does not write over an outside change without an answer"
expect_trace "diskdrift asked" 1 "the question was put"

echo "answered: Reload from Disk"
post '{"type":"__birtaAnswerDiskDrift","answer":"reload"}'; sleep 1.5
expect_bytes "changed again" "Reload from Disk leaves the file as the outside tool wrote it"
post '{"type":"__birtaSaveNow"}'; sleep 1.5
expect_bytes "changed again" "after Reload from Disk the buffer IS the file, so a save changes nothing"

echo "answered: Keep My Changes"
printf 'changed a third time\n' > "$NOTE"
post '{"type":"__testInsertText","text":"kept "}'; sleep 1.5
post '{"type":"__birtaSaveNow"}'; sleep 1.5
expect_bytes "changed a third time" "a second conflict is refused the same way"
post '{"type":"__birtaAnswerDiskDrift","answer":"keep"}'; sleep 1.5
checks=$((checks + 1))
case "$(cat "$NOTE")" in
    *kept*) ;;
    *) fail "Keep My Changes writes the buffer: the file holds '$(cat "$NOTE")'" ;;
esac

echo "an unchanged file is still not written"
before_ino="$(stat -f %i "$NOTE")"
hide_panel
show_panel
hide_panel
checks=$((checks + 1))
if [ "$(stat -f %i "$NOTE")" != "$before_ino" ]; then
    fail "a summon and a hide over an unchanged file replaced it (new inode)"
fi

echo "a window that goes before anybody answers"
# The question needs somebody there, and quitting is when there is nobody. The
# buffer goes beside the file rather than over it, which is the same answer the
# app gives for a note deleted underneath it.
printf 'changed a fourth time\n' > "$NOTE"
post '{"type":"__testInsertText","text":"unanswered "}'; sleep 1.5
expect_bytes "changed a fourth time" "the conflict is still refused"
end_app
expect_bytes "changed a fourth time" "quitting does not write the buffer over the outside change"
checks=$((checks + 1))
KEPT="$DIR/Note (unsaved).md"
if [ ! -f "$KEPT" ]; then
    fail "quitting with the question unanswered lost the buffer: no $KEPT"
    ls -l "$DIR" >&2
else
    checks=$((checks + 1))
    case "$(cat "$KEPT")" in
        *unanswered*) ;;
        *) fail "the kept file does not hold what was typed: '$(cat "$KEPT")'" ;;
    esac
fi

echo "the next summon says where that text went"
# The other half of keeping it: a path written only to the log is a path
# nobody reads. The app records it, and the next summon says it and forgets
# it. Read through `defaults` because the message itself is drawn in a window
# and a shell cannot see it; what this pins is the state the message is made
# from, on both sides.
checks=$((checks + 1))
RECORDED="$(defaults read "$BIRTA_MAC_DEFAULTS_SUITE" rescuedBufferPath 2>/dev/null || true)"
case "$RECORDED" in
    *"(unsaved)"*) ;;
    *) fail "the kept file was not recorded for the next launch: '$RECORDED'" ;;
esac
READY_BEFORE=$(marks ready)
BIRTA_MAC_MEASURE=1 "$APP" 2>>"$LOG" &
PID=$!
n=0
while [ "$(marks ready)" -le "$READY_BEFORE" ]; do
    sleep 0.2; n=$((n+1))
    if [ $n -gt 100 ]; then echo "the second launch never became ready" >&2; exit 1; fi
done
show_panel
end_app
checks=$((checks + 1))
if defaults read "$BIRTA_MAC_DEFAULTS_SUITE" rescuedBufferPath >/dev/null 2>&1; then
    fail "a summon did not clear the kept file's path, so every later launch would say it again"
fi

echo
# A count with nothing to compare it against is not a reading. An arm that
# stops running takes its assertions with it and leaves a green line with a
# smaller number in it, which nobody reads as a failure. Raise this when arms
# are added; a drop is the thing it exists to catch.
EXPECTED_CHECKS=20
if [ "$checks" -lt "$EXPECTED_CHECKS" ]; then
    echo "check-external-change: only $checks checks ran, expected at least $EXPECTED_CHECKS." >&2
    echo "  An arm stopped running. Nothing below its own assertions was measured." >&2
    failures=$((failures + 1))
fi
if [ "$failures" -eq 0 ]; then
    echo "check-external-change: $checks checks, all green"
else
    echo "check-external-change: $failures of $checks checks failed" >&2
    exit 1
fi
