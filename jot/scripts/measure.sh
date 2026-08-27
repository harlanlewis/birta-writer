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
# file after a hide, and survives the content-process kill. With autosave off
# it checks the promise the other way: the hide writes nothing, and the
# SIGTERM at teardown writes rather than putting up a sheet nobody is there to
# answer.
#
# Usage: bash jot/scripts/measure.sh [--keep] (keep leaves the app running,
# bound to the throwaway scratchpad it created)
#
# A figure this prints is a reading, not a record: quote it from a run on an
# idle machine, never from a doc.
#
# If you write a quick probe of your own instead of extending this: WebKit's
# content processes are not children of the app, so SIGKILL on the app orphans
# them, and an orphan sits there at a fraction of a core for hours. This script
# ends the app with SIGTERM through its trap for that reason. An ad-hoc probe
# that hard-kills leaves litter that reads, to whoever is next on the machine,
# as an unexplained load and a test that times out in a file they did not
# touch.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="jot/build/Birta Writer.app/Contents/MacOS/BirtaJot"
[ -x "$APP" ] || { echo "build first: bash jot/scripts/build-app.sh" >&2; exit 1; }

# A throwaway scratchpad: the probes below type into it, and the user's real
# one is never touched.
SCRATCH_DIR="$(mktemp -d -t jot-measure-scratch)"
# A space in the name is load-bearing, not decoration: it is the wrap point the
# title bug needed, and a name without one passes that bug forever.
export BIRTA_JOT_SCRATCHPAD="$SCRATCH_DIR/Scratch pad.md"
# ...and a throwaway defaults domain, so the run never rewrites the user's
# toolbar layout, view state or panel frame.
export BIRTA_JOT_DEFAULTS_SUITE="com.birtalabs.jot.measure.$$"
# The formatting row ships closed, and what this script has to look at is an
# open one. Seeded through the view-state bag the app really restores from,
# rather than through a debug message: the restore path is itself part of what
# is being checked, and a message that forced the row open would leave it
# unexercised.
# A DICTIONARY keyed by the document's path, because view state belongs to a
# file rather than to the app: one value for everything meant a second window
# mounting at whatever position the first was left at. The key is the path as
# the app spells it, which is the path handed in through BIRTA_JOT_SCRATCHPAD
# (`standardizedFileURL` does not rewrite /var to /private/var, so the two
# agree without either resolving anything).
# The inner key has to match `STATE_KEY` in webview/components/toolbar/dock.ts.
# A name that has drifted seeds nothing; the `expanded` assertion below is what
# turns that into a red rather than a quietly wrong measurement.
# The value is wrapped in plist quotes with its own quotes escaped, and that
# is load-bearing in the way `-string` used to be: `-dict` parses each VALUE
# as plist syntax and has no per-value type flag, so bare braces are read as a
# nested dictionary, fail to parse, and write nothing at all.
defaults write "$BIRTA_JOT_DEFAULTS_SUITE" viewState \
    -dict "$BIRTA_JOT_SCRATCHPAD" '"{\"formattingRowExpanded\":true}"'
LOG="$(mktemp -t jot-measure)"
KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; fi

WC_BEFORE="$(pgrep -f com.apple.WebKit | sort || true)"
BIRTA_JOT_MEASURE=1 "$APP" 2>"$LOG" &
PID=$!
# Every throwaway defaults domain this run creates, cleaned by the ONE exit
# trap below. There must stay exactly one: a second `trap ... EXIT` REPLACES
# the first rather than adding to it, so a cleanup registered its own way
# silently switches off everything the earlier trap did, the app's SIGTERM
# included.
#
# The `rm` beside the `defaults delete` is not belt and braces. `delete` empties
# the domain and `cfprefsd` leaves the file, so the plist outlives every run.
# Removed by EXACT name, never by a glob over `com.birtalabs.jot.*`: the app's
# own domain is a prefix of every throwaway one, and a glob there takes the
# user's real settings.
# How this run ends the app, in one place.
#
# SIGTERM through the app's own handler, never SIGKILL: WebKit's helpers are
# not children of the app and only exit because the app asks them to, so a hard
# kill orphans a set of them per launch. Idempotent, so the teardown check and
# the exit trap can both call it.
end_app() {
    [ -n "${PID:-}" ] || return 0
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
}

EXTRA_SUITES=""
trap '[ $KEEP = 1 ] || end_app; rm -rf "$SCRATCH_DIR"; for s in $BIRTA_JOT_DEFAULTS_SUITE $EXTRA_SUITES; do defaults delete "$s" >/dev/null 2>&1 || true; rm -f "$HOME/Library/Preferences/$s.plist"; done' EXIT

wait_for() { # wait_for <mark> <timeout-s>
    local n=0
    while ! grep -q "^jot-measure $1 " "$LOG"; do
        sleep 0.1; n=$((n+1))
        if [ $n -gt $(( $2 * 10 )) ]; then echo "timeout waiting for $1" >&2; cat "$LOG" >&2; exit 1; fi
    done
}
last() { grep "^jot-measure $1 " "$LOG" | tail -1 | awk '{print $3}'; }
delta() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }
marks() { grep -c "^jot-measure $1 " "$LOG"; }

# SIGUSR1 toggles the panel, and a toggle is not a direction. An accessory app
# driven from a shell frequently cannot take activation (the paste check below
# has the same warning for its own reason), and a panel whose app never came
# forward reads as not visible, so the NEXT toggle shows it again instead of
# hiding it. Two shows in a row, and every check after that is measuring a
# panel in the state it was told to leave behind.
#
# Detected rather than assumed, because the app already says which way it went:
# `show` marks `visible` and `hide` marks nothing at all. A new mark after a
# toggle means the toggle went the wrong way, and one more takes it back.
#
# This is what made the edited-flag check below fail about one run in four: the
# hide that was supposed to write the buffer showed the panel instead, so the
# title still said Edited and the failure read exactly like the title being
# broken.
hide_panel() { # hide_panel <settle-seconds>
    local before after
    before=$(marks visible)
    kill -USR1 $PID; sleep "${1:-1.5}"
    after=$(marks visible)
    if [ "$after" -gt "$before" ]; then
        kill -USR1 $PID; sleep "${1:-1.5}"
    fi
}

show_panel() { # show_panel <settle-seconds>
    local before
    before=$(marks visible)
    kill -USR1 $PID
    local n=0
    while [ "$(marks visible)" -le "$before" ]; do
        sleep 0.1; n=$((n+1))
        # A toggle that hid instead of showing leaves the count where it was.
        if [ $n = 15 ]; then kill -USR1 $PID; fi
        if [ $n -gt 60 ]; then echo "panel never became visible" >&2; cat "$LOG" >&2; exit 1; fi
    done
    sleep "${1:-0.5}"
}

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
hide_panel 0.7      # hide: flushSave → write → orderOut
sleep 1.5
if grep -q "$STAMP" "$SCRATCH_DIR/Scratch pad.md" 2>/dev/null; then
    echo "persistence          ok: '$STAMP' is in the scratchpad after hide"
else
    echo "persistence          FAILED: '$STAMP' not in the scratchpad" >&2; cat "$LOG" >&2; exit 1
fi
rm -f "$SCRATCH_DIR/.debug-message.json"

# Real typing: Return must move the caret to the new paragraph and the next
# characters must land there. Playwright's WebKit build gets this wrong through
# its own key injection (text stays on the previous line), the app's NSEvent
# path does not, so this is the check that speaks for the panel.
show_panel
printf '{"type":"__jotKeys","keys":["End","Enter","Enter","N","e","x","t","Enter","l","i","n","e"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2
hide_panel
if grep -q "^Next$" "$SCRATCH_DIR/Scratch pad.md" && grep -q "^line$" "$SCRATCH_DIR/Scratch pad.md"; then
    echo "typing               ok: Return moves to a new paragraph in the panel's WebKit"
else
    echo "typing               FAILED: expected 'Next' and 'line' on their own lines:" >&2; cat "$SCRATCH_DIR/Scratch pad.md" >&2; exit 1
fi
rm -f "$SCRATCH_DIR/.debug-message.json"

# Spelling, end to end, which is a chain no other instrument reaches: the page
# posts its blocks out, the bridge carries them, `NSSpellChecker` answers, and
# the reply goes back. The Swift tests stop at the service and the browser
# harness cannot run the system checker at all, so this is the only place the
# whole round trip runs.
#
# Typed rather than written to the file, because it is the page's own rescan
# that posts the blocks, and that is what the round trip starts from.
show_panel
printf '{"type":"__jotKeys","keys":["End","Enter","t","e","h","c","i","e","f"," ","t","e","h","c","i","e","f"]}' \
    > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 3
hide_panel
rm -f "$SCRATCH_DIR/.debug-message.json"
LINT="$(grep "^jot-trace lint " "$LOG" | tail -1 || true)"
LINT_COUNT="$(echo "$LINT" | sed -n 's/.*lints=\([0-9]*\).*/\1/p')"
if [ -z "$LINT" ]; then
    echo "spelling             FAILED: the page asked for no lints at all" >&2
    echo "  (the capability may not be declared, or the rescan never ran)" >&2; exit 1
elif [ "${LINT_COUNT:-0}" -lt 1 ]; then
    echo "spelling             FAILED: the checker answered nothing for a misspelling" >&2
    echo "  $LINT" >&2; exit 1
else
    echo "spelling             ok: the system checker answered the page ($LINT)"
fi

# A menu key equivalent, from the chord to the bytes.
#
# The half `typeKeys` says outright it does not cover, and the only check
# anywhere that runs the menu bar. Everything else about the menus is decided
# before one exists: the table is parsed by `shared/__tests__/jotMenuTable.ts`,
# the built NSMenus are read back by `JotMenuTests`, and the chords are compared
# to the extension's by `menuChordParity.test.ts`. Not one of them presses a
# key, so until this existed nothing had established that a chord on a menu
# reaches the page at all.
#
# An XCTest cannot stand in for it. `NSMenu.performKeyEquivalent` compares an
# event's `charactersIgnoringModifiers` to the item's `keyEquivalent` verbatim,
# so a synthesized event carrying the shifted character a keyboard really sends
# (⇧⌘S carries "S"; the item binds "s") reads as no match, and a check built on
# it reports a broken menu on a working one.
#
# ⇧⌘8 is the chord for what it rules out. The page binds nothing for it, and the
# command branch of `typeKeys` never hands the event to the web view, so a
# bullet in the file can only have arrived through the menu: AppKit claiming the
# chord, validating the item against the delegate, and the command reaching the
# page from there. It also sits in the Lists SUBMENU, so a pass says
# `performKeyEquivalent` walked into one.
#
# What this does NOT cover is an ⌘⌥ row, and that is a live defect rather than a
# limitation of the probe (MAR-409): ⌘⌥1 leaves the paragraph alone here while
# `{"type":"editorCommand","command":"setHeading1"}` on the same buffer makes the
# heading, so the page half is not what is wrong. Asserting the Option half
# would fail today; asserting it is what closes that ticket.
show_panel
printf '{"type":"__jotKeys","keys":["End","Enter","Enter","B","u","l","l"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2
printf '{"type":"__jotKeys","keys":["cmd+shift+8"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2
hide_panel
if grep -qE "^[-*] Bull$" "$SCRATCH_DIR/Scratch pad.md"; then
    echo "menu chord           ok: ⇧⌘8 reached the page through the menu bar"
else
    echo "menu chord           FAILED: expected a bulleted 'Bull', so a menu key" >&2
    echo "                     equivalent did not reach the page:" >&2
    cat "$SCRATCH_DIR/Scratch pad.md" >&2; exit 1
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
show_panel
osascript -e "set the clipboard to (read (POSIX file \"$PNG\") as «class PNGf»)" >/dev/null
printf '{"type":"__jotKeys","keys":["cmd+v"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
hide_panel
pbcopy < "$CLIP_BACKUP" 2>/dev/null || true
rm -f "$CLIP_BACKUP"
PASTED_REF="$(grep -o 'Attachments/[A-Za-z0-9.]*' "$SCRATCH_DIR/Scratch pad.md" 2>/dev/null | head -1 || true)"
if [ -n "$PASTED_REF" ] && [ -f "$SCRATCH_DIR/$PASTED_REF" ]; then
    echo "paste                ok: the image reached $PASTED_REF and the document references it"
else
    echo "paste                FAILED: expected an Attachments/ reference in the document." >&2
    echo "document:" >&2; cat "$SCRATCH_DIR/Scratch pad.md" >&2
    echo "attachments:" >&2; ls -l "$SCRATCH_DIR/Attachments" >&2 2>/dev/null || echo "(none)" >&2
    exit 1
fi
rm -f "$SCRATCH_DIR/.debug-message.json"

# A deleted note is NOT written back.
#
# `AtomicFile.write` creates the file and every directory above it, so before
# this the sequence below put the note straight back: delete it, type one
# character, and an autosave tick recreated the path a person had just thrown
# away. The check is the FILE, not a message: a bar that appeared while the
# write still happened would look like the fix and be none of it.
#
# `rm` rather than a Finder delete on purpose. A file presenter only hears
# about coordinated changes, which Finder makes and this does not, so this
# exercises the pre-write existence check rather than the presenter. The
# presenter's own path is covered by `FileMoveTests`, which is where the rule
# about what a move into the Trash means is decided.
show_panel
rm -f "$SCRATCH_DIR/Scratch pad.md"
# An explicit save rather than a hide. A hide is a toggle, so it can show the
# panel instead and write nothing, and this check would then pass having
# watched no write at all; the trace arm below caught exactly that.
printf '{"type":"__jotSaveNow"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.5
rm -f "$SCRATCH_DIR/.debug-message.json"
if [ -e "$SCRATCH_DIR/Scratch pad.md" ]; then
    echo "deleted note         FAILED: the note came back after being deleted" >&2
    ls -l "$SCRATCH_DIR" >&2; exit 1
fi
# ...and the app REFUSED a write, rather than never having tried one. A file
# that is still absent says nothing about which of those happened, and only
# one of them is the fix.
if ! grep -q "^jot-trace noteMissing " "$LOG"; then
    echo "deleted note         FAILED: the note stayed deleted, but no write was ever refused" >&2
    echo "  (the check proved nothing: it cannot tell a guard from an absent write)" >&2
    grep -E "jot-trace (writeattempt|noteMissing)|jot-measure (visible|hide)" "$LOG" | tail -20 >&2; exit 1
fi
echo "deleted note         ok: the write was refused, and the note was not recreated"
# ...and the screen it puts up leaves the page's own controls reachable.
#
# Find, the checks, the outline and the SETTINGS gear are drawn by the page, in
# the titlebar band. Hiding the web view to wall off the document took all four
# with it, so a window whose file had just gone missing had no way to Settings
# except the menu bar, and somebody whose notes have just disappeared is exactly
# the person who wants to look at where they are kept.
#
# Geometry rather than a screenshot, and not as a compromise: a WKWebView
# contributes nothing to the PDF path `__jotSnapshot` uses, so a picture of this
# state cannot show the page's controls whether they are there or not.
MISSING="$(grep "^jot-trace missingscreen " "$LOG" | tail -1)"
case "$MISSING" in
    *"webviewHidden=false"*) ;;
    "") echo "missing screen       FAILED: the screen never reported its geometry" >&2; exit 1 ;;
    *) echo "missing screen       FAILED: the page is hidden, so Settings is unreachable: $MISSING" >&2; exit 1 ;;
esac
# ...and the card leaves the page's tooltip lane clear.
#
# Reachable and READABLE are two claims and only the first survives an opaque
# view starting at the band: the page draws the chip naming a titlebar button
# just under the band, so a covering that begins there hides the label of every
# control in the strip, the Settings gear's included.
#
# Against the LIVE chip rather than against the lane constant, which is what
# makes this the check and `MissingFileScreenTests` the floor. The chip's
# height is the page's to decide, so a value in Swift can be right on the day
# it is written and wrong after a font change nothing on that side can see.
# Both figures are in the page's coordinates, y down from the top of the
# window, which is the one convention they can be compared in.
show_panel
printf '{"type":"__jotHoverButton","index":0,"hovered":true}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.2
rm -f "$SCRATCH_DIR/.debug-message.json"
M_TIP="$(grep "^jot-trace hovertooltip " "$LOG" | tail -1 | sed 's/^jot-trace hovertooltip //')"
if [ -z "$M_TIP" ] || [ "$M_TIP" = "none" ]; then
    echo "missing screen       FAILED: with the note gone, pointing at a file button drew no tooltip" >&2
    echo "  trace: ${M_TIP:-<none>}" >&2; exit 1
fi
M_TIP_Y="$(echo "$M_TIP" | sed -n 's/.* y=\([0-9-]*\).*/\1/p')"
M_TIP_H="$(echo "$M_TIP" | sed -n 's/.* h=\([0-9-]*\).*/\1/p')"
printf '{"type":"__jotHoverButton","index":0,"hovered":false}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 0.6
rm -f "$SCRATCH_DIR/.debug-message.json"
M_CARD_TOP="$(printf '%s' "$MISSING" | sed -n 's/.*cardTop=\([0-9-]*\).*/\1/p')"
M_CARD_H="$(printf '%s' "$MISSING" | sed -n 's/.*cardH=\([0-9-]*\).*/\1/p')"
if [ -z "$M_CARD_TOP" ] || [ -z "$M_CARD_H" ] || [ "$M_CARD_H" -le 0 ]; then
    echo "missing screen       FAILED: no card was drawn, so the clearance below is about nothing: $MISSING" >&2
    exit 1
fi
if [ -z "$M_TIP_Y" ] || [ -z "$M_TIP_H" ] || [ "$M_CARD_TOP" -lt $((M_TIP_Y + M_TIP_H)) ]; then
    echo "missing screen       FAILED: the card covers the band's tooltip, so its controls cannot be named" >&2
    echo "  card top=$M_CARD_TOP  tooltip y=$M_TIP_Y h=$M_TIP_H" >&2; exit 1
fi
echo "missing screen       ok: the card starts at $M_CARD_TOP, clear of the tooltip ending at $((M_TIP_Y + M_TIP_H))"
# ...and the band itself is down to the one control that still has a job.
#
# With no file there is nothing for Find, the checks, the outline or the
# typography controls to act on. The gear is the exception, and it is the whole
# point of the state: on a panel with no Dock icon it is the way to
# preferences. The count comes off the same trace the two halves of the band
# are compared with, so a page that hid the lot would read as zero here rather
# than passing for being tidy.
M_PAGE_COUNT="$(grep "^jot-trace titlebarstrip " "$LOG" | tail -1 | sed -n 's/.*pageCount=\([0-9]*\).*/\1/p')"
if [ "${M_PAGE_COUNT:-0}" != "1" ]; then
    echo "missing screen       FAILED: the band holds ${M_PAGE_COUNT:-no} page controls, wanted the gear alone" >&2
    grep "^jot-trace titlebarstrip " "$LOG" | tail -1 | sed 's/^/  /' >&2; exit 1
fi
echo "missing screen       ok: the band is down to the Settings gear"
# ...and a reload while the note is missing leaves the panel still writable.
#
# The read side refuses while the note is gone, because the buffer is the only
# copy. `hasLoaded` is ASSIGNED from that refusal by its one caller, so a
# refusal reported as "not loaded" latches the panel unwritable for the rest of
# the session: Save It Back fails, and the new note started instead swallows
# every keystroke with nothing said. None of that is visible until somebody
# looks for their text, which is why it is a step here rather than a reading.
READY_BEFORE=$(marks ready)
printf '{"type":"__jotReload"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID
wait_for debug-reload 5
# The message arriving is not the gesture. A remount is, and `.ready` marks
# one, so this waits for a NEW one: without it both assertions below pass
# trivially when the reload never happened, since nothing recreated the file
# and nothing downgraded the flag either. An instrument that measured nothing
# reports success.
RELOAD_WAIT=0
while [ "$(marks ready)" -le "$READY_BEFORE" ]; do
    sleep 0.1; RELOAD_WAIT=$((RELOAD_WAIT + 1))
    if [ $RELOAD_WAIT -gt 100 ]; then
        echo "deleted note         FAILED: the reload never remounted the page" >&2
        echo "  (so the check below would have proved nothing)" >&2; exit 1
    fi
done
rm -f "$SCRATCH_DIR/.debug-message.json"
if [ -e "$SCRATCH_DIR/Scratch pad.md" ]; then
    echo "deleted note         FAILED: reloading recreated the deleted note" >&2; exit 1
fi

# Put it back the way the panel's own button does, so the checks below have a
# file to read. This is also the only exercise Save It Back gets, and after the
# reload above it is what says the panel is still writable.
show_panel
printf '{"type":"__jotSaveMissingBack"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.2
rm -f "$SCRATCH_DIR/.debug-message.json"
if [ ! -e "$SCRATCH_DIR/Scratch pad.md" ]; then
    echo "deleted note         FAILED: Save It Back did not write the note" >&2; exit 1
fi
# The buffer, not an empty file: `$STAMP` is what the persistence check above
# typed, and it is still what the panel is holding.
if grep -q "$STAMP" "$SCRATCH_DIR/Scratch pad.md"; then
    echo "deleted note         ok: Save It Back writes the buffer back to the path it came from"
else
    echo "deleted note         FAILED: Save It Back wrote a file without the buffer in it" >&2
    cat "$SCRATCH_DIR/Scratch pad.md" >&2; exit 1
fi

# The system date picker opens AT THE CARET.
#
# `/date` hands the page's caret rectangle to the shell, and the shell turns
# viewport coordinates into the web view's own. That conversion is the only one
# in the app and sits in a target no unit test reaches; `CaretAnchorTests`
# covers the arithmetic, and what it cannot see is `isFlipped` on the real
# view. A `WKWebView` is flipped, so the page's y passes straight through, and
# a conversion written for AppKit's usual bottom-left origin mirrors a caret
# near the top of the panel to the bottom of the window. The popover opens
# either way, which is why this is a number rather than a look.
show_panel
# Retried, because the gesture can be dropped for a reason that is not the
# thing under test. An accessory app driven from a shell frequently cannot
# take activation (the paste check above carries the same warning), and a
# burst of keys sent while the panel is not key reaches nothing at all. That
# made this arm fail about one run in several, and an arm people learn to
# re-run past is an arm that will be re-run past on the day it is right.
#
# Two batches per attempt, because the slash menu renders asynchronously:
# Return sent in the same burst as the query arrives before there is a row to
# choose. Escape first, so a previous attempt that got half way leaves no menu
# open for this one to type into.
DATEPICK=""
for attempt in 1 2 3; do
    printf '{"type":"__jotKeys","keys":["Escape","End","Enter","/","d","a","t","e"]}' > "$SCRATCH_DIR/.debug-message.json"
    kill -URG $PID; sleep 1.5
    rm -f "$SCRATCH_DIR/.debug-message.json"
    printf '{"type":"__jotKeys","keys":["Enter"]}' > "$SCRATCH_DIR/.debug-message.json"
    kill -URG $PID; sleep 1.5
    rm -f "$SCRATCH_DIR/.debug-message.json"
    DATEPICK="$(grep "^jot-trace datepicker " "$LOG" | tail -1 || true)"
    [ -n "$DATEPICK" ] && break
    # Dismiss whatever did land, and ask for the window again.
    printf '{"type":"__jotKeys","keys":["Escape"]}' > "$SCRATCH_DIR/.debug-message.json"
    kill -URG $PID; sleep 0.5
    rm -f "$SCRATCH_DIR/.debug-message.json"
    show_panel
done
if [ -n "$DATEPICK" ] && [ "$attempt" -gt 1 ]; then
    echo "date picker          (took $attempt attempts; the panel was slow to take key focus)"
fi
DP_PAGE_TOP="$(echo "$DATEPICK" | sed -n 's/.*pageTop=\([0-9.-]*\).*/\1/p')"
DP_ANCHOR_Y="$(echo "$DATEPICK" | sed -n 's/.*anchorY=\([0-9.-]*\).*/\1/p')"
DP_FLIPPED="$(echo "$DATEPICK" | sed -n 's/.*flipped=\([a-z]*\).*/\1/p')"
if [ -z "$DATEPICK" ]; then
    echo "date picker          FAILED: /date asked for no picker at all" >&2
    echo "  (the slash menu may not have opened; nothing was traced)" >&2; exit 1
fi
# The page's own y and the anchor's must be the SAME number in a flipped view.
# Asserted against `pageTop`, which the page measured, rather than against a
# constant: a caret anywhere in the panel satisfies this and only an inverted
# conversion fails it.
if [ "$DP_FLIPPED" = "yes" ] && awk "BEGIN{exit !(($DP_ANCHOR_Y - $DP_PAGE_TOP) < 0.5 && ($DP_PAGE_TOP - $DP_ANCHOR_Y) < 0.5)}"; then
    echo "date picker          ok: anchored at the caret (page y=$DP_PAGE_TOP, anchor y=$DP_ANCHOR_Y)"
else
    echo "date picker          FAILED: the picker is not anchored where the caret is" >&2
    echo "  $DATEPICK" >&2; exit 1
fi
# Dismiss it, and undo the "/date" the slash menu consumed, so everything below
# reads the buffer it expects.
printf '{"type":"__jotKeys","keys":["Escape"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 0.8
rm -f "$SCRATCH_DIR/.debug-message.json"

# The panel sits at the ordinary window level, where anything else can cover
# it. Read from the live window rather than from the source: `NSPanel` is
# `.floating` by default and `isFloatingPanel` sets that level, so a panel's
# level is never the absence of a line, and a release shipped floating while
# three comments and a changelog entry said it did not. 0 is
# `NSWindow.Level.normal`; `.floating` is 3.
LEVELTRACE="$(grep "^jot-trace windowlevel " "$LOG" | tail -1 || true)"
WIN_LEVEL="$(echo "$LEVELTRACE" | sed -n 's/.*level=\([0-9-]*\).*/\1/p')"
if [ -z "$LEVELTRACE" ]; then
    echo "window level         FAILED: the app reported no window-level trace at all" >&2; exit 1
fi
if [ "$WIN_LEVEL" = "0" ]; then
    echo "window level         ok: normal, so another app's window can cover the panel"
else
    echo "window level         FAILED: expected 0 (normal), got $WIN_LEVEL" >&2
    echo "$LEVELTRACE" >&2; exit 1
fi

# The window's own title. A titlebar accessory is placed by AppKit inside a
# band this panel has made transparent and full-height, so whether it arrived,
# arrived empty, or arrived under the traffic lights is a question no unit test
# and no browser harness can answer. The app reports its live frame as a
# `jot-trace titlebar` line (Coordinator.traceTitleBar) and this reads it.
TITLEBAR="$(grep "^jot-trace titlebar " "$LOG" | tail -1 || true)"
TB_X="$(echo "$TITLEBAR" | sed -n 's/.*x=\([0-9.-]*\).*/\1/p')"
TB_W="$(echo "$TITLEBAR" | sed -n 's/.*w=\([0-9.-]*\).*/\1/p')"
TB_ATTACHED="$(echo "$TITLEBAR" | sed -n 's/.*attached=\([a-z]*\).*/\1/p')"
TB_TEXT="$(echo "$TITLEBAR" | sed -n 's/.*text=//p')"
TB_TEXT_MID="$(echo "$TITLEBAR" | sed -n 's/.*textMidY=\([0-9.-]*\).*/\1/p')"
TB_CLOSE_MID="$(echo "$TITLEBAR" | sed -n 's/.*closeMidY=\([0-9.-]*\).*/\1/p')"
TB_CELL="$(echo "$TITLEBAR" | sed -n 's/.*cellW=\([0-9.-]*\).*/\1/p')"
if [ -z "$TITLEBAR" ]; then
    echo "titlebar             FAILED: the app reported no titlebar trace at all" >&2; exit 1
fi
# `attached` is NOT the answer. It says AppKit accepted the accessory, and the
# question is whether anything is on screen; the two agree often enough that
# the flag reads like evidence for the second one, and they part company
# exactly here. A zero width is an accessory that arrived and drew nothing,
# which looks identical on screen to one that never arrived and identical in
# the view hierarchy to one that worked. The width is what discriminates.
#
# 78 is not a number this repo owns: AppKit places a leading accessory clear of
# the three window buttons itself, so the check measures the SYSTEM'S placement
# rather than our arithmetic, and would fail if that inset ever moved. A
# constant of ours here would have agreed with itself forever.
if [ "$TB_ATTACHED" = "yes" ] \
   && awk "BEGIN{exit !($TB_W > 0)}" \
   && awk "BEGIN{exit !($TB_X >= 78)}" \
   && [ "$TB_TEXT" = "Scratch pad.md" ]; then
    echo "titlebar             ok: \"$TB_TEXT\" at x=$TB_X w=$TB_W, clear of the window buttons"
else
    echo "titlebar             FAILED: expected an attached accessory naming 'Scratch pad.md' at x>=78 with width>0" >&2
    echo "$TITLEBAR" >&2; exit 1
fi

# The title is drawn IN FULL, in PIXELS, which every other check here is blind
# to and which took a defect shipping to establish.
#
# `text=` is the accessibility label and `titletext` is the label's
# `stringValue`. Both report the whole string whatever is on screen. So do the
# label's frame, its `visibleRect`, and the height the string lays out in. All
# of them agreed that "Birta Jot.md" was fine while the window drew "Birta":
# the field had not been told a title is one line, so it was free to WRAP at the
# space, and the second line was clipped by a box one line tall. A name cut that
# way carries no ellipsis, so it reads as a shorter NAME rather than as damage,
# and nobody investigates a title that looks like a filename.
#
# `inkW` is the rightmost column of the label carrying any alpha, measured from
# a bitmap of the label itself. In the broken build every number above was
# identical to the fixed one and this was 32.5 against 65.0.
#
# The name driving it has a SPACE in it, deliberately: without one there is no
# wrap point, and the default `Scratchpad.md` passed this bug for its whole
# life.
TB_NEED_W="$(echo "$TITLEBAR" | sed -n 's/.*needW=\([0-9.-]*\).*/\1/p')"
TB_GOT_W="$(echo "$TITLEBAR" | sed -n 's/.*gotW=\([0-9.-]*\).*/\1/p')"
TB_INK_W="$(echo "$TITLEBAR" | sed -n 's/.*inkW=\([0-9.-]*\).*/\1/p')"
if [ -z "$TB_NEED_W" ] || [ -z "$TB_INK_W" ]; then
    echo "title ink            FAILED: the trace carried no needW/inkW to compare" >&2
    echo "$TITLEBAR" >&2; exit 1
fi
# A zero need is a title that has not painted, and zero ink would agree with it
# perfectly. Asserted before the comparison, for the same reason the baseline
# check asserts its two midpoints are non-zero.
# The box is compared against what the CELL needs, not against what the string
# measures. Those are different numbers, the cell's is the larger, and the gap
# between them is one glyph: a label sized to the string draws the tail of the
# name outside its own box and the titlebar clips it. `Birta Writer.md`
# lost the `d` that way, with `needW`, `gotW` and `inkW` all agreeing it was
# fine, because all three describe the string.
if awk "BEGIN{exit !($TB_NEED_W > 0)}" \
   && awk "BEGIN{exit !($TB_CELL > 0)}" \
   && awk "BEGIN{exit !($TB_GOT_W >= $TB_CELL - 0.1)}" \
   && awk "BEGIN{exit !($TB_INK_W >= $TB_NEED_W - 2)}"; then
    echo "title ink            ok: the label has the room the cell asked for (got $TB_GOT_W, cell needs $TB_CELL, ink $TB_INK_W)"
else
    echo "title ink            FAILED: the title is not drawn in full" >&2
    echo "  needs=$TB_NEED_W cellNeeds=$TB_CELL got=$TB_GOT_W ink=$TB_INK_W" >&2
    echo "$TITLEBAR" >&2; exit 1
fi

# The title's two width measurements must AGREE, and that is a different claim
# from either of them being right.
#
# `needW` asks the attributed string and `fieldW` asks the field. The string
# answers in whatever font it carries; the field knows its own. So they agree
# only while `paint` puts the font on the string, and diverge by about a fifth
# the moment it does not.
#
# This exists because the ink check above CANNOT see that failure. Sized off a
# font-blind string the label comes out short, the cell truncates the name into
# it, and the ink then reaches the short width it was given, so ink against
# needs passes on a visibly cut title. It did: 83.0 of ink against 84.0 of
# need, on a name whose glyphs want 102.7.
TB_FIELD_W="$(echo "$TITLEBAR" | sed -n 's/.*fieldW=\([0-9.-]*\).*/\1/p')"
if [ -n "$TB_FIELD_W" ] \
   && awk "BEGIN{exit !($TB_FIELD_W > 0)}" \
   && awk "BEGIN{d = $TB_NEED_W - $TB_FIELD_W; if (d < 0) d = -d; exit !(d <= 1.5)}"; then
    echo "title measure        ok: the string and the field report the same width ($TB_NEED_W, $TB_FIELD_W)"
else
    echo "title measure        FAILED: the title's two width measurements disagree, so one of them is not about the drawing" >&2
    echo "  needW=$TB_NEED_W fieldW=$TB_FIELD_W" >&2
    echo "$TITLEBAR" >&2; exit 1
fi

# The hover chevron beside the title, which says the name opens something.
#
# Four numbers, and the DIFFERENCE between two of them is the claim. An image
# view that never draws and one that never hides both report a single alpha
# quite happily, so `restAlpha` against `overAlpha` is what says the affordance
# appears at all, and `restInk` against `overInk` is what says the appearing is
# pixels rather than a frame nobody fills.
#
# `hasImage` is the arm that stops the rest reporting healthily about nothing:
# NSImage(systemSymbolName:) answers nil for a name the system does not carry,
# and an image view holding nil draws nothing and raises nothing.
#
# `x` against the name's own trailing edge is what keeps it AFTER the title
# rather than over it. The width is reserved whether or not the chevron is
# drawn, so this holds in both states and the title never moves under the
# pointer.
#
# Not covered: that the tracking area fires. A script has no pointer without an
# Accessibility grant, so the hover state is set rather than performed, and
# whether a real mouse reaches this view is the one part of it only a person
# can see.
CHEV="$(grep "^jot-trace chevron " "$LOG" | tail -1 || true)"
CH_IMG="$(echo "$CHEV" | sed -n 's/.*hasImage=\([a-z]*\).*/\1/p')"
CH_X="$(echo "$CHEV" | sed -n 's/.*chevron hasImage=[a-z]* x=\([0-9.-]*\).*/\1/p')"
CH_W="$(echo "$CHEV" | sed -n 's/.* w=\([0-9.-]*\).*/\1/p')"
CH_REST="$(echo "$CHEV" | sed -n 's/.*restAlpha=\([0-9.-]*\).*/\1/p')"
CH_OVER="$(echo "$CHEV" | sed -n 's/.*overAlpha=\([0-9.-]*\).*/\1/p')"
CH_REST_INK="$(echo "$CHEV" | sed -n 's/.*restInk=\([0-9.-]*\).*/\1/p')"
CH_OVER_INK="$(echo "$CHEV" | sed -n 's/.*overInk=\([0-9.-]*\).*/\1/p')"
CH_TEXT_MAX="$(echo "$CHEV" | sed -n 's/.*textMaxX=\([0-9.-]*\).*/\1/p')"
if [ -z "$CHEV" ]; then
    echo "title chevron        FAILED: the app reported no chevron trace at all" >&2; exit 1
fi
if [ "$CH_IMG" = "yes" ] \
   && awk "BEGIN{exit !($CH_W > 0)}" \
   && awk "BEGIN{exit !($CH_REST == 0)}" \
   && awk "BEGIN{exit !($CH_OVER == 1)}" \
   && awk "BEGIN{exit !($CH_REST_INK == 0)}" \
   && awk "BEGIN{exit !($CH_OVER_INK > 0)}" \
   && awk "BEGIN{exit !($CH_X >= $CH_TEXT_MAX)}"; then
    echo "title chevron        ok: hidden at rest, drawn on hover (ink $CH_REST_INK -> $CH_OVER_INK), after the name at x=$CH_X"
else
    echo "title chevron        FAILED: the hover affordance is not there, not drawn, or not after the name" >&2
    echo "$CHEV" >&2; exit 1
fi

# The two file buttons beside the title: New Note and Open.
#
# `symbols` against `count` is the arm that stops everything else here
# reporting healthily about two blank boxes, for the reason `hasImage` exists
# above: a withdrawn or renamed SF Symbol leaves buttons that are positioned,
# offered and drawing nothing.
#
# `restShown` against `overShown` is the affordance appearing at all, and
# `restBoxes` against `overBoxes` is the claim the chevron's arm cannot make:
# the geometry must be IDENTICAL between the two. The drag strip is laid out by
# the window and starts where this accessory ends, so a width taken on hover
# would leave the strip over the buttons it made room for, and every click on
# them would drag the window instead. That failure is invisible in a
# screenshot, because both states look right on their own.
#
# Not covered, and the same gap as the chevron's: whether a real pointer
# reaches the tracking areas. The state is set rather than performed.
ACTS="$(grep "^jot-trace titleactions " "$LOG" | tail -1 || true)"
AC_COUNT="$(echo "$ACTS" | sed -n 's/.*count=\([0-9]*\).*/\1/p')"
AC_SYMS="$(echo "$ACTS" | sed -n 's/.*symbols=\([0-9]*\).*/\1/p')"
AC_REST="$(echo "$ACTS" | sed -n 's/.*restShown=\([a-z]*\).*/\1/p')"
AC_OVER="$(echo "$ACTS" | sed -n 's/.*overShown=\([a-z]*\).*/\1/p')"
AC_REST_BOX="$(echo "$ACTS" | sed -n 's/.*restBoxes=\([0-9.,:]*\).*/\1/p')"
AC_OVER_BOX="$(echo "$ACTS" | sed -n 's/.*overBoxes=\([0-9.,:]*\).*/\1/p')"
AC_CHEV_MAX="$(echo "$ACTS" | sed -n 's/.*chevronMaxX=\([0-9.-]*\).*/\1/p')"
AC_FIRST_X="$(echo "$AC_OVER_BOX" | cut -d, -f1 | cut -d: -f1)"
# How many buttons there SHOULD be, read from the one place that decides it
# rather than written down here. A literal is a number a fourth button never
# joins: it would draw correctly, resolve its symbol, and fail this line with a
# message about a missing symbol.
#
# It reads `TitlebarActionsView.shipped`, which is where the set is declared.
# A scrape names a file, so MOVING the declaration empties it silently unless
# the scrape moves too; this one is loud rather than silent, because a count of
# zero is refused below, and that is the only reason the move was safe.
AC_WANT="$(awk '/static let shipped: \[Action\] = \[/{f=1;next} f&&/^ *\]/{exit} f&&/\.init\(selector:/{n++} END{print n+0}' \
    jot/Sources/BirtaJot/TitlebarActions.swift)"
if [ -z "$ACTS" ]; then
    echo "titlebar buttons     FAILED: the app reported no titleactions trace at all" >&2; exit 1
fi
# The instrument's own arm: a scrape that matched nothing would otherwise make
# every comparison below trivially true of an app with no buttons at all.
if [ "${AC_WANT:-0}" -lt 1 ]; then
    echo "titlebar buttons     FAILED: found no setActions declaration to compare against" >&2; exit 1
fi
if [ "$AC_COUNT" = "$AC_WANT" ] && [ "$AC_SYMS" = "$AC_WANT" ] \
   && [ "$AC_REST" = "no" ] && [ "$AC_OVER" = "yes" ] \
   && [ -n "$AC_REST_BOX" ] && [ "$AC_REST_BOX" = "$AC_OVER_BOX" ] \
   && awk "BEGIN{exit !($AC_FIRST_X >= $AC_CHEV_MAX)}"; then
    echo "titlebar buttons     ok: $AC_WANT symbols, hidden at rest and offered on hover, room held either way ($AC_OVER_BOX)"
else
    echo "titlebar buttons     FAILED: a button or a symbol is missing (wanted $AC_WANT), the buttons never appear, or the room moves on hover" >&2
    echo "$ACTS" >&2; exit 1
fi

# WHERE the title sits vertically, which the check above says nothing about: it
# reads the accessory's frame, and the accessory is the whole titlebar band, so
# a title drawn 2pt low passed it exactly as a correct one did. It did, for a
# day.
#
# The close button is the reference, and it is a property of the system rather
# than of a screenshot: macOS puts a window title's vertical centre exactly on
# the close button's, and does so at every titlebar height and title font it
# uses. Measured against a probe window: unified (52pt bar), unifiedCompact
# (76pt) and expanded (84pt) all agree to 0.0pt, at 13pt and 15pt titles. So
# "the title is where macOS would put it" is answerable inside our own window,
# with no second application running and no reference image.
#
# One point of tolerance, for the rounding a half-point font metric can leave.
if [ -z "$TB_TEXT_MID" ] || [ -z "$TB_CLOSE_MID" ]; then
    echo "title baseline       FAILED: the trace carried no textMidY/closeMidY to compare" >&2
    echo "$TITLEBAR" >&2; exit 1
fi
# A zero on either side is a frame that was never resolved, and two zeros agree
# with each other perfectly. Asserted before the delta, for that reason.
if awk "BEGIN{exit !($TB_CLOSE_MID > 0 && $TB_TEXT_MID > 0)}" \
   && awk "BEGIN{exit !(($TB_TEXT_MID - $TB_CLOSE_MID) <= 1 && ($TB_CLOSE_MID - $TB_TEXT_MID) <= 1)}"; then
    echo "title baseline       ok: title centred on the window buttons (text=$TB_TEXT_MID close=$TB_CLOSE_MID)"
else
    echo "title baseline       FAILED: macOS centres a title on the close button; ours is off" >&2
    echo "  textMidY=$TB_TEXT_MID closeMidY=$TB_CLOSE_MID" >&2
    echo "$TITLEBAR" >&2; exit 1
fi

# The band as ONE strip. The check above puts the native half where macOS would
# put it; this one asks whether the page's half is drawn to meet it.
#
# The two halves are built by different toolkits out of different numbers, and
# each is defensible on its own, which is why nothing caught them disagreeing:
# the native buttons are AppKit views centred on the titlebar band, and the
# page's are HTML in a row with its own padding. A screenshot shows both and
# says nothing about the pair, and no browser can be asked, because only this
# window puts the two in one band.
#
# Four claims, each a way the pair has actually been wrong: the glyphs sit on
# one axis, in one size of box, with one width of air between them, and hover
# is said the same way on both halves.
#
# HALF a point of tolerance, and the number is load-bearing rather than picked
# to look careful. A whole point of difference between the two axes is a real
# misalignment and is plainly visible in the band, so a tolerance of a whole
# point would report the two halves as agreeing in exactly the case this check
# exists to catch: slack the size of the defect is slack that hides it.
# Everything compared here is a box on a whole-pixel grid rather than a glyph
# on a baseline, so half a point is still room for what rounding can leave.
#
# The wash is a yes/no rather than a colour comparison, and deliberately: the
# native half takes that colour FROM the page, so comparing the two would be
# asking a value whether it equals itself. What can actually go wrong is that
# it never arrives, and a button that says nothing under the pointer is what
# that looks like.
STRIP="$(grep "^jot-trace titlebarstrip " "$LOG" | tail -1 || true)"
strip_field() { echo "$STRIP" | sed -n "s/.*$1=\([0-9.-]*\).*/\1/p"; }
ST_N_COUNT="$(strip_field nativeCount)"
ST_N_MID="$(strip_field nativeMidY)"
ST_N_BW="$(strip_field nativeBoxW)"
ST_N_BH="$(strip_field nativeBoxH)"
ST_N_GAP="$(strip_field nativeGap)"
ST_N_WASH="$(echo "$STRIP" | sed -n 's/.*nativeWash=\([a-z]*\).*/\1/p')"
ST_P_COUNT="$(strip_field pageCount)"
ST_P_MID="$(strip_field pageMidY)"
ST_P_BW="$(strip_field pageBoxW)"
ST_P_BH="$(strip_field pageBoxH)"
ST_P_GAP="$(strip_field pageGap)"
ST_P_ROWH="$(strip_field pageRowH)"
ST_P_PAD="$(strip_field pageRowPadTop)"
ST_P_VAR="$(echo "$STRIP" | sed -n 's/.*pageBandVar=\([^ ]*\).*/\1/p')"
if [ -z "$STRIP" ]; then
    echo "titlebar strip       FAILED: the app reported no titlebarstrip trace at all" >&2; exit 1
fi
# The instrument's own arm, and it is not decoration: two empty halves agree
# with each other on every number below. A gap needs two buttons on each side,
# so that is what is demanded rather than one.
if ! awk "BEGIN{exit !(${ST_N_COUNT:-0} > 1 && ${ST_P_COUNT:-0} > 1)}"; then
    echo "titlebar strip       FAILED: one half of the band reported no buttons, so the comparison is empty" >&2
    echo "$STRIP" >&2; exit 1
fi
near() { awk -v a="$1" -v b="$2" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= 0.5) }'; }
if near "$ST_N_MID" "$ST_P_MID" \
   && near "$ST_N_BW" "$ST_P_BW" \
   && near "$ST_N_BH" "$ST_P_BH" \
   && near "$ST_N_GAP" "$ST_P_GAP" \
   && [ "$ST_N_WASH" = "yes" ]; then
    echo "titlebar strip       ok: native y=$ST_N_MID page y=$ST_P_MID, ${ST_N_BW}x${ST_N_BH} boxes ${ST_N_GAP}pt apart, hover washed"
else
    echo "titlebar strip       FAILED: the two halves of the band are not drawn as one strip" >&2
    echo "  native midY=$ST_N_MID box=${ST_N_BW}x${ST_N_BH} gap=$ST_N_GAP wash=$ST_N_WASH" >&2
    echo "  page   midY=$ST_P_MID box=${ST_P_BW}x${ST_P_BH} gap=$ST_P_GAP" >&2
    # WHICH half failed, for the axis, which the midYs alone cannot say. The
    # page's row is centred by taking the band's height; the two ways that goes
    # wrong are the height never arriving (the row keeps its fallback) and the
    # height arriving into a row something else is still padding.
    echo "  page   row=${ST_P_ROWH}pt padTop=${ST_P_PAD}pt bandVar=$ST_P_VAR" >&2
    exit 1
fi

# The label a titlebar button shows, drawn by the PAGE.
#
# These buttons used `NSView.toolTip` and that was unaskable: a system tooltip
# is drawn by the window server out of any view this app can read, so whether
# it appeared needed a real pointer and a screenshot, and the check that stood
# here asserted the STRING was set instead. That is a claim about a property,
# and it passed happily for as long as the tooltip was never delivered at all.
#
# Drawn by the page, the chip is an element, and the whole chain is answerable
# in the running window: a pointer arrives on an AppKit button, the shell turns
# its box into the page's coordinates, the page draws the chip there. Every
# link in that is a way this fails silently, and the box is the one worth
# saying twice: window coordinates grow upward and the page's grow downward, so
# an inversion draws a correct label at the wrong end of the window and nothing
# else notices.
show_panel
printf '{"type":"__jotHoverButton","index":0,"hovered":true}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.0
rm -f "$SCRATCH_DIR/.debug-message.json"
TIP="$(grep "^jot-trace hovertooltip " "$LOG" | tail -1 | sed 's/^jot-trace hovertooltip //')"
TIP_TEXT="$(echo "$TIP" | sed -n 's/.*text="\([^"]*\)".*/\1/p')"
TIP_Y="$(echo "$TIP" | sed -n 's/.* y=\([0-9-]*\).*/\1/p')"
TIP_W="$(echo "$TIP" | sed -n 's/.* w=\([0-9-]*\).*/\1/p')"
# Where the button IS, so the chip can be checked against it rather than
# against a number written here. The strip trace carries the band's own axis.
TIP_BAND="$(grep "^jot-trace titlebarstrip " "$LOG" | tail -1 | sed -n 's/.*nativeMidY=\([0-9.]*\).*/\1/p')"
if [ -z "$TIP" ] || [ "$TIP" = "none" ]; then
    echo "titlebar tooltip     FAILED: pointing at a file button drew no tooltip in the page" >&2
    echo "  trace: ${TIP:-<none>}" >&2; exit 1
fi
# The text is the menu row's, so it names the button and carries its chord.
# Compared against the row rather than a literal, for the reason the Swift
# check gives: a tooltip is a claim about a binding.
case "$TIP_TEXT" in
    "New Note"*"N") TIP_TEXT_OK=1 ;;
    *) TIP_TEXT_OK=0 ;;
esac
# BELOW the band, which is the half a wrong flip gets wrong: inverted, the chip
# lands near the bottom of the window with a perfectly correct label in it.
TIP_BELOW=0
if [ -n "$TIP_Y" ] && [ -n "$TIP_BAND" ]; then
    awk "BEGIN{exit !($TIP_Y > $TIP_BAND && $TIP_Y < $TIP_BAND + 60)}" && TIP_BELOW=1
fi
if [ "$TIP_TEXT_OK" = 1 ] && [ "$TIP_BELOW" = 1 ] && [ "${TIP_W:-0}" -gt 0 ]; then
    echo "titlebar tooltip     ok: the page drew \"$TIP_TEXT\" at y=$TIP_Y, just under the band at $TIP_BAND"
else
    echo "titlebar tooltip     FAILED: the page drew a tooltip, but not the right one or not in the right place" >&2
    echo "  text=\"$TIP_TEXT\" y=$TIP_Y w=$TIP_W band=$TIP_BAND" >&2; exit 1
fi
# And it goes when the pointer does, or it sits over the document naming a
# button nobody is pointing at.
printf '{"type":"__jotHoverButton","index":0,"hovered":false}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.0
rm -f "$SCRATCH_DIR/.debug-message.json"
if [ "$(grep "^jot-trace hovertooltip " "$LOG" | tail -1 | sed 's/^jot-trace hovertooltip //')" = "none" ]; then
    echo "titlebar tooltip     ok: and it goes away when the pointer leaves"
else
    echo "titlebar tooltip     FAILED: the tooltip outlived the pointer" >&2
    grep "^jot-trace hovertooltip " "$LOG" | tail -2 | sed 's/^/  /' >&2; exit 1
fi

# The formatting row, in THIS window rather than in a browser. The panel's own
# page carries CSS the harness does not (the titlebar carve-out, the at-rest
# fade), so "it renders in WebKit" and "it renders here" are separate claims,
# and only one of them has a browser that can answer it.
DOCK="$(grep "^jot-trace dock " "$LOG" | tail -1 | sed 's/^jot-trace dock //')"
FR_X="$(echo "$DOCK" | sed -n 's/.*x=\([0-9-]*\).*/\1/p')"
FR_W="$(echo "$DOCK" | sed -n 's/.* w=\([0-9-]*\).*/\1/p')"
FR_Y="$(echo "$DOCK" | sed -n 's/.*y=\([0-9-]*\).*/\1/p')"
FR_H="$(echo "$DOCK" | sed -n 's/.* h=\([0-9-]*\).*/\1/p')"
FR_IN_BAR="$(echo "$DOCK" | sed -n 's/.*inBar=\([a-z]*\).*/\1/p')"
FR_BAR_BOTTOM="$(echo "$DOCK" | sed -n 's/.*barBottom=\([0-9-]*\).*/\1/p')"
FR_BAR_HEIGHT="$(echo "$DOCK" | sed -n 's/.*barHeight=\([0-9-]*\).*/\1/p')"
FR_TOGGLE_W="$(echo "$DOCK" | sed -n 's/.*toggleW=\([0-9-]*\).*/\1/p')"
FR_TOGGLE_IN_ROW="$(echo "$DOCK" | sed -n 's/.*toggleInRow=\([a-z]*\).*/\1/p')"
FR_EXPANDED="$(echo "$DOCK" | sed -n 's/.*expanded=\([a-z]*\).*/\1/p')"
if [ -z "$DOCK" ] || [ "$DOCK" = "absent" ]; then
    echo "formatting row       FAILED: the page reported no formatting row (\"$DOCK\")" >&2; exit 1
fi
# The seed above has to have taken, or every geometry check below runs against
# a hidden row whose zeros agree with each other.
if [ "$FR_EXPANDED" != "true" ]; then
    echo "formatting row       FAILED: the saved open flag did not restore; nothing below was measured" >&2
    echo "$DOCK" >&2; exit 1
fi
# In the bar and at the bottom of it, which is the arrangement's whole claim.
# Parentage AND geometry, because either alone passes on a page that has the
# other wrong: a row drawn at the right pixels but parented to the body takes
# none of the bar's protections, and a row inside the bar drawn somewhere else
# is a layout bug the parent check cannot see. The toggle is checked as NOT in
# the row, because a toggle that opens a row it lives in keeps that row's
# height reserved even when closed.
# At the WINDOW'S leading edge, which is the one thing only this script can
# check: the browser harness page carries no traffic-light inset, so the
# difference between a row indented to clear buttons that are not on its row
# and a row starting at the window's edge does not exist there. The first row
# is inset by 78; this one must not be.
if awk "BEGIN{exit !($FR_X <= 1)}" && awk "BEGIN{exit !($FR_W > 0)}" \
   && [ "$FR_IN_BAR" = "true" ] \
   && [ "$FR_TOGGLE_IN_ROW" = "false" ] \
   && awk "BEGIN{exit !($FR_TOGGLE_W > 0)}" \
   && awk "BEGIN{exit !($FR_BAR_HEIGHT > 0)}" \
   && awk "BEGIN{exit !(($FR_Y + $FR_H) >= $FR_BAR_BOTTOM - 1 && ($FR_Y + $FR_H) <= $FR_BAR_BOTTOM + 1)}"; then
    echo "formatting row       ok: $DOCK"
else
    echo "formatting row       FAILED: expected a row at the window's leading edge, inside the bar, with its toggle outside it" >&2
    echo "$DOCK" >&2; exit 1
fi

# The Edited flag. It claims the buffer holds bytes the file does not, which is
# a claim about a real file that no unit test can check: `WindowTitle` decides
# what the suffix says, and this is what decides WHEN.
#
# Driven with autosave OFF, which is the only setting the suffix is drawn
# under. With it on the flag still rises and falls between a keystroke and a
# write, and the title deliberately says nothing about it; the stability check
# below is what covers that case.
#
# The write is a SAVE, not a hide, and the difference cost an afternoon. The
# hide this used to rely on stops working partway through a run: `hide()` calls
# `NSApp.hide`, and an accessory app driven from a shell often cannot come
# forward again, so every window reports `isVisible == false` from then on and
# the toggle shows instead of hiding, forever. The earlier checks kept passing
# because autosave was writing for them; this one was the only check whose
# claim actually needed the hide, so it was the only one that failed, and it
# failed looking exactly like a broken title.
defaults write "$BIRTA_JOT_DEFAULTS_SUITE" autosave -bool NO
show_panel
printf '{"type":"__jotKeys","keys":["End","Enter","d","i","r","t","y"]}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2
TITLE_DIRTY="$(grep "^jot-trace titletext " "$LOG" | tail -1 | sed 's/^jot-trace titletext //')"
printf '{"type":"__jotSave"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2
TITLE_CLEAN="$(grep "^jot-trace titletext " "$LOG" | tail -1 | sed 's/^jot-trace titletext //')"
defaults delete "$BIRTA_JOT_DEFAULTS_SUITE" autosave >/dev/null 2>&1 || true
rm -f "$SCRATCH_DIR/.debug-message.json"
# The save has to have HAPPENED. Without this a `__jotSave` the app ignored
# would leave the title untouched, and "untouched" is indistinguishable from
# "cleared" when the check only reads the last line.
if [ "$(marks debug-save)" -lt 1 ]; then
    echo "edited flag          FAILED: the app never acted on __jotSave, so nothing was written" >&2
    exit 1
fi
case "$TITLE_DIRTY" in
    *Edited) EDITED_ROSE=1 ;;
    *) EDITED_ROSE=0 ;;
esac
case "$TITLE_CLEAN" in
    *Edited) EDITED_FELL=0 ;;
    *) EDITED_FELL=1 ;;
esac
if [ "$EDITED_ROSE" = 1 ] && [ "$EDITED_FELL" = 1 ]; then
    echo "edited flag          ok: \"$TITLE_DIRTY\" while unwritten, \"$TITLE_CLEAN\" after Save"
else
    echo "edited flag          FAILED: expected the suffix to appear on an edit and go on the write" >&2
    echo "  after typing: \"$TITLE_DIRTY\"" >&2
    echo "  after hiding: \"$TITLE_CLEAN\"" >&2
    # Every repaint, in order. The two samples above say WHAT the title reads
    # at two moments and nothing about how it got there, and the difference
    # between "it never cleared" and "it cleared and something set it again"
    # is the whole diagnosis.
    echo "  every title repaint this run:" >&2
    grep "^jot-trace titletext " "$LOG" | sed 's/^jot-trace titletext /    /' >&2
    echo "  app log: $LOG" >&2
    exit 1
fi

# The title holds still while you type, which is the case the check above
# cannot reach: it drives autosave OFF, where the flag rises once and stays.
#
# With autosave ON the flag goes up on every admitted update and down on every
# write, several times a sentence, and drawing it would put a word in the
# titlebar that appears and vanishes while you look at it. The title is not
# supposed to change at all here, so this is asserted over a BURST rather than
# from a sample: a single reading catches one side of a flicker and passes
# about half the time. `Coordinator.refreshTitle` traces on every call, not
# every change, precisely so this can count.
#
# Autosave is the default, so the setting is simply left alone.
show_panel
BURST_START=$(grep -c "^jot-trace titletext " "$LOG")
BURST_WORDS=""
# Two groups with a pause between them, rather than one long burst. The pause
# is longer than the autosave debounce, so the flag is guaranteed to rise and
# fall at least twice inside the window being measured. One group could be
# coalesced into a single update and a single write, and a window holding one
# rise has nothing to alternate BETWEEN: it would hold still under the old
# behaviour too, and report success for a title that flickers.
for group in 1 2; do
    printf '{"type":"__jotKeys","keys":["End","Enter","s","t","e","a","d","y"]}' > "$SCRATCH_DIR/.debug-message.json"
    kill -URG $PID; sleep 2.5
    BURST_WORDS="$BURST_WORDS steady"
done
rm -f "$SCRATCH_DIR/.debug-message.json"
BURST="$(grep "^jot-trace titletext " "$LOG" | tail -n +$((BURST_START + 1)) | sed 's/^jot-trace titletext //')"
BURST_LINES="$(printf '%s\n' "$BURST" | grep -c . || true)"
BURST_DISTINCT="$(printf '%s\n' "$BURST" | grep . | sort -u)"
BURST_COUNT="$(printf '%s\n' "$BURST_DISTINCT" | grep -c . || true)"
# Three arms, because "one distinct value" is what a broken title and a
# title nobody asked about report alike.
#
# 1. the title was ASKED more than once, or there is nothing to be stable
#    across.
if [ "${BURST_LINES:-0}" -lt 2 ]; then
    echo "title stability      FAILED: only $BURST_LINES title repaints during a typing burst; the trace is not reaching this" >&2
    exit 1
fi
# 2. a WRITE really landed inside the window. Without one the flag only ever
#    rose, and a title that never had to come back down holds still under the
#    old behaviour too. The file gaining the typed text is the evidence, and
#    it is the same evidence the persistence check trusts.
if [ "$(grep -c "^steady$" "$SCRATCH_DIR/Scratch pad.md" 2>/dev/null || echo 0)" -lt 2 ]; then
    echo "title stability      FAILED: the burst never reached the file, so no write happened to hold still across" >&2
    cat "$SCRATCH_DIR/Scratch pad.md" >&2; exit 1
fi
# 3. and it said one thing the whole time.
if [ "$BURST_COUNT" = "1" ]; then
    echo "title stability      ok: $BURST_LINES repaints across a typing burst, all saying \"$BURST_DISTINCT\""
else
    echo "title stability      FAILED: the title changed $BURST_COUNT ways while typing with autosave on" >&2
    printf '%s\n' "$BURST_DISTINCT" | sed 's/^/  /' >&2
    exit 1
fi

# The titlebar band can be grabbed.
#
# The drag itself is not checkable from here: moving a window needs a real
# pointer, and synthesizing one needs an Accessibility grant these checks do not
# have. Everything the drag DEPENDS on is checkable, and it is all geometry, so
# this asserts the strip is where nothing else is rather than that it exists.
# Every way of getting this wrong has the same shape: a strip of zero width, a
# strip hidden behind the window buttons, or a strip lying over the page's own
# controls, which would take the clicks meant for Find and the gear.
show_panel
DRAG="$(grep "^jot-trace titlebardrag " "$LOG" | tail -1 || true)"
DRAG_X="$(echo "$DRAG" | sed -n 's/.*x=\([0-9.-]*\).*/\1/p')"
DRAG_W="$(echo "$DRAG" | sed -n 's/.* w=\([0-9.-]*\).*/\1/p')"
DRAG_H="$(echo "$DRAG" | sed -n 's/.*h=\([0-9.-]*\).*/\1/p')"
DRAG_HIDDEN="$(echo "$DRAG" | sed -n 's/.*hidden=\([a-z]*\).*/\1/p')"
DRAG_TITLE_MAXX="$(echo "$DRAG" | sed -n 's/.*titleMaxX=\([0-9.-]*\).*/\1/p')"
DRAG_CONTROLS="$(echo "$DRAG" | sed -n 's/.*controlsW=\([0-9.-]*\).*/\1/p')"
DRAG_WINDOW="$(echo "$DRAG" | sed -n 's/.*windowW=\([0-9.-]*\).*/\1/p')"
if [ -z "$DRAG" ]; then
    echo "titlebar drag        FAILED: the app reported no drag-strip trace at all" >&2; exit 1
fi
# The page's controls have to have been MEASURED, or the strip's trailing edge
# is bounded by nothing and the check below passes on a strip that covers them.
# A zero here is the pre-report state, not a page without controls.
if [ "$DRAG_HIDDEN" = "no" ] \
   && awk "BEGIN{exit !($DRAG_W > 0)}" \
   && awk "BEGIN{exit !($DRAG_H > 0)}" \
   && awk "BEGIN{exit !($DRAG_CONTROLS > 0)}" \
   && awk "BEGIN{exit !($DRAG_X >= $DRAG_TITLE_MAXX - 0.5)}" \
   && awk "BEGIN{exit !($DRAG_X + $DRAG_W <= $DRAG_WINDOW - $DRAG_CONTROLS + 0.5)}"; then
    echo "titlebar drag        ok: ${DRAG_W}x${DRAG_H} at x=$DRAG_X, clear of the title and of the page's controls"
else
    echo "titlebar drag        FAILED: expected a visible strip between the title and the page's controls" >&2
    echo "$DRAG" >&2; exit 1
fi

# The title's ceiling follows the WINDOW, which is the axis every check above
# is blind to: each of them measures one window at one width, and the ceiling
# on the name was a constant, so it was wrong in both directions at once
# without moving a single number any of them read.
#
# Too small in a wide window: the name was cut at a fixed width with the rest
# of the band empty, and a cut title reads as a shorter NAME. Too large in a
# narrow one: the title ran past where the page's controls start and sat under
# the T, the magnifier and the gear, and the strip that makes the band
# draggable vanished with it.
#
# The sweep is DERIVED, not listed. The widths come from what this run
# measures (where AppKit put the accessory, what the glyphs need, what the
# page's controls take), so they follow the name and the toolbar rather than
# being tuned to whatever the product's default note is called this month. A
# list of widths would have to be re-tuned by hand every time either moves,
# and a width that has quietly stopped reproducing looks exactly like a width
# that passes.
show_panel
# The page's controls were measured BEFORE anything was drawn against them.
#
# The ceiling is computed from that width, and a width of zero is
# indistinguishable to the arithmetic from a page carrying no controls at all,
# so a title sized while the answer was still outstanding takes the whole band
# and pulls back a round trip later. The panel is prewarmed with the page
# mounted and hidden, which is what makes the answer available before the first
# summon; asking only when the panel is shown puts a zero in the first frame of
# every launch.
#
# The FIRST trace of the run, deliberately, not the last. Every trace after the
# page has answered carries a healthy width whether or not the early ones did,
# so the last one cannot see this and the tail of this file is full of them.
DRAG_FIRST="$(grep "^jot-trace titlebardrag " "$LOG" | head -1 || true)"
DRAG_FIRST_CONTROLS="$(echo "$DRAG_FIRST" | sed -n 's/.*controlsW=\([0-9.-]*\).*/\1/p')"
if [ -n "$DRAG_FIRST_CONTROLS" ] && awk "BEGIN{exit !($DRAG_FIRST_CONTROLS > 0)}"; then
    echo "titlebar width first ok: the page's controls were measured before the band was first laid out ($DRAG_FIRST_CONTROLS)"
else
    echo "titlebar width first FAILED: the band was laid out before the page reported its controls" >&2
    echo "  first trace: $DRAG_FIRST" >&2; exit 1
fi

# A name long enough to press the ceiling. It keeps the space that
# `Scratch pad.md` is named for: a wrap point is what the ink check exists to
# see, and a long name without one would pass that bug while testing this one.
CEIL_NAME="A rather long note name for measuring the title ceiling.md"
CEIL_WIDE_BEFORE="$(grep "^jot-trace titlebardrag " "$LOG" | tail -1 | sed -n 's/.*windowW=\([0-9.-]*\).*/\1/p')"
printf '{"type":"__jotRename","name":"%s"}' "$CEIL_NAME" > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
rm -f "$SCRATCH_DIR/.debug-message.json"

# One resize, one pair of traces. Everything is read back from the app rather
# than assumed: the width asked for is not the width granted (the panel has a
# minimum, and the system constrains a frame to the screen), so every
# assertion below uses the `windowW` the app reports.
ceil_at() { # ceil_at <width>; sets CEIL_* from the traces it provokes
    printf '{"type":"__jotResize","width":%s}' "$1" > "$SCRATCH_DIR/.debug-message.json"
    kill -URG $PID; sleep 1.2
    rm -f "$SCRATCH_DIR/.debug-message.json"
    local tb drag
    tb="$(grep "^jot-trace titlebar " "$LOG" | tail -1 || true)"
    drag="$(grep "^jot-trace titlebardrag " "$LOG" | tail -1 || true)"
    CEIL_VIEW_W="$(echo "$tb" | sed -n 's/.*titlebar x=[0-9.-]* y=[0-9.-]* w=\([0-9.-]*\).*/\1/p')"
    CEIL_X="$(echo "$tb" | sed -n 's/.*titlebar x=\([0-9.-]*\).*/\1/p')"
    CEIL_NEED="$(echo "$tb" | sed -n 's/.*needW=\([0-9.-]*\).*/\1/p')"
    CEIL_GOT="$(echo "$tb" | sed -n 's/.*gotW=\([0-9.-]*\).*/\1/p')"
    CEIL_INK="$(echo "$tb" | sed -n 's/.*inkW=\([0-9.-]*\).*/\1/p')"
    CEIL_MAXX="$(echo "$drag" | sed -n 's/.*titleMaxX=\([0-9.-]*\).*/\1/p')"
    CEIL_CONTROLS="$(echo "$drag" | sed -n 's/.*controlsW=\([0-9.-]*\).*/\1/p')"
    CEIL_WINDOW="$(echo "$drag" | sed -n 's/.*windowW=\([0-9.-]*\).*/\1/p')"
    CEIL_DRAG_W="$(echo "$drag" | sed -n 's/.* w=\([0-9.-]*\).*/\1/p')"
    CEIL_DRAG_HIDDEN="$(echo "$drag" | sed -n 's/.*hidden=\([a-z]*\).*/\1/p')"
    # The characters actually drawn. `text=` is last on the line, so it can
    # carry spaces and an ellipsis without any of it needing escaping.
    CEIL_CELL="$(echo "$tb" | sed -n 's/.*cellW=\([0-9.-]*\).*/\1/p')"
    CEIL_TEXT="$(echo "$tb" | sed -n 's/.*text=//p')"
    if [ -z "$CEIL_NEED" ] || [ -z "$CEIL_WINDOW" ]; then
        echo "title ceiling        FAILED: no titlebar/drag trace after resizing to $1" >&2
        echo "  $tb" >&2; echo "  $drag" >&2; exit 1
    fi
}

# The boundary, computed from this run's own numbers: the window width at which
# the whole name exactly fits. `CEIL_CHROME` is everything in the accessory
# that is not the text, taken as the view's width minus its text's rather than
# written down here, so the leading gap and the chevron's reserved room stay
# the app's business. The 8 mirrors `TitlebarBand.draggableSpan`'s
# `minimumWidth`, the narrowest strip the app will show at all; the tie between
# that floor and this ceiling is asserted in Swift, by `TitlebarBandTests`,
# against `draggableSpan` itself.
ceil_at 2400
CEIL_CHROME="$(awk "BEGIN{printf \"%.1f\", $CEIL_VIEW_W - $CEIL_GOT}")"
# What the app does with all the room in the world: the box it gives the label
# and the ink that comes out. Every arm below compares against THESE rather
# than against the string's own width, because the string's width is not what
# the cell needs to draw it and the gap between the two is one glyph.
CEIL_FULLBOX="$CEIL_GOT"
CEIL_FULLINK="$CEIL_INK"
CEIL_BOUNDARY="$(awk "BEGIN{s = $CEIL_X + $CEIL_CHROME + $CEIL_FULLBOX + $CEIL_CONTROLS + 8; printf \"%d\", (s == int(s)) ? s : int(s) + 1}")"
if [ -z "$CEIL_CONTROLS" ] || awk "BEGIN{exit !($CEIL_CONTROLS <= 0)}"; then
    echo "title ceiling        FAILED: the page never reported its controls' width, so nothing bounds the title" >&2
    exit 1
fi

# Four widths spanning the boundary: roomy, exactly at it, one point inside it,
# and far below. The last two must truncate and the first two must not, which
# is the discrimination: a ceiling that ignored the window would sit on one
# side of that line at every width, and a ceiling that always truncated would
# sit on the other.
CEIL_FULL=0
CEIL_CUT=0
CEIL_SEEN=0
# The widths the app GRANTED, which is not the list asked for: the panel has a
# minimum width and the system constrains a frame to the screen, so a request
# below either comes back clamped. Recorded so a sweep whose widths collapsed
# onto each other says so, instead of failing the tally below with no clue why.
CEIL_WIDTHS=""
for CEIL_W in "$(awk "BEGIN{print $CEIL_BOUNDARY + 400}")" \
              "$CEIL_BOUNDARY" \
              "$(awk "BEGIN{print $CEIL_BOUNDARY - 1}")" \
              "$(awk "BEGIN{print $CEIL_BOUNDARY - 150}")"; do
    ceil_at "$CEIL_W"
    CEIL_SEEN=$((CEIL_SEEN + 1))
    CEIL_WIDTHS="$CEIL_WIDTHS $CEIL_WINDOW(got=$CEIL_GOT)"
    # 1. The title never reaches the page's controls, and leaves a strip of
    #    band between the two. Three sources, on purpose: `titleMaxX` is a view
    #    frame the shell code sets, `controlsW` is measured in the page by
    #    JavaScript, and `windowW` is the window's. A comparison drawn from one
    #    of them would agree with itself whatever was wrong.
    if ! awk "BEGIN{exit !($CEIL_MAXX + 8 <= $CEIL_WINDOW - $CEIL_CONTROLS + 0.5)}"; then
        echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt the title reaches into the page's controls" >&2
        echo "  titleMaxX=$CEIL_MAXX windowW=$CEIL_WINDOW controlsW=$CEIL_CONTROLS" >&2
        CEIL_CONTROLS_AT="$(awk "BEGIN{printf \"%.1f\", $CEIL_WINDOW - $CEIL_CONTROLS}")"
        CEIL_OVERLAP="$(awk "BEGIN{printf \"%.1f\", $CEIL_MAXX - $CEIL_CONTROLS_AT}")"
        echo "  the page's controls start at $CEIL_CONTROLS_AT, so the title overlaps them by ${CEIL_OVERLAP}pt" >&2
        echo "  needs=$CEIL_NEED got=$CEIL_GOT ink=$CEIL_INK dragW=$CEIL_DRAG_W hidden=$CEIL_DRAG_HIDDEN" >&2
        exit 1
    fi
    # 2. ...so the strip is still there to grab. A title that ate the band
    #    leaves this hidden, which is the same defect seen from the other end.
    if [ "$CEIL_DRAG_HIDDEN" != "no" ] || ! awk "BEGIN{exit !($CEIL_DRAG_W >= 8)}"; then
        echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt no draggable band is left (hidden=$CEIL_DRAG_HIDDEN w=$CEIL_DRAG_W)" >&2
        exit 1
    fi
    # 3. What the name did with the room it got. Either it all fits, and then
    #    every glyph must be drawn, or it does not, and then the label must
    #    have filled the box it was given rather than stopped short inside it.
    #    Ink short of its own box is the wrap failure this file was written
    #    around: the name laid out on a second line nobody can see, so it ends
    #    without an ellipsis and reads as a shorter name.
    #
    #    What it does NOT cover, stated because the shape of the number
    #    invites the opposite reading: `inkW` renders the LABEL into its own
    #    bitmap, so a container clipping the label from outside moves nothing
    #    here. That case is held off by the `room` clamp in `TitleBarView`'s
    #    `layout()`, which is code rather than a measurement, and the only
    #    number in this trace that could see it (`visTextW`) reports the
    #    accessory's width rather than the label's.
    if awk "BEGIN{exit !($CEIL_GOT >= $CEIL_FULLBOX - 0.1)}"; then
        CEIL_FULL=$((CEIL_FULL + 1))
        # Against the ink the app put down with unlimited room, not against
        # the string's width. A box a point or two short of what the CELL
        # needs clips the last glyph and still measures wider than the string,
        # so a comparison with the string passes on a clipped name; the same
        # name drawn twice, once unconstrained, is what discriminates.
        if ! awk "BEGIN{exit !($CEIL_INK >= $CEIL_FULLINK - 0.6)}"; then
            echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt the name fits but is not drawn in full" >&2
            echo "  ink=$CEIL_INK unconstrained=$CEIL_FULLINK got=$CEIL_GOT cellNeeds=$CEIL_CELL" >&2; exit 1
        fi
        # ...and the box is at least what the cell asked for, which is the
        # same claim from the other side and fails a point earlier.
        if ! awk "BEGIN{exit !($CEIL_GOT >= $CEIL_CELL - 0.1)}"; then
            echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt the label is narrower than the cell needs to draw" >&2
            echo "  got=$CEIL_GOT cellNeeds=$CEIL_CELL needs=$CEIL_NEED ink=$CEIL_INK" >&2; exit 1
        fi
        # The other half of the ellipsis arm below. Without it a title that
        # truncated at every width would satisfy that one and be caught by
        # nothing here: it is the PAIR that says the ellipsis tracks the room.
        # `*…*`, not `*…`. The ellipsis ends the NAME run, and an edited title
        # puts " — Edited" after it, so anchoring at the end of the line makes
        # both arms mean the opposite of what they say the moment autosave is
        # on. Nothing about this sweep guarantees it is off.
        case "$CEIL_TEXT" in
            *…*) echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt the whole name fits and it was truncated anyway" >&2
                echo "  text=\"$CEIL_TEXT\" needs=$CEIL_NEED got=$CEIL_GOT" >&2; exit 1;;
        esac
    else
        CEIL_CUT=$((CEIL_CUT + 1))
        # Against the STRING it decided to draw, not against the box. The box
        # is what the CELL needs, which is the string plus the cell's own
        # insets, so ink never reaches it and a comparison with it fails by
        # exactly that inset on a title that is drawn perfectly. What is being
        # claimed here is that every glyph the app chose to draw was drawn,
        # and `needW` is the width of exactly those glyphs.
        if ! awk "BEGIN{exit !($CEIL_INK >= $CEIL_NEED - 1)}"; then
            echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt the name was cut short of the string it drew" >&2
            echo "  needs=$CEIL_NEED got=$CEIL_GOT ink=$CEIL_INK" >&2; exit 1
        fi
        # 4. A name that did not fit says so, with an ellipsis.
        #
        #    Every other number here is a WIDTH, and a name sliced at a pixel
        #    is exactly as wide as one truncated at the same ceiling: both
        #    fill the box, so the ink arm above passes on either and cannot
        #    tell them apart. It passed on a build that clipped, through four
        #    releases.
        #
        #    `text` is the MODEL, the string the app decided to draw, so this
        #    arm on its own would say nothing about the drawing. It is the
        #    PAIR that discriminates: arm 3 ties the ink to the box, and this
        #    ties the box's contents to a name that admits it was shortened.
        #    Against the pre-fix build the two part company visibly, the model
        #    reporting a whole name the label had no room for.
        case "$CEIL_TEXT" in
            *…*) ;;
            *)  echo "title ceiling        FAILED: at ${CEIL_WINDOW}pt the name did not fit and was cut with no ellipsis" >&2
                echo "  text=\"$CEIL_TEXT\" needs=$CEIL_NEED got=$CEIL_GOT ink=$CEIL_INK" >&2; exit 1;;
        esac
    fi
done

# The sweep has to have reached BOTH regimes, or it measured one and reported
# on two. A ceiling stuck at a constant passes every assertion above at the
# widths on one side of it; what it cannot do is fit the whole name at 400pt
# more than it needs AND truncate 150pt below the line. Asserted here rather
# than assumed, because a name that had grown long enough to truncate
# everywhere, or short enough to fit everywhere, would leave every check above
# green having tested nothing.
if [ "$CEIL_SEEN" = 4 ] && [ "$CEIL_FULL" -ge 2 ] && [ "$CEIL_CUT" -ge 2 ]; then
    echo "title ceiling        ok: the name follows the window ($CEIL_FULL widths drew it whole, $CEIL_CUT truncated), clear of the page's controls at every width"
else
    echo "title ceiling        FAILED: the sweep did not reach both regimes, so it discriminates nothing" >&2
    echo "  widths measured=$CEIL_SEEN drawn whole=$CEIL_FULL truncated=$CEIL_CUT boundary=${CEIL_BOUNDARY}pt" >&2
    echo "  granted widths:$CEIL_WIDTHS" >&2
    echo "  name=\"$CEIL_NAME\" needs=$CEIL_NEED controls=$CEIL_CONTROLS" >&2
    exit 1
fi

# Put the window and the file back, so everything below reads the panel and the
# scratchpad it expects.
ceil_at "${CEIL_WIDE_BEFORE:-640}"
printf '{"type":"__jotRename","name":"Scratch pad.md"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
rm -f "$SCRATCH_DIR/.debug-message.json"
if [ ! -f "$SCRATCH_DIR/Scratch pad.md" ]; then
    echo "title ceiling        FAILED: could not rename back, so the checks below would read the wrong file" >&2
    ls -l "$SCRATCH_DIR" >&2; exit 1
fi

# Open Recent, which by now has something to remember.
#
# Read off the stored list rather than off the menu, because the menu is built
# from it and a menu row is not evidence that anything was recorded: the list
# was empty for every note this app ever opened, and the menu said "No Recent
# Files" perfectly correctly the whole time. The bug was one call site, in the
# one gesture that goes through a file chooser, so a document opened with Cmd+O
# joined the list and a note made with Cmd+N did not.
#
# Two files, and the two are the two halves of the claim. The long ceiling name
# is a file the panel was rebound TO, so it is there only if an ARRIVING file
# is recorded, which is the half that was missing. `Scratch pad.md` is the file
# this run launched on, which no rebind ever arrives at, so it is there only if
# the file being LEFT is recorded too, which is how a launch binding ever
# reaches the list without a preference being written at launch (see the
# `boundURL` comment for why that matters). Neither arm can pass on the
# other's account, and before the fix neither passed at all.
#
# The renames above are what makes this reachable from a script: a rebind needs
# a second file, and `__jotRename` is the one way a shell has to give the app
# one without a file chooser or an Accessibility grant.
RECENTS="$(defaults read "$BIRTA_JOT_DEFAULTS_SUITE" recentDocuments 2>/dev/null || true)"
REC_LEFT=0
REC_REBIND=0
case "$RECENTS" in *"$SCRATCH_DIR/Scratch pad.md"*) REC_LEFT=1 ;; esac
case "$RECENTS" in *"$CEIL_NAME"*) REC_REBIND=1 ;; esac
if [ "$REC_LEFT" = 1 ] && [ "$REC_REBIND" = 1 ]; then
    echo "open recent          ok: the file this run launched on and a file it rebound to are both on the list"
else
    echo "open recent          FAILED: a file the panel has had open is missing from the recents list" >&2
    echo "  file left recorded=$REC_LEFT  file arrived-at recorded=$REC_REBIND" >&2
    echo "  stored list: $RECENTS" >&2
    exit 1
fi

# The document popover, and the rename it exists for.
#
# A click on the title cannot be synthesized from a script: the title is native
# chrome and the debug key path reaches the web view, so `__jotTitleClick` and
# `__jotRename` are the only way this form is ever built against a real window
# and a real file. Everything decidable without one is already unit tested
# (`DocumentName`, `FinderTags`, `ActiveBinding`); what is left is exactly what
# needs a panel, which is the line this script is drawn along.
show_panel
printf '{"type":"__jotTitleClick"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.5
POPOVER="$(grep "^jot-trace titlepopover " "$LOG" | tail -1 | sed 's/^jot-trace titlepopover //')"
rm -f "$SCRATCH_DIR/.debug-message.json"
P_SHOWN="$(echo "$POPOVER" | sed -n 's/.*shown=\([a-z]*\).*/\1/p')"
P_NAME="$(echo "$POPOVER" | sed -n 's/.*name=\(.*\) where=.*/\1/p')"
P_FOLDERS="$(echo "$POPOVER" | sed -n 's/.*folders=\([0-9]*\).*/\1/p')"
P_ROWS="$(echo "$POPOVER" | sed -n 's/.*rows=\([0-9]*\).*/\1/p')"
# Every row, not just "it opened". A popover that appeared with an empty Name
# and a Where menu of one entry is a popover that drew nothing useful, and a
# presence check cannot tell it from a working one. `folders` counts the real
# directories; `rows` counts them plus the separator and Other…, so rows must
# exceed folders or the menu lost its escape hatch.
if [ "$P_SHOWN" = "yes" ] && [ "$P_NAME" = "Scratch pad.md" ] \
   && [ "${P_FOLDERS:-0}" -ge 2 ] && [ "${P_ROWS:-0}" -gt "${P_FOLDERS:-0}" ]; then
    echo "title popover        ok: $POPOVER"
else
    echo "title popover        FAILED: expected an open popover naming the file, with a Where menu" >&2
    echo "  $POPOVER" >&2; exit 1
fi

# The rename, end to end: the bytes move, the setting the panel was bound
# THROUGH follows them, and the title says the new name. The last one is what
# proves the editor is still on the file rather than pointing at where it used
# to be.
RELOCATES_BEFORE=$(grep -c "^jot-trace relocate " "$LOG" || true)
printf '{"type":"__jotRename","name":"Renamed by measure.md"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
rm -f "$SCRATCH_DIR/.debug-message.json"
RENAMED="$SCRATCH_DIR/Renamed by measure.md"
TITLE_AFTER="$(grep "^jot-trace titletext " "$LOG" | tail -1 | sed 's/^jot-trace titletext //')"
if [ -f "$RENAMED" ] && [ ! -f "$SCRATCH_DIR/Scratch pad.md" ] \
   && [ "$TITLE_AFTER" = "Renamed by measure.md" ]; then
    echo "title rename         ok: the file moved and the title followed it"
else
    echo "title rename         FAILED: expected the file renamed and the title to follow" >&2
    echo "  renamed exists: $([ -f "$RENAMED" ] && echo yes || echo no)" >&2
    echo "  old still there: $([ -f "$SCRATCH_DIR/Scratch pad.md" ] && echo yes || echo no)" >&2
    echo "  title now: \"$TITLE_AFTER\"" >&2
    ls -l "$SCRATCH_DIR" >&2; exit 1
fi
# The buffer went WITH it. A rename that moved an empty file and left the note
# behind would satisfy every assertion above.
if grep -q "^steady$" "$RENAMED"; then
    echo "title rename         ok: and the note's text went with it"
else
    echo "title rename         FAILED: the renamed file does not hold the typed text" >&2
    cat "$RENAMED" >&2; exit 1
fi
# ONE move, not two. Committing a name runs twice for one rename (Return
# commits it, and the popover closing ends editing and commits it again), and
# the second one used to ask for the same move while the first was still in
# flight, find the file already at the destination, and report a name
# collision with itself. The rename still succeeded, so nothing above could
# see it; the count is what does.
RELOCATES="$(grep "^jot-trace relocate " "$LOG" | tail -n +$((RELOCATES_BEFORE + 1)) | sed 's/^jot-trace relocate //')"
RELOCATE_COUNT="$(printf '%s\n' "$RELOCATES" | grep -c . || true)"
if [ "$RELOCATE_COUNT" = "1" ] && [ "$RELOCATES" = "ok renamed Renamed by measure.md" ]; then
    echo "title rename         ok: one move, reported once, with no collision against itself"
else
    echo "title rename         FAILED: expected exactly one successful relocate, got $RELOCATE_COUNT" >&2
    printf '%s\n' "$RELOCATES" | sed 's/^/  /' >&2; exit 1
fi
# Everything after this reads the scratchpad by its original name, so put it
# back the same way it was moved.
printf '{"type":"__jotRename","name":"Scratch pad.md"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
rm -f "$SCRATCH_DIR/.debug-message.json"
if [ ! -f "$SCRATCH_DIR/Scratch pad.md" ]; then
    echo "title rename         FAILED: could not rename back, so the checks below would read the wrong file" >&2
    ls -l "$SCRATCH_DIR" >&2; exit 1
fi

# Copy a reference for an agent. Everything about this is the shell's except
# the click: the page reports where the caret is, and the shell decides what
# goes on the clipboard, against a real file with a real path.
#
# The clipboard is borrowed and put back, the same way the paste check does it.
CLIP_BACKUP2="$(mktemp -t jot-measure-clip2)"
pbpaste > "$CLIP_BACKUP2" 2>/dev/null || true
show_panel
printf '{"type":"__jotCopyAgentReference"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 2.5
rm -f "$SCRATCH_DIR/.debug-message.json"
COPIED="$(pbpaste 2>/dev/null || true)"
pbcopy < "$CLIP_BACKUP2" 2>/dev/null || true
rm -f "$CLIP_BACKUP2"
# An ABSOLUTE path, which is the whole difference from the extension: Jot's
# file is under Application Support and a workspace-relative path would name
# nothing anywhere. Checked against the throwaway scratchpad this run created,
# so it is the real bound file rather than a shape that merely looks right.
case "$COPIED" in
    "$SCRATCH_DIR/Scratch pad.md#L"*) REF_OK=1 ;;
    *) REF_OK=0 ;;
esac
if [ "$REF_OK" = 1 ]; then
    echo "agent reference      ok: $(printf '%s' "$COPIED" | head -1)"
else
    echo "agent reference      FAILED: expected an absolute reference to the bound file on the clipboard" >&2
    echo "  clipboard: \"$(printf '%s' "$COPIED" | head -3)\"" >&2
    grep "^jot-trace agentref " "$LOG" | sed 's/^/  /' >&2
    exit 1
fi

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
if grep -q "$STAMP" "$SCRATCH_DIR/Scratch pad.md"; then
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
# The onboarding defaults reach a FIRST launch and nothing else.
#
# Two launches with their own defaults domains, because the claim is a
# difference between two states of the world and one run cannot show it. The
# rule is `Prefs.isFirstLaunch`, and what makes it fragile is ORDERING rather
# than logic: it asks whether any key is stored, so anything that writes a
# preference before the screen appears turns a first launch into an existing
# one and the defaults silently stop applying. A unit test cannot see that.
#
# `networkEnabled` is the one worth the two launches. It is the only setting
# here that reaches the network, `docs/NETWORK_POSTURE.md` records it as
# shipping off, and the failure is silent in the direction that matters: an
# install that predates this screen having outbound requests switched on
# without anybody clicking anything.
# Sets ONBOARD_KEYS to what the run stored, and ONBOARD_ALIVE to whether the
# app actually got as far as mounting its editor.
#
# The liveness signal is the app's own `ready` mark rather than the presence of
# any stored key, and that is not a detail: the checks below assert an ABSENCE,
# and an absence over a run that never started is not evidence. It used to lean
# on the run writing SOMETHING, which stopped being true the moment the
# first-run screen stopped writing preferences, and the arm said so rather than
# passing, which is the whole point of having it.
onboarding_run() { # onboarding_run <suite>
    local dir log pid
    dir="$(mktemp -d -t jot-onboard)"
    log="$(mktemp -t jot-onboard)"
    BIRTA_JOT_MEASURE=1 BIRTA_JOT_SCRATCHPAD="$dir/Onboard.md" \
        BIRTA_JOT_DEFAULTS_SUITE="$1" BIRTA_JOT_OPEN_WELCOME=1 "$APP" 2>"$log" &
    pid=$!
    sleep 3; kill -USR1 $pid; sleep 2
    ONBOARD_KEYS="$(defaults read "$1" 2>/dev/null || true)"
    ONBOARD_LOGIN="$(grep "^jot-trace onboarding " "$log" | tail -1 || true)"
    ONBOARD_ALIVE=0
    grep -q "^jot-measure ready " "$log" && ONBOARD_ALIVE=1
    kill $pid 2>/dev/null; wait $pid 2>/dev/null || true
    rm -rf "$dir" "$log"
}


# The settings window is as tall as its pane, and FOLLOWS it.
#
# A pane's height is not fixed once built: the Location row comes and goes with
# the answer above it. A window that keeps its first height puts a scroller
# over two rows of settings, which reads as a pane too big rather than a window
# that did not follow, so the trace says which happened.
#
# The arm therefore MOVES that switch (`BIRTA_JOT_TOGGLE_ICLOUD`) and requires
# two traces at different pane heights. Reading one trace would read the
# initial sizing, which happens whether or not the following works: delete the
# whole fix and a one-trace check still passes.
#
# Compared as content against pane, never frame against pane. A frame carries
# the titlebar and the preference toolbar, so a frame taller than the pane says
# nothing about whether the pane fits inside it.
SETTINGS_SUITE="com.birtalabs.jot.measure.settings.$$"
SETTINGS_DIR="$(mktemp -d -t jot-settings)"
SETTINGS_LOG="$(mktemp -t jot-settings)"
BIRTA_JOT_MEASURE=1 BIRTA_JOT_SCRATCHPAD="$SETTINGS_DIR/S.md" \
    BIRTA_JOT_DEFAULTS_SUITE="$SETTINGS_SUITE" BIRTA_JOT_OPEN_SETTINGS=general \
    BIRTA_JOT_TOGGLE_ICLOUD=1 "$APP" 2>"$SETTINGS_LOG" &
SETTINGS_PID=$!
sleep 5
SETTINGS_FITS="$(grep "^jot-trace settingsfit " "$SETTINGS_LOG" || true)"
SETTINGS_TOGGLE="$(grep "^jot-trace icloudtoggle " "$SETTINGS_LOG" | tail -1 || true)"
kill $SETTINGS_PID 2>/dev/null; wait $SETTINGS_PID 2>/dev/null || true
rm -rf "$SETTINGS_DIR" "$SETTINGS_LOG"
EXTRA_SUITES="$EXTRA_SUITES $SETTINGS_SUITE"

# The control that changes a pane's height is disabled when iCloud Drive is off
# in System Settings. That is a fact about this machine, so it is reported and
# skipped rather than read as a window that did not follow its pane.
if [ -z "$SETTINGS_TOGGLE" ]; then
    echo "settings fit         FAILED: the settings window never reached the toggle, so nothing was driven" >&2
    printf '%s\n' "$SETTINGS_FITS" >&2; exit 1
fi
case "$SETTINGS_TOGGLE" in
    *available=0)
        echo "settings fit         skipped: iCloud Drive is off on this Mac, so the row that changes the pane's height cannot be moved"
        SETTINGS_FITS="" ;;
esac
if [ -n "$SETTINGS_FITS" ]; then

SETTINGS_COUNT="$(printf '%s\n' "$SETTINGS_FITS" | grep -c settingsfit || true)"
if [ "${SETTINGS_COUNT:-0}" -lt 2 ]; then
    echo "settings fit         FAILED: the window sized itself $SETTINGS_COUNT time(s); the pane changed height and it did not follow" >&2
    printf '%s\n' "$SETTINGS_FITS" >&2; exit 1
fi

# Every fit gave the pane at least what it asked for, or the cap if it asked
# for more than a window may take.
SETTINGS_PANES=""
while IFS= read -r line; do
    [ -n "$line" ] || continue
    FIT_CONTENT="$(printf '%s' "$line" | sed -n 's/.* content=\([0-9]*\).*/\1/p')"
    FIT_PANE="$(printf '%s' "$line" | sed -n 's/.* pane=\([0-9]*\).*/\1/p')"
    FIT_CAP="$(printf '%s' "$line" | sed -n 's/.* cap=\([0-9]*\).*/\1/p')"
    if [ -z "$FIT_CONTENT" ] || [ -z "$FIT_PANE" ] || [ -z "$FIT_CAP" ]; then
        echo "settings fit         FAILED: a trace line is missing a figure" >&2
        echo "  $line" >&2; exit 1
    fi
    WANT="$FIT_PANE"
    if [ "$WANT" -gt "$FIT_CAP" ]; then WANT="$FIT_CAP"; fi
    if [ "$FIT_CONTENT" -lt "$WANT" ]; then
        echo "settings fit         FAILED: the pane is given ${FIT_CONTENT}pt and needs ${WANT}pt, so it scrolls" >&2
        echo "  $line" >&2; exit 1
    fi
    SETTINGS_PANES="$SETTINGS_PANES $FIT_PANE"
done <<EOF
$SETTINGS_FITS
EOF

# And the two fits were for DIFFERENT panes. Equal heights would mean the
# window resized twice for the same content, which is not what the switch does
# and would let the count above pass on a repeat of the first sizing.
SETTINGS_DISTINCT="$(printf '%s\n' $SETTINGS_PANES | sort -u | wc -l | tr -d ' ')"
if [ "$SETTINGS_DISTINCT" -lt 2 ]; then
    echo "settings fit         FAILED: every fit was for the same pane height, so nothing followed a change" >&2
    printf '%s\n' "$SETTINGS_FITS" >&2; exit 1
fi
echo "settings fit         ok: the window followed its pane across $SETTINGS_COUNT sizings (pane heights:$SETTINGS_PANES)"
fi

ONBOARD_FRESH_SUITE="com.birtalabs.jot.measure.fresh.$$"
ONBOARD_USED_SUITE="com.birtalabs.jot.measure.used.$$"
EXTRA_SUITES="$EXTRA_SUITES $ONBOARD_FRESH_SUITE $ONBOARD_USED_SUITE"
onboarding_run "$ONBOARD_FRESH_SUITE"
FRESH_KEYS="$ONBOARD_KEYS"; FRESH_ALIVE="$ONBOARD_ALIVE"; FRESH_LOGIN="$ONBOARD_LOGIN"
# An install that has been used, seeded with `hasSeenWelcome` specifically.
# Any key would do for "not fresh", and this is the one worth choosing: it is
# the key a reset leaves behind and the key most likely to be special-cased out
# of the emptiness test, so seeding anything else leaves that mistake invisible.
# Seeded false, because the setter stores it either way and false is what
# Settings writes when it re-shows the screen.
defaults write "$ONBOARD_USED_SUITE" hasSeenWelcome -bool false
onboarding_run "$ONBOARD_USED_SUITE"
USED_KEYS="$ONBOARD_KEYS"; USED_ALIVE="$ONBOARD_ALIVE"; USED_LOGIN="$ONBOARD_LOGIN"

# Neither a first launch nor an existing install may end up with the network
# switched on. That is the posture claim, and it is worth two launches because
# the failure is silent in the direction that matters: an app making outbound
# requests that nobody asked it to make.
#
# Asserted as an ABSENCE, which needs the launches to have done something or
# it passes on a pair of empty domains. `FRESH_KEYS` carrying the app's own
# writes is what says the app ran at all.
if echo "$FRESH_KEYS" | grep -q "networkEnabled = 1"; then
    echo "onboarding           FAILED: a first launch switched the network on" >&2
    echo "$FRESH_KEYS" >&2; exit 1
fi
if echo "$USED_KEYS" | grep -q "networkEnabled = 1"; then
    echo "onboarding           FAILED: an install that already had settings had the network switched on for it" >&2
    echo "$USED_KEYS" >&2; exit 1
fi
if echo "$USED_KEYS" | grep -q "showInDock"; then
    echo "onboarding           FAILED: an install that already had settings was given a Dock icon" >&2
    echo "$USED_KEYS" >&2; exit 1
fi
# Both launches have to have HAPPENED. The two checks above assert an absence,
# which a run that never started satisfies perfectly.
if [ "$FRESH_ALIVE" != 1 ] || [ "$USED_ALIVE" != 1 ]; then
    echo "onboarding           FAILED: a launch never reached ready, so the checks proved nothing" >&2
    echo "  (fresh alive=$FRESH_ALIVE, used alive=$USED_ALIVE)" >&2; exit 1
fi
# And no run registered a login item. That is the ONE thing the first-run
# defaults still do, so it is the one thing worth pinning, and it is asserted
# as an absence because a login item lives in BTM rather than under our
# defaults domain: nothing here can see it having been written, only the
# decision not to. Without the store gate every one of these runs registers a
# login item pointing at `jot/build`, which the next checkout replaces, and
# `reap.sh` cannot reach it.
for pair in "fresh:$FRESH_LOGIN" "used:$USED_LOGIN"; do
    which="${pair%%:*}"; line="${pair#*:}"
    case "$line" in
        *loginitem=skipped) ;;
        "") echo "onboarding           FAILED: the $which launch never reached the onboarding defaults" >&2; exit 1 ;;
        *) echo "onboarding           FAILED: the $which launch registered a login item for a build directory" >&2
           echo "  $line" >&2; exit 1 ;;
    esac
done
echo "onboarding           ok: no network switched on, and no login item taken, on either launch"

# ── Autosave off: what Jot promises in both directions ──
#
# The setting says "automatically save while editing", and off has to mean
# what the platform means by it: nothing reaches disk that the person did not
# ask for. This is the arm no unit test can reach, because the promise is
# about a gesture (hiding the panel) and a signal (SIGTERM) rather than about
# a pure function, and it is the arm that hurts if it is wrong in either
# direction. Written as two checks because the two failures are opposite: a
# write on hide breaks the promise, and a quit that ASKS instead of writing
# hangs whatever sent the signal.
#
# Left in place until teardown deliberately. `end_app` below sends SIGTERM,
# which is the unattended quit, and the check that the stamp arrived then is
# in that block.
defaults write "$BIRTA_JOT_DEFAULTS_SUITE" autosave -bool NO
show_panel
# Wait until the APP has seen it, rather than assuming it has.
#
# The write above is made from outside the process, and a running
# `UserDefaults` learns about an external change when the system tells it,
# which is not on any schedule this script controls. Hiding the panel before
# that lands measures an app that was never told the setting changed, and the
# check below then reports the product as ignoring a preference it had not
# received: a red with a true message and a false subject, which is worse than
# no check at all, because the honest reading of it is to re-run.
#
# `__jotPrefs` reports and does nothing else, which is the whole reason it
# exists. Provoking a real decision was tried first and is a trap: the cheapest
# one to provoke is an explicit save, and an explicit save WRITES THE BUFFER to
# the file this check is about to inspect, so the instrument was putting the
# bytes there that it then blamed the product for.
OFF_SEEN=0
for _ in $(seq 1 40); do
    printf '{"type":"__jotPrefs"}' > "$SCRATCH_DIR/.debug-message.json"
    kill -URG $PID; sleep 0.25
    rm -f "$SCRATCH_DIR/.debug-message.json"
    case "$(grep "^jot-trace prefs " "$LOG" | tail -1)" in
        *autosave=no) OFF_SEEN=1; break ;;
    esac
done
if [ "$OFF_SEEN" != 1 ]; then
    echo "autosave off         FAILED: the app never saw the setting, so nothing below is about the product" >&2
    grep "^jot-trace prefs " "$LOG" | tail -3 | sed 's/^/  /' >&2
    exit 1
fi
OFF_STAMP="offprobe-$(date +%s)"
printf '{"type":"__testInsertText","text":"%s\\n"}' "$OFF_STAMP" > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 0.5
hide_panel 0.7
sleep 1.5
rm -f "$SCRATCH_DIR/.debug-message.json"
if grep -q "$OFF_STAMP" "$SCRATCH_DIR/Scratch pad.md" 2>/dev/null; then
    echo "autosave off         FAILED: hiding the panel wrote '$OFF_STAMP' to the note" >&2
    # What the app believed at the decision that wrote it. With the wait above
    # this should always say `autosave=no`, which makes the failure a real one;
    # anything else means the wait stopped working and this is again a red
    # about the probe.
    grep "^jot-trace writedecision " "$LOG" | tail -3 | sed 's/^/  /' >&2
    # ...and every write that was ATTEMPTED, which is the half that names the
    # culprit. A decision and a write are not the same event: `writeLatest` is
    # reachable without going through `write(_:)` at all, from the quit path,
    # from the missing-note rescue and from Save It Back, and none of those
    # leaves a `writedecision` line. Printing only the decisions produced a
    # failure saying the app had refused to write, next to a file it had
    # plainly written, with nothing on screen to reconcile the two.
    grep "^jot-trace writeattempt " "$LOG" | tail -3 | sed 's/^/  /' >&2
    cat "$SCRATCH_DIR/Scratch pad.md" >&2; exit 1
fi
# The typing has to have LANDED, or this passes on a probe that never reached
# the page and proves nothing about hiding. The title is the app's own answer
# to "is the buffer ahead of the file", which is exactly the claim.
OFF_TITLE="$(grep "^jot-trace titletext " "$LOG" | tail -1 | sed 's/^jot-trace titletext //')"
case "$OFF_TITLE" in
    *Edited) echo "autosave off         ok: the hide wrote nothing, and the panel still says \"$OFF_TITLE\"" ;;
    *) echo "autosave off         FAILED: nothing was written and the title does not say Edited either," >&2
       echo "  so the probe never reached the page: \"$OFF_TITLE\"" >&2; exit 1 ;;
esac

# A SECOND WINDOW, and the only claim that matters about it: the two buffers
# are independent. Typing into the new one must reach its own file and must not
# reach the file the first window is on.
#
# Last, deliberately. Everything above is written against one window, and this
# leaves a second one key: `__jotKeys` types into whichever window is in front,
# and the summon toggles now show and hide the whole set.
#
# Autosave is off by the time this runs, so the write is asked for explicitly.
# That is the honest way round anyway: it checks that a save reaches the right
# file, rather than that a timer eventually does.
PAD_BEFORE="$(cat "$BIRTA_JOT_SCRATCHPAD" 2>/dev/null || true)"
printf '{"type":"__jotNewWindow"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.2
rm -f "$SCRATCH_DIR/.debug-message.json"
TWO_STAMP="twowin-$(date +%s)"
printf '{"type":"__testInsertText","text":"%s\\n"}' "$TWO_STAMP" > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 0.6
rm -f "$SCRATCH_DIR/.debug-message.json"
printf '{"type":"__jotSaveNow"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.0
rm -f "$SCRATCH_DIR/.debug-message.json"

# The new note is a file in the same folder that is not the scratchpad.
# Named by the app's own template, so it is found by content rather than by a
# name this script would have to keep in step with NoteNameTemplate.
TWO_FILE=""
for f in "$SCRATCH_DIR"/*.md; do
    [ "$f" = "$BIRTA_JOT_SCRATCHPAD" ] && continue
    if grep -q "$TWO_STAMP" "$f" 2>/dev/null; then TWO_FILE="$f"; break; fi
done
if [ -z "$TWO_FILE" ]; then
    echo "two windows          FAILED: '$TWO_STAMP' reached no file of its own" >&2
    echo "  files beside the scratchpad:" >&2
    ls -1 "$SCRATCH_DIR"/*.md 2>/dev/null | sed 's/^/    /' >&2
    grep "^jot-trace writeattempt " "$LOG" | tail -3 | sed 's/^/  /' >&2
    exit 1
fi
if grep -q "$TWO_STAMP" "$BIRTA_JOT_SCRATCHPAD" 2>/dev/null; then
    echo "two windows          FAILED: typing in the new window also reached the first window's file" >&2
    exit 1
fi
# ...and the first window's file was not disturbed at all, which is the half a
# check that only looked at the new file would miss: a window that had rebound
# both buffers onto one path would still put the stamp somewhere new.
if [ "$(cat "$BIRTA_JOT_SCRATCHPAD" 2>/dev/null || true)" != "$PAD_BEFORE" ]; then
    echo "two windows          FAILED: the first window's file changed while the second was typed into" >&2
    exit 1
fi
echo "two windows          ok: '$TWO_STAMP' went to $(basename "$TWO_FILE") and the first note is untouched"

# WHICH window a file opens into, when the one in front is standing on a file
# that has gone.
#
# `WindowSet.openDocument` asks the frontmost window and nothing else, so both
# arms below are about that window: vacant, it takes the file and no second
# window appears; holding unsaved text, it is left alone and the file gets a
# window of its own. The second arm is the safety one, and it is the reason
# this is a pair rather than one check: a rule that reused any window whose
# file was missing would pass the first arm and rebind away from a buffer
# holding the only copy of somebody's note.
#
# Driven through `__jotOpen`, which skips the chooser and nothing else: the
# rule under test is `openDocument`'s, and a probe that opened a window itself
# would be a second answer able to agree with the real one while being checked.
# The count comes back from `WindowSet` for the same reason.
printf '{"type":"__jotNewWindow"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.5
rm -f "$SCRATCH_DIR/.debug-message.json"
# The window it just made, found by SHAPE rather than by a name this script
# would have to keep in step with `NoteNameTemplate`: a new note is the one
# empty file in the folder.
VACANT_FILE=""
VACANT_N=0
for f in "$SCRATCH_DIR"/*.md; do
    [ -s "$f" ] && continue
    VACANT_FILE="$f"; VACANT_N=$((VACANT_N + 1))
done
if [ "$VACANT_N" != 1 ]; then
    echo "open into empty      FAILED: wanted one empty note to work with, found $VACANT_N" >&2
    ls -l "$SCRATCH_DIR"/*.md >&2; exit 1
fi
# Gone, and the panel told about it the way the deleted-note check above does:
# `rm` is not a coordinated delete, so it is the pre-write existence check that
# notices rather than the file presenter.
rm -f "$VACANT_FILE"
printf '{"type":"__jotSaveNow"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.2
rm -f "$SCRATCH_DIR/.debug-message.json"
if ! grep -q "^jot-trace noteMissing at=$(basename "$VACANT_FILE")$" "$LOG"; then
    echo "open into empty      FAILED: the front window never noticed its file was gone" >&2
    echo "  (so the open below would have proved nothing)" >&2
    grep "^jot-trace noteMissing " "$LOG" | tail -3 | sed 's/^/  /' >&2; exit 1
fi
printf 'a third note\n' > "$SCRATCH_DIR/Third note.md"
printf '{"type":"__jotOpen","path":"%s"}' "$SCRATCH_DIR/Third note.md" > "$SCRATCH_DIR/.debug-message.json"
# Longer than the other waits here: taking the file over reloads the page, and
# the arm below types into it.
kill -URG $PID; sleep 3.0
rm -f "$SCRATCH_DIR/.debug-message.json"
OPENED="$(grep "^jot-trace open " "$LOG" | tail -1 | sed 's/^jot-trace open //')"
O_WINDOWS="$(echo "$OPENED" | sed -n 's/.*windows=\([0-9-]*\).*/\1/p')"
O_AT="$(echo "$OPENED" | sed -n 's/.*at=\(.*\) missing=.*/\1/p')"
if [ "$O_WINDOWS" != 3 ] || [ "$O_AT" != "Third note.md" ] || [ "${OPENED#*missing=}" != "false" ]; then
    echo "open into empty      FAILED: the file did not take over the window whose note had gone" >&2
    echo "  wanted windows=3 at=Third note.md missing=false, got: ${OPENED:-<nothing>}" >&2; exit 1
fi
echo "open into empty      ok: the file took the window that was standing on a deleted note"

# ...and the other arm: a window whose buffer is the only copy is left alone.
#
# Same gesture, same state, one difference: this window's buffer has text in it
# that exists nowhere else, because the file it came from has just been
# deleted. Rebinding it away would drop those bytes, so the file opened here
# has to get a window of its own.
O_STAMP="vacancy-$(date +%s)"
printf '{"type":"__testInsertText","text":"%s\n"}' "$O_STAMP" > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 0.6
rm -f "$SCRATCH_DIR/.debug-message.json"
rm -f "$SCRATCH_DIR/Third note.md"
printf '{"type":"__jotSaveNow"}' > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.2
rm -f "$SCRATCH_DIR/.debug-message.json"
if ! grep -q "^jot-trace noteMissing at=Third note.md$" "$LOG"; then
    echo "open into empty      FAILED: the window never noticed Third note.md was gone" >&2
    grep "^jot-trace noteMissing " "$LOG" | tail -3 | sed 's/^/  /' >&2; exit 1
fi
printf 'a fourth note\n' > "$SCRATCH_DIR/Fourth note.md"
printf '{"type":"__jotOpen","path":"%s"}' "$SCRATCH_DIR/Fourth note.md" > "$SCRATCH_DIR/.debug-message.json"
kill -URG $PID; sleep 1.5
rm -f "$SCRATCH_DIR/.debug-message.json"
KEPT="$(grep "^jot-trace open " "$LOG" | tail -1 | sed 's/^jot-trace open //')"
K_WINDOWS="$(echo "$KEPT" | sed -n 's/.*windows=\([0-9-]*\).*/\1/p')"
K_AT="$(echo "$KEPT" | sed -n 's/.*at=\(.*\) missing=.*/\1/p')"
if [ "$K_WINDOWS" != 4 ] || [ "$K_AT" != "Third note.md" ]; then
    echo "open into empty      FAILED: a window holding the only copy of a note was rebound away from it" >&2
    echo "  wanted windows=4 at=Third note.md, got: ${KEPT:-<nothing>}" >&2; exit 1
fi
echo "open into empty      ok: and a window still holding unsaved text kept it, in a window of its own"

# What a second window COSTS, measured rather than estimated: MAR-396 asks for
# this figure and nobody had one.
#
# The helper set is re-diffed against the pre-launch snapshot rather than reused
# from the idle measurement above, and that is the whole difference between a
# figure and a wrong figure: `WK_OURS` was captured when there was one window,
# so a helper the second window started would not be in it and the delta would
# read as almost nothing. Whether a second WKWebView on the same origin gets a
# WebContent process of its own is WebKit's business and not something to
# assume in either direction, which is exactly why this counts rather than
# reasons.
sleep 3
WK_TWO="$(comm -13 <(printf '%s\n' "$WC_BEFORE") <(pgrep -f com.apple.WebKit | sort || true) | tr '\n' ' ')"
RSS_TWO=$(ps -o rss= -p $PID | tr -d ' ')
for h in $WK_TWO; do
    RSS_TWO=$((RSS_TWO + $(ps -o rss= -p "$h" 2>/dev/null || echo 0)))
done
echo "RSS with two windows $((RSS_TWO / 1024)) MB   (app + $(printf '%s' "$WK_TWO" | wc -w | tr -d ' ') WebKit helpers)"

echo "idle RSS app         $((RSS_APP / 1024)) MB"
echo "idle RSS helpers     $((RSS_HELPERS / 1024)) MB   (WebKit helpers that appeared since launch: ${WK_OURS:-none})"

# This run takes its own processes with it.
#
# WebKit's helpers are NOT children of the app, so nothing reaps them for us:
# they exit because the app asks them to, which only happens when the app is
# ended through its SIGTERM trap. A hard kill anywhere, or a teardown that has
# silently stopped running, leaves a GPU, a Networking and a WebContent process
# per launch sitting at a fraction of a core indefinitely. They are invisible
# to the harness lock, they read as unexplained load to whoever is next on the
# machine, and they are one reason a red suite can be nobody's fault.
#
# Asserted here rather than trusted to the trap, because the trap is the thing
# that breaks: a second `trap ... EXIT` REPLACES the first, so a cleanup added
# later turns this off with nothing to say so.
if [ $KEEP = 0 ]; then
    end_app
    sleep 2
    WK_AFTER="$(pgrep -f com.apple.WebKit | sort || true)"
    WK_LEFT="$(comm -12 <(printf '%s\n' "$WK_OURS" | tr ' ' '\n' | sort | grep -v '^$' || true) \
                        <(printf '%s\n' "$WK_AFTER") | tr '\n' ' ')"
    if [ -n "${WK_LEFT// /}" ]; then
        echo "teardown             FAILED: this run left WebKit helpers behind: $WK_LEFT" >&2
        echo "  (the app did not end through its SIGTERM trap, so nothing asked them to exit)" >&2
        exit 1
    fi
    echo "teardown             ok: the app and every helper it started are gone"
    # The other half of the autosave-off promise, and the one that would hang
    # an installer if it went the other way. `end_app` sent SIGTERM, which is
    # how a running copy is replaced and how anything else managing the process
    # ends it; there is nobody there to answer a sheet, so that quit keeps the
    # bytes rather than asking about them.
    if grep -q "$OFF_STAMP" "$SCRATCH_DIR/Scratch pad.md" 2>/dev/null; then
        echo "autosave off         ok: SIGTERM wrote '$OFF_STAMP' rather than asking"
    else
        echo "autosave off         FAILED: SIGTERM did not write the buffer, so an unattended quit" >&2
        echo "  either dropped it or is sitting on a sheet nobody can answer" >&2
        cat "$SCRATCH_DIR/Scratch pad.md" >&2; exit 1
    fi
fi

echo "log: $LOG"
