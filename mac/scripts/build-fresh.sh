#!/usr/bin/env bash
# Is the built Mac app the one this tree would produce?
#
# `measure.sh` drives whatever sits in `mac/build` and reports on the product.
# Nothing makes that bundle prove where it came from, so a build left from an
# earlier checkout answers every arm confidently, and the arms that go red are
# whichever ones cover what changed since. The verdict is indistinguishable
# from a real one, which is what makes it expensive: it names a subject that is
# working and sends the reader to fix it.
#
# The case this exists for: a bundle whose Swift half did not declare the
# `spellAndGrammar` capability. The page reads that declaration to decide
# whether to post `lintBlocks` at all (`webview/plugins/proofread.ts`), so it
# posted none, and the spelling and grammar arms both reported the system
# checker broken. `NSSpellChecker` was fine, `SpellServiceTests` was green, and
# nothing in either message pointed at the build.
#
# The bundle is assembled from two halves built by separate commands, so each
# hop between a source and the artifact carrying it is asked about:
#
#   dist/                     <- webview/, shared/, packages/, esbuild.mjs
#   the bundle's web/dist/    <- dist/
#   the bundle's binary       <- mac/Sources/, mac/Package.swift, mac/Resources/
#
# Exit 0 when every hop is current; otherwise name the stale hop and exit 1.
# It refuses rather than warns, for the same reason `measure.sh` asserts its own
# teardown: a warning inside a long report is read by nobody, and the run it
# would have qualified is the one whose numbers get quoted.
#
# Staleness is read from mtimes, which is what a rebuild moves and what a
# checkout moves. That makes it answerable without hashing the tree, and it is
# a floor rather than a proof: it catches a bundle older than the sources,
# never one built from equally old sources somewhere else.
#
# Usage: bash mac/scripts/build-fresh.sh [--repo DIR] [--app PATH]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP=""
while [ $# -gt 0 ]; do
    case "$1" in
        --repo) REPO="$(cd "$2" && pwd)"; shift ;;
        --app) APP="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
[ -n "$APP" ] || APP="$REPO/mac/build/Birta Writer.app"

BIN="$APP/Contents/MacOS/BirtaWriter"
EMBEDDED="$APP/Contents/Resources/web/dist/webview.js"
DIST="$REPO/dist/webview.js"

REBUILD="  pnpm build && bash mac/scripts/build-app.sh"

if [ ! -x "$BIN" ]; then
    echo "stale build: no runnable app at $APP" >&2
    echo "$REBUILD" >&2
    exit 1
fi

# The first file under any of the given repo-relative roots that is newer than
# the reference, or nothing. Directories that never reach the bundle are pruned
# so an edit to a test cannot refuse a build that is genuinely current.
newer_than() { # newer_than <reference-file> <repo-relative-root>...
    local ref="$1"; shift
    local roots=() r
    for r in "$@"; do
        [ -e "$REPO/$r" ] && roots+=("$REPO/$r")
    done
    [ ${#roots[@]} -gt 0 ] || return 0
    find "${roots[@]}" \
        \( -name node_modules -o -name __tests__ -o -name __mocks__ -o -name dist \) -prune -o \
        -type f -newer "$ref" -print -quit
}

STALE=0
report() { echo "stale build: $1" >&2; STALE=1; }

if [ ! -f "$DIST" ]; then
    report "no dist/webview.js"
else
    src="$(newer_than "$DIST" webview shared packages esbuild.mjs)"
    [ -z "$src" ] || report "dist/ is older than ${src#"$REPO"/}"
fi

if [ ! -f "$EMBEDDED" ]; then
    report "the bundle carries no page at Contents/Resources/web/dist/webview.js"
elif [ -f "$DIST" ] && [ "$DIST" -nt "$EMBEDDED" ]; then
    report "the bundle's page is older than dist/webview.js"
fi

swift_src="$(newer_than "$BIN" mac/Sources mac/Package.swift mac/Resources)"
[ -z "$swift_src" ] || report "the app binary is older than ${swift_src#"$REPO"/}"

if [ "$STALE" = 1 ]; then
    echo "refusing to measure a build that is not this tree's." >&2
    echo "$REBUILD" >&2
    exit 1
fi
