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

APP="jot/build/Birta Jot.app/Contents/MacOS/BirtaJot"
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
trap 'defaults delete "$BIRTA_JOT_DEFAULTS_SUITE" >/dev/null 2>&1 || true' EXIT
# The formatting row ships closed, and what this script has to look at is an
# open one. Seeded through the view-state bag the app really restores from,
# rather than through a debug message: the restore path is itself part of what
# is being checked, and a message that forced the row open would leave it
# unexercised.
# `-string` is load-bearing: without it `defaults` reads the braces as
# old-style plist syntax, fails to parse, and writes nothing at all.
defaults write "$BIRTA_JOT_DEFAULTS_SUITE" viewState -string '{"formattingDockExpanded":true}'
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
if awk "BEGIN{exit !($TB_NEED_W > 0)}" \
   && awk "BEGIN{exit !($TB_GOT_W >= $TB_NEED_W - 0.5)}" \
   && awk "BEGIN{exit !($TB_INK_W >= $TB_NEED_W - 2)}"; then
    echo "title ink            ok: the name is drawn to the width its glyphs need (ink $TB_INK_W, needs $TB_NEED_W)"
else
    echo "title ink            FAILED: the title is not drawn in full" >&2
    echo "  needs=$TB_NEED_W got=$TB_GOT_W ink=$TB_INK_W" >&2
    echo "$TITLEBAR" >&2; exit 1
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
echo "idle RSS app         $((RSS_APP / 1024)) MB"
echo "idle RSS helpers     $((RSS_HELPERS / 1024)) MB   (WebKit helpers that appeared since launch: ${WK_OURS:-none})"
echo "log: $LOG"
