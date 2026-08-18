#!/usr/bin/env bash
# The MAR-374 measurements, as a procedure rather than as numbers. Runs the
# built app under BIRTA_JOT_MEASURE=1 and drives it through the debug signals
# that mode installs (a shell cannot press a global hotkey without an
# Accessibility grant):
#
#   SIGUSR1  toggle the panel, as the hotkey does
#   SIGURG   post <scratchpad dir>/.debug-message.json to the page, or, when
#            its type is __jotKeys, type its keys into the panel as NSEvents
#            (real WebKit editing, the engine the panel renders in)
#
# and stages the cold-recovery path by kill -9 on the WebContent helper that
# appeared when the app launched (WebKit's helpers are not children of the
# app, so they are found by diffing pgrep before and after launch).
#
# It prints the intervals the ticket names, in ms, from the app's stderr:
#   launch→ready          first cold mount (paid at login, prewarm)
#   hotkey→visible        warm summon, panel on screen
#   hotkey→caret-ready    warm summon, editor focused
#   kill→ready            cold recovery: content process death to editor mounted
# plus idle RSS of the app and its WebKit helper processes after a quiet spell,
# and it checks the persistence loop: inserted text reaches the scratchpad
# file after a hide, and survives the content-process kill.
#
# Usage: bash jot/scripts/measure.sh [--keep] (keep leaves the app running,
# bound to the throwaway scratchpad it created)
#
# A figure this prints is a reading, not a record: quote it from a run on an
# idle machine, never from a doc.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="jot/build/Birta Jot.app/Contents/MacOS/BirtaJot"
[ -x "$APP" ] || { echo "build first: bash jot/scripts/build-app.sh" >&2; exit 1; }

# A throwaway scratchpad: the probes below type into it, and the user's real
# one is never touched.
SCRATCH_DIR="$(mktemp -d -t jot-measure-scratch)"
export BIRTA_JOT_SCRATCHPAD="$SCRATCH_DIR/Scratchpad.md"
# ...and a throwaway defaults domain, so the run never rewrites the user's
# toolbar layout, view state or panel frame.
export BIRTA_JOT_DEFAULTS_SUITE="com.birtalabs.jot.measure.$$"
trap 'defaults delete "$BIRTA_JOT_DEFAULTS_SUITE" >/dev/null 2>&1 || true' EXIT
LOG="$(mktemp -t jot-measure)"
KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; fi

WC_BEFORE="$(pgrep -f com.apple.WebKit | sort || true)"
BIRTA_JOT_MEASURE=1 "$APP" 2>"$LOG" &
PID=$!
trap '[ $KEEP = 1 ] || { kill $PID 2>/dev/null; wait $PID 2>/dev/null; } || true; rm -rf "$SCRATCH_DIR"; defaults delete "$BIRTA_JOT_DEFAULTS_SUITE" >/dev/null 2>&1 || true' EXIT

wait_for() { # wait_for <mark> <timeout-s>
    local n=0
    while ! grep -q "^jot-measure $1 " "$LOG"; do
        sleep 0.1; n=$((n+1))
        if [ $n -gt $(( $2 * 10 )) ]; then echo "timeout waiting for $1" >&2; cat "$LOG" >&2; exit 1; fi
    done
}
last() { grep "^jot-measure $1 " "$LOG" | tail -1 | awk '{print $3}'; }
delta() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }

wait_for ready 20
echo "launch→ready         $(delta "$(last launch)" "$(last ready)") ms   (prewarm; the first cold mount)"

sleep 1
kill -USR1 $PID; wait_for visible 5; wait_for caret-ready 5
echo "hotkey→visible       $(delta "$(last hotkey)" "$(last visible)") ms   (warm)"
echo "hotkey→caret-ready   $(delta "$(last hotkey)" "$(last caret-ready)") ms   (warm)"

# Persistence: insert text through the test-only page command, hide (which
# flushes), and read the file.
STAMP="probe-$(date +%s)"
printf '{"type":"__testInsertText","text":"%s\\n"}' "$STAMP" > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 0.5
kill -USR1 $PID   # hide: flushSave → write → orderOut
sleep 1.5
if grep -q "$STAMP" "$SCRATCH_DIR/Scratchpad.md" 2>/dev/null; then
    echo "persistence          ok: '$STAMP' is in Scratchpad.md after hide"
else
    echo "persistence          FAILED: '$STAMP' not in Scratchpad.md" >&2; cat "$LOG" >&2; exit 1
fi
rm -f "$SCRATCH_DIR/.debug-message.json"

# Real typing: Return must move the caret to the new paragraph and the next
# characters must land there. Playwright's WebKit build gets this wrong through
# its own key injection (text stays on the previous line), the app's NSEvent
# path does not, so this is the check that speaks for the panel.
kill -USR1 $PID; wait_for visible 5; sleep 0.5
printf '{"type":"__jotKeys","keys":["End","Enter","Enter","N","e","x","t","Enter","l","i","n","e"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2
kill -USR1 $PID; sleep 1.5
if grep -q "^Next$" "$SCRATCH_DIR/Scratchpad.md" && grep -q "^line$" "$SCRATCH_DIR/Scratchpad.md"; then
    echo "typing               ok: Return moves to a new paragraph in the panel's WebKit"
else
    echo "typing               FAILED: expected 'Next' and 'line' on their own lines:" >&2; cat "$SCRATCH_DIR/Scratchpad.md" >&2; exit 1
fi
rm -f "$SCRATCH_DIR/.debug-message.json"

# Paste an image into a panel that was just summoned and not touched, which is
# the ordinary opening gesture: the real pasteboard, the real paste, the base64
# bridge and the attachment store, and the only check that covers all four at
# once.
#
# The paste is delivered to the web view rather than as a menu key equivalent,
# because an accessory app driven from a shell frequently cannot take
# activation, and a menu chord with no key window reaches nothing. That
# difference is worth knowing about when reading a failure here: it made this
# check fail about one run in four, and looked exactly like a defect in the
# editor until the app was asked what it saw (`active=false key=false`).
#
# This briefly uses the clipboard, and puts back whatever text was on it.
CLIP_BACKUP="$(mktemp -t jot-measure-clip)"
pbpaste > "$CLIP_BACKUP" 2>/dev/null || true
PNG="$SCRATCH_DIR/probe.png"
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' \
    | base64 --decode > "$PNG"
# The typing check above left the panel hidden, so one press is a fresh
# summon. Truncating the file here would prove nothing: the buffer in the app
# is the authority and writes over it on the next flush.
kill -USR1 $PID; wait_for visible 5; sleep 0.5
osascript -e "set the clipboard to (read (POSIX file \"$PNG\") as «class PNGf»)" >/dev/null
printf '{"type":"__jotKeys","keys":["cmd+v"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
kill -USR1 $PID; sleep 1.5
pbcopy < "$CLIP_BACKUP" 2>/dev/null || true
rm -f "$CLIP_BACKUP"
PASTED_REF="$(grep -o 'Attachments/[A-Za-z0-9.]*' "$SCRATCH_DIR/Scratchpad.md" 2>/dev/null | head -1 || true)"
if [ -n "$PASTED_REF" ] && [ -f "$SCRATCH_DIR/$PASTED_REF" ]; then
    echo "paste                ok: the image reached $PASTED_REF and the document references it"
else
    echo "paste                FAILED: expected an Attachments/ reference in the document." >&2
    echo "document:" >&2; cat "$SCRATCH_DIR/Scratchpad.md" >&2
    echo "attachments:" >&2; ls -l "$SCRATCH_DIR/Attachments" >&2 2>/dev/null || echo "(none)" >&2
    exit 1
fi
rm -f "$SCRATCH_DIR/.debug-message.json"

# Cold recovery: kill the content process, wait for the remount.
BEFORE=$(grep -c "^jot-measure ready " "$LOG")
WC_AFTER="$(pgrep -f com.apple.WebKit.WebContent | sort || true)"
WC_NEW="$(comm -13 <(printf '%s\n' "$WC_BEFORE") <(printf '%s\n' "$WC_AFTER") | tr '\n' ' ')"
if [ -z "$WC_NEW" ]; then echo "could not identify Jot's WebContent process" >&2; exit 1; fi
if [ "$(echo $WC_NEW | wc -w)" -ne 1 ]; then
    echo "more than one WebContent process appeared since launch ($WC_NEW); another WebKit app started meanwhile, so the kill would not be ours alone. Re-run on a quieter machine." >&2; exit 1
fi
kill -9 $WC_NEW
n=0
while [ "$(grep -c "^jot-measure ready " "$LOG")" -le "$BEFORE" ]; do
    sleep 0.1; n=$((n+1))
    if [ $n -gt 200 ]; then echo "no remount after kill" >&2; cat "$LOG" >&2; exit 1; fi
done
echo "terminate→ready      $(delta "$(last terminate)" "$(last ready)") ms   (cold recovery: WebKit reports the death, Jot remounts)"
if grep -q "$STAMP" "$SCRATCH_DIR/Scratchpad.md"; then
    echo "recovery             ok: the buffer survived the content-process kill"
else
    echo "recovery             FAILED: the buffer did not survive the kill" >&2; cat "$LOG" >&2; exit 1
fi

# Idle memory: the app plus the WebKit helpers that appeared with it (the
# content process is a fresh one after the kill above), after a quiet spell.
sleep 5
RSS_APP=$(ps -o rss= -p $PID | tr -d ' ')
WK_NOW="$(pgrep -f com.apple.WebKit | sort || true)"
WK_OURS="$(comm -13 <(printf '%s\n' "$WC_BEFORE") <(printf '%s\n' "$WK_NOW") | tr '\n' ' ')"
RSS_HELPERS=0
for h in $WK_OURS; do
    r=$(ps -o rss= -p "$h" 2>/dev/null | tr -d ' ' || true)
    RSS_HELPERS=$((RSS_HELPERS + ${r:-0}))
done
echo "idle RSS app         $((RSS_APP / 1024)) MB"
echo "idle RSS helpers     $((RSS_HELPERS / 1024)) MB   (WebKit helpers that appeared since launch: ${WK_OURS:-none})"
echo "log: $LOG"
