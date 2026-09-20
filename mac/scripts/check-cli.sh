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
# The command is taken from `swift build`, so no app bundle is needed. Where
# one is present the version arm runs against it too.
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
# One trap, and it must stay the only one: a second `trap ... EXIT` REPLACES
# this rather than adding to it, which is how a cleanup switches off the
# cleanup before it while the script still passes.
trap 'rm -rf "$WORK"' EXIT

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

echo "--wait"
run --wait real.md < /dev/null
expect_status 2 "$STATUS" "--wait"
expect_contains "$OUT" "--wait is not available yet" "--wait says it is not built"
run --wait < /dev/null
expect_status 2 "$STATUS" "--wait with no file"

echo "--help"
run --help < /dev/null
expect_status 0 "$STATUS" "--help"
expect_contains "$OUT" "usage:" "--help prints usage"
expect_contains "$OUT" ".md, .markdown, .mdx" "--help names what is opened"
expect_contains "$OUT" "--wait" "--help names the flag that is not built yet"

echo "piped text"
# Into a throwaway Application Support, never the real one: that folder holds
# somebody's own files and a check has no business tidying up in it.
export BIRTA_MAC_CLI_SUPPORT="$WORK/support"
OUT="$(printf 'piped text\n' | "$BWR" 2>&1)"; STATUS=$?
expect_status 0 "$STATUS" "pipe"
expect_contains "$OUT" "$WORK/support/Birta Writer/Piped/" \
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
expect_contains "$OUT" "$WORK/support/Birta Writer [DEV]/Piped/" \
    "a development build pipes into a folder of its own"

cd "$REPO"
echo
if [ "$failures" -eq 0 ]; then
    echo "check-cli: $checks checks, all green"
else
    echo "check-cli: $failures of $checks checks failed" >&2
    exit 1
fi
