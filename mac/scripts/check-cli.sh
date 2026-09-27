#!/usr/bin/env bash
# Drive the `bwr` command over every row of its invocation table and assert
# what it did.
#
#   bash mac/scripts/check-cli.sh
#
# Beside mac/scripts/measure.sh rather than inside it: that one reports
# timings, this one asserts behaviour and fails. It is also much cheaper,
# because nothing here launches the app. `BIRTA_MAC_CLI_DRY_RUN=1` makes the
# command print the launch it would perform instead of performing it, while
# still doing its own half of the work: creating a file the shell named into
# being, and writing piped text. So what is asserted is the filesystem the
# command leaves behind and the request it would hand to LaunchServices.
#
# What this cannot reach is the app's side of the handoff: that `--summon`
# brings the windows up, and that an opened file lands where `OpenRouting`
# says. Those need a running app and belong to mac/scripts/measure.sh.
#
# The one exception is `--wait`, whose whole point is the app talking back.
# Its arm at the bottom launches the app this tree built (`mac/build`, from
# `pnpm mac:build`), the way check-external-change.sh does, with the note
# bound as the scratchpad of a throwaway defaults domain rather than opened
# through LaunchServices, which would start whichever copy is installed. The
# dry run still reaches the socket, so what that arm drives is the real
# registration, the real close and the real write, against a real listener.
# Unlike the other launching scripts it does not need the screen: nothing it
# asserts is on screen, and the debug signals it drives the app with
# (SIGUSR1 summons, SIGURG posts a message beside the scratchpad) do not
# either. It is skipped, loudly, when there is no app to launch.
#
# The command is taken from `swift build`, so no app bundle is needed for
# the rest: the bundles those arms point it at are fabricated here, plists
# included.
set -uo pipefail

cd "$(dirname "$0")/../.."
REPO="$PWD"

failures=0
checks=0

# The assertions. Every one of them says what it expected, because a check
# whose failure reads "check 7 failed" costs a reader the same investigation
# twice.
expect_status() {
    local want="$1" got="$2" what="$3"
    checks=$((checks + 1))
    if [ "$got" != "$want" ]; then
        echo "FAIL $what: exit $got, wanted $want" >&2
        failures=$((failures + 1))
    fi
}

expect_contains() {
    local haystack="$1" needle="$2" what="$3"
    checks=$((checks + 1))
    case "$haystack" in
        *"$needle"*) ;;
        *)
            echo "FAIL $what: no '$needle' in:" >&2
            printf '%s\n' "$haystack" | sed 's/^/    /' >&2
            failures=$((failures + 1))
            ;;
    esac
}

expect_file() {
    checks=$((checks + 1))
    if [ ! -f "$1" ]; then
        echo "FAIL $2: $1 is not there" >&2
        failures=$((failures + 1))
    fi
}

expect_no_file() {
    checks=$((checks + 1))
    if [ -e "$1" ]; then
        echo "FAIL $2: $1 exists and should not" >&2
        failures=$((failures + 1))
    fi
}

echo "swift build"
swift build --package-path mac >/dev/null
BWR="$(swift build --package-path mac --show-bin-path)/BirtaWriterCli"
[ -x "$BWR" ] || { echo "no command at $BWR" >&2; exit 1; }

WORK="$(cd "$(mktemp -d)" && pwd -P)"
# The throwaway Application Support, for the piped file and for the `--wait`
# socket, and never the real one: that folder holds somebody's own files and
# a check has no business tidying up in it. Under /tmp by name rather than
# under $WORK, because a Unix socket's path has to fit `sun_path`, and the
# folder `mktemp -d` gives on macOS is already most of that budget.
SUPPORT="/tmp/bwr-check-$$"
export BIRTA_MAC_CLI_SUPPORT="$SUPPORT"
# The app arm's process and defaults domain, if it runs; empty otherwise.
APP_PID=""
APP_SUITE=""
# SIGTERM through the app's own handler, never SIGKILL: WebKit's helpers are
# not children of the app and only exit because the app asks them to.
end_app() {
    [ -n "$APP_PID" ] || return 0
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
    APP_PID=""
}
# One trap, and it must stay the only one: a second `trap ... EXIT` REPLACES
# this rather than adding to it, which is how a cleanup switches off the
# cleanup before it while the script still passes. `defaults delete` leaves
# the plist behind (cfprefsd writes it back), so the file goes too, by exact
# name and never by a glob over the app's own domain, which is a prefix of it.
trap 'end_app; rm -rf "$WORK" "$SUPPORT"; if [ -n "$APP_SUITE" ]; then defaults delete "$APP_SUITE" >/dev/null 2>&1 || true; rm -f "$HOME/Library/Preferences/$APP_SUITE.plist"; fi' EXIT

export BIRTA_MAC_CLI_DRY_RUN=1
cd "$WORK"
printf 'hello\n' > real.md
mkdir folder

run() {
    # stdin closed unless a caller pipes into `run` itself, which is what the
    # command reads to tell a pipe from a person at a terminal.
    OUT="$("$BWR" "$@" 2>&1)"
    STATUS=$?
}

echo "no arguments"
run < /dev/null
expect_status 0 "$STATUS" "bare invocation"
# The word, not just the verb. The app reads it out of its own argv and the
# two programs cannot see each other's spelling of it.
expect_contains "$OUT" "summon --summon" "bare invocation summons"

echo "a file that is there"
run real.md < /dev/null
expect_status 0 "$STATUS" "existing file"
expect_contains "$OUT" "open $WORK/real.md" "existing file is opened by absolute path"

echo "a file that is not"
run new.md < /dev/null
expect_status 0 "$STATUS" "new file"
expect_contains "$OUT" "create $WORK/new.md" "new file is created"
expect_contains "$OUT" "open $WORK/new.md" "new file is opened"
expect_file "$WORK/new.md" "new file reaches disk"

echo "a folder"
run folder < /dev/null
expect_status 0 "$STATUS" "folder"
expect_contains "$OUT" "open $WORK/folder" "folder is opened"

echo "two files"
run real.md second.md < /dev/null
expect_status 0 "$STATUS" "two files"
expect_contains "$OUT" "open $WORK/real.md" "first of two is opened"
expect_contains "$OUT" "open $WORK/second.md" "second of two is opened"

echo "a file the editor does not open"
run Makefile < /dev/null
expect_status 2 "$STATUS" "unsupported extension"
expect_contains "$OUT" "not a file Birta Writer opens" "unsupported extension says so"
expect_no_file "$WORK/Makefile" "unsupported extension creates nothing"

echo "a folder that is not there"
run nowhere/new.md < /dev/null
expect_status 2 "$STATUS" "missing parent directory"
expect_contains "$OUT" "no such directory" "missing parent says so"

echo "an unknown option"
run --nope < /dev/null
expect_status 2 "$STATUS" "unknown option"
expect_contains "$OUT" "unknown option: --nope" "unknown option names itself"

echo "a file whose name begins with a hyphen"
printf 'dash\n' > ./-weird.md
run -- -weird.md < /dev/null
expect_status 0 "$STATUS" "hyphen file after --"
expect_contains "$OUT" "open $WORK/-weird.md" "hyphen file after -- is a path"

echo "--wait, with no app to answer"
# Nothing listens in the throwaway support folder, and a dry run launches
# nothing, so the wait is refused at once rather than retried: exit 1, with
# the socket it looked for named. The real thing is the arm at the bottom.
run --wait real.md < /dev/null
expect_status 1 "$STATUS" "--wait with no app"
expect_contains "$OUT" "not running" "--wait with no app says so"
expect_contains "$OUT" "$SUPPORT/Birta Writer/control.sock" "--wait names the socket it looked for"
run --wait < /dev/null
expect_status 2 "$STATUS" "--wait with no file"
run --wait folder < /dev/null
expect_status 2 "$STATUS" "--wait on a folder"
expect_contains "$OUT" "is a folder" "--wait on a folder says so"

echo "an extensionless file, without --wait and under it"
# `git commit` names COMMIT_EDITMSG. Without the flag it is a Makefile: refused
# and not created. Under the flag the caller chose it: created, and it would
# be opened; what fails here is only the wait, since no app answers.
run COMMIT_EDITMSG < /dev/null
expect_status 2 "$STATUS" "extensionless without --wait"
expect_no_file "$WORK/COMMIT_EDITMSG" "extensionless without --wait creates nothing"
run --wait COMMIT_EDITMSG < /dev/null
expect_status 1 "$STATUS" "extensionless under --wait, no app"
expect_contains "$OUT" "create $WORK/COMMIT_EDITMSG" "extensionless under --wait is created"
expect_file "$WORK/COMMIT_EDITMSG" "extensionless under --wait reaches disk"

echo "--help"
run --help < /dev/null
expect_status 0 "$STATUS" "--help"
expect_contains "$OUT" "usage:" "--help prints usage"
expect_contains "$OUT" ".md, .markdown, .mdx" "--help names what is opened"
expect_contains "$OUT" "--wait" "--help names --wait"

echo "piped text"
OUT="$(printf 'piped text\n' | "$BWR" 2>&1)"; STATUS=$?
expect_status 0 "$STATUS" "pipe"
expect_contains "$OUT" "$SUPPORT/Birta Writer/Piped/" \
    "piped text lands in the app's own Piped folder"
PIPED="$(printf '%s\n' "$OUT" | sed -n 's/^write //p')"
expect_file "$PIPED" "piped file reaches disk"
checks=$((checks + 1))
if [ "$(cat "$PIPED" 2>/dev/null)" != "piped text" ]; then
    echo "FAIL piped bytes: $PIPED does not hold what was piped" >&2
    failures=$((failures + 1))
fi

echo "an empty pipe"
OUT="$(: | "$BWR" 2>&1)"; STATUS=$?
expect_status 1 "$STATUS" "empty pipe"
expect_contains "$OUT" "nothing on standard input" "empty pipe says so"

echo "--version, against a bundle"
# A bundle rather than the app, because what --version reads is one key of one
# Info.plist and building the whole app to check that is minutes for nothing.
FAKE="$WORK/Birta Writer.app"
mkdir -p "$FAKE/Contents/MacOS"
cat > "$FAKE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.birtalabs.birta-writer</string>
  <key>CFBundleShortVersionString</key><string>25.9.20</string>
</dict></plist>
PLIST
OUT="$(BIRTA_MAC_CLI_BUNDLE="$FAKE" "$BWR" --version 2>&1)"; STATUS=$?
expect_status 0 "$STATUS" "--version"
# `Version <number>`, which is the sentence the About window draws: one
# spelling for every surface that names a build (`AboutInfo`).
expect_contains "$OUT" "Birta Writer Version 25.9.20" "--version reports the app's version"

echo "a real bundle's command finds its own app"
# The placement the installed symlink depends on: the command inside
# Contents/MacOS, reached through a link, walks back to the bundle around it.
cp "$BWR" "$FAKE/Contents/MacOS/bwr"
mkdir -p "$WORK/bin"
ln -sf "$FAKE/Contents/MacOS/bwr" "$WORK/bin/bwr"
OUT="$("$WORK/bin/bwr" --version 2>&1)"; STATUS=$?
expect_status 0 "$STATUS" "--version through a symlink"
expect_contains "$OUT" "Birta Writer Version 25.9.20" "the linked command finds its own bundle"

echo "a build nobody stamped says so rather than naming a number"
# Every local build is 0.0.0, which identifies no release and dates nothing.
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.0.0" \
    "$FAKE/Contents/Info.plist" >/dev/null
OUT="$(BIRTA_MAC_CLI_BUNDLE="$FAKE" "$BWR" --version 2>&1)"; STATUS=$?
expect_status 0 "$STATUS" "--version on an unstamped build"
expect_contains "$OUT" "Development build" "an unstamped build is named rather than numbered"

echo "a development build keeps its piped text apart"
# The flavour is read off the bundle the command belongs to, which is why the
# bundle is looked for even under a dry run: a development build dropping files
# among the release's is the thing the flavour split exists to stop, and a dry
# run that skipped the lookup would report the release's folder and call it
# right.
DEV="$WORK/Birta Writer [DEV].app"
mkdir -p "$DEV/Contents"
sed 's/com.birtalabs.birta-writer</com.birtalabs.birta-writer-dev</' \
    "$FAKE/Contents/Info.plist" > "$DEV/Contents/Info.plist"
OUT="$(printf 'dev text\n' | BIRTA_MAC_CLI_BUNDLE="$DEV" "$BWR" 2>&1)"; STATUS=$?
expect_status 0 "$STATUS" "pipe into a development build"
expect_contains "$OUT" "$SUPPORT/Birta Writer [DEV]/Piped/" \
    "a development build pipes into a folder of its own"

echo "--wait, against a running app"
# The app this tree built, launched here rather than through LaunchServices
# (which starts whichever copy is installed), with a throwaway note bound as
# its scratchpad. The command reaches it through the socket alone: under the
# dry run it prints the open it would make instead of making one, and the
# note is already open. What is driven is every exit the wait has, in the
# order that leaves the app running for the next: a close after an edit, a
# second wait taking over, a close whose write fails, and the quit.
APP_BUNDLE="$REPO/mac/build/Birta Writer.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/BirtaWriter"
APP_ARM="skipped: no app at $APP_BUNDLE (pnpm mac:build builds one)"
if [ -x "$APP_BIN" ]; then
    APP_ARM="ran"
    FAILURES_BEFORE_APP=$failures
    WAIT_DIR="$WORK/w"
    mkdir -p "$WAIT_DIR"
    NOTE="$WAIT_DIR/Note.md"
    printf 'first line\n' > "$NOTE"
    APP_LOG="$WORK/app.log"
    APP_SUITE="com.birtalabs.birta-writer.check-cli.$$"
    BIRTA_MAC_SCRATCHPAD="$NOTE" BIRTA_MAC_DEFAULTS_SUITE="$APP_SUITE" BIRTA_MAC_MEASURE=1 \
        "$APP_BIN" 2>"$APP_LOG" &
    APP_PID=$!
    # The flavour the command belongs to has to be the app's, or the two
    # meet on different sockets. Read off the bundle, as an installed
    # command reads its own.
    export BIRTA_MAC_CLI_BUNDLE="$APP_BUNDLE"

    marks() { grep -c "^mac-measure $1 " "$APP_LOG"; }
    # Wait for one MORE of a mark than the log held when the gesture was
    # sent, never for the mark to exist: every arm after the first would
    # otherwise be satisfied by the first arm's marks and read as sequenced
    # while racing the app.
    wait_for() { # wait_for <mark> <timeout-s> <count-before>
        local n=0
        while [ "$(marks "$1")" -le "$3" ]; do
            sleep 0.1; n=$((n+1))
            if [ $n -gt $(( $2 * 10 )) ]; then
                echo "FAIL timeout waiting for the app's $1 mark" >&2
                failures=$((failures + 1))
                return 1
            fi
        done
    }
    wait_line() { # wait_line <file> <text> <timeout-s>
        local n=0
        while ! grep -qF -- "$2" "$1" 2>/dev/null; do
            sleep 0.1; n=$((n+1))
            if [ $n -gt $(( $3 * 10 )) ]; then
                echo "FAIL timeout waiting for '$2' in $1" >&2
                failures=$((failures + 1))
                return 1
            fi
        done
    }
    # Post one debug message to the front window and wait for the mark it
    # leaves. The file goes beside the scratchpad, which is where the app
    # reads it from.
    post() { # post <json> <mark>
        local before
        before="$(marks "$2")"
        printf '%s' "$1" > "$WAIT_DIR/.debug-message.json"
        kill -URG "$APP_PID"
        wait_for "$2" 10 "$before"
    }
    summon() {
        local before
        before="$(marks visible)"
        kill -USR1 "$APP_PID"
        wait_for visible 10 "$before"
    }
    # The exit status of a background command, or 124 when it is still
    # running after the timeout: a wait that never ends must read as a
    # failure rather than hanging this script.
    wait_pid() { # wait_pid <pid> <timeout-s>
        local n=0
        while kill -0 "$1" 2>/dev/null; do
            sleep 0.1; n=$((n+1))
            if [ $n -gt $(( $2 * 10 )) ]; then
                kill "$1" 2>/dev/null || true
                STATUS=124
                return
            fi
        done
        wait "$1"; STATUS=$?
    }
    # Two waits in a row on one file: the first is told the second took over.
    start_wait() { # start_wait <out-file>
        "$BWR" --wait "$NOTE" > "$1" 2>&1 &
        WAIT_PID=$!
        wait_line "$1" "wait $NOTE" 10
    }
    close_front() {
        summon
        post '{"type":"__birtaCloseWindow"}' debug-close-window
    }

    if wait_for ready 40 0; then
        SOCK="$(find "$SUPPORT" -name control.sock 2>/dev/null | head -1)"
        checks=$((checks + 1))
        if [ ! -S "$SOCK" ]; then
            echo "FAIL the app bound no socket under $SUPPORT" >&2
            failures=$((failures + 1))
        fi

        echo "  a close after an edit ends the wait 0, with the edit on disk"
        start_wait "$WORK/w1.out"; W1=$WAIT_PID
        summon
        post '{"type":"__birtaKeys","keys":["End","Enter","w","a","i","t","e","d"]}' debug-keys
        sleep 0.5
        post '{"type":"__birtaCloseWindow"}' debug-close-window
        wait_pid $W1 15
        expect_status 0 "$STATUS" "--wait after a close"
        expect_contains "$(cat "$NOTE")" "waited" "the edit is on disk when --wait returns"
        expect_contains "$(cat "$WORK/w1.out")" "open $NOTE" "the dry run still reports the open"

        echo "  a second wait on the same file ends the first nonzero"
        start_wait "$WORK/w2.out"; W2=$WAIT_PID
        start_wait "$WORK/w3.out"; W3=$WAIT_PID
        wait_pid $W2 10
        expect_status 1 "$STATUS" "the superseded wait"
        expect_contains "$(cat "$WORK/w2.out")" "took over" "the superseded wait says why"
        close_front
        wait_pid $W3 15
        expect_status 0 "$STATUS" "the wait that took over ends on the close"

        echo "  a close whose write fails ends the wait nonzero"
        start_wait "$WORK/w4.out"; W4=$WAIT_PID
        summon
        # The folder is closed to writes before the keys land, so the
        # autosave the edit schedules and the close's own write both fail.
        # The message file is written first, since it lives in that folder.
        BEFORE="$(marks debug-keys)"
        printf '%s' '{"type":"__birtaKeys","keys":["End","Enter","l","o","s","t"]}' > "$WAIT_DIR/.debug-message.json"
        chmod 500 "$WAIT_DIR"
        kill -URG "$APP_PID"
        wait_for debug-keys 10 "$BEFORE"
        sleep 1.5
        chmod 700 "$WAIT_DIR"
        BEFORE="$(marks debug-close-window)"
        printf '%s' '{"type":"__birtaCloseWindow"}' > "$WAIT_DIR/.debug-message.json"
        chmod 500 "$WAIT_DIR"
        kill -URG "$APP_PID"
        wait_for debug-close-window 10 "$BEFORE"
        wait_pid $W4 15
        chmod 700 "$WAIT_DIR"
        expect_status 1 "$STATUS" "--wait after a close that could not write"
        expect_contains "$(cat "$WORK/w4.out")" "could not write" "a failed write says so"
        checks=$((checks + 1))
        if grep -q "lost" "$NOTE"; then
            echo "FAIL the failed write reached the disk after all" >&2
            failures=$((failures + 1))
        fi

        echo "  an extensionless file a shell waits on is admitted, and its tab's close ends the wait"
        # The other half of admitting COMMIT_EDITMSG, driven through
        # `WindowSet.openDocument` itself (`__birtaOpen` skips only the
        # chooser). The file lands as a second window, so the close that
        # follows is a real close rather than the last window's hide, which
        # is the exit the arms above cannot reach. The comment block is read
        # back byte for byte: git ignores those lines, and an editor that
        # rewrote them would still have changed a file it was asked to edit.
        #
        # Nothing is typed here. With two windows up and none of them key,
        # which window a debug message reaches is `WindowSet.key`'s fallback,
        # and the keys and the close were measured landing in different
        # windows; the close is the gesture this arm is about, and the write
        # path it takes is the one the first arm typed into.
        MSG="$WAIT_DIR/COMMIT_EDITMSG"
        printf '\n# Please enter the commit message for your changes.\n#\n# On branch main\n#\tmodified:   README.md\n' > "$MSG"
        "$BWR" --wait "$MSG" > "$WORK/w6.out" 2>&1 &
        W6=$!
        wait_line "$WORK/w6.out" "wait $MSG" 10
        # The new window is a second page, and a cold one; the close waits
        # for its `ready` mark so it closes a mounted document.
        READY_BEFORE="$(marks ready)"
        post "{\"type\":\"__birtaOpen\",\"path\":\"$MSG\"}" debug-open
        wait_line "$APP_LOG" "open windows=" 10
        expect_contains "$(grep 'open windows=' "$APP_LOG" | tail -1)" "open windows=2" \
            "the extensionless file opened as a window of its own"
        wait_for ready 30 "$READY_BEFORE"
        sleep 0.5
        post '{"type":"__birtaCloseWindow"}' debug-close-window
        expect_contains "$(grep 'closewindow at=' "$APP_LOG" | tail -1)" "COMMIT_EDITMSG" \
            "the close reached the extensionless file's window"
        wait_pid $W6 15
        expect_status 0 "$STATUS" "--wait on the extensionless file after its tab closed"
        expect_contains "$(cat "$MSG")" "#	modified:   README.md" "the comment block is untouched, tab included"
        expect_contains "$(cat "$MSG")" "# On branch main" "the comment block is untouched"

        echo "  a quit ends the wait nonzero and takes the socket away"
        start_wait "$WORK/w5.out"; W5=$WAIT_PID
        kill "$APP_PID"
        wait_pid $W5 15
        expect_status 1 "$STATUS" "--wait through a quit"
        expect_contains "$(cat "$WORK/w5.out")" "quit before" "a quit says so"
        end_app
        expect_no_file "$SOCK" "the socket file goes with the app"
    fi
    end_app
    # A red in this arm without the app's own log is undiagnosable, since
    # the folder it was written to goes with the trap.
    if [ "$failures" -gt "$FAILURES_BEFORE_APP" ]; then
        echo "the app's log, last lines:" >&2
        tail -60 "$APP_LOG" | sed 's/^/    /' >&2
    fi
fi

cd "$REPO"
echo
echo "check-cli: app arm $APP_ARM"
if [ "$failures" -eq 0 ]; then
    echo "check-cli: $checks checks, all green"
else
    echo "check-cli: $failures of $checks checks failed" >&2
    exit 1
fi
