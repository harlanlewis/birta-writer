#!/usr/bin/env bash
# Install "Birta Writer Jot.app" where macOS expects to find it, replacing a running
# copy safely.
#
#   pnpm jot:install                       # production build, then this
#   bash jot/scripts/install-app.sh        # assumes jot/build/ is current
#   bash jot/scripts/install-app.sh --build
#
# jot/build/ is a build directory, gitignored and branch-shaped: running the
# app from there means whatever the last checkout produced, and a worktree
# switch silently changes which Jot the hotkey summons. /Applications is the
# one copy the user actually runs.
#
# A running copy is asked to quit with SIGTERM, which the app turns into its
# ordinary flush-then-quit (jot/Sources/BirtaJot/App.swift). This script never
# escalates to SIGKILL: the buffer lives in the web content process until that
# flush, so killing to win a race is exactly the trade nothing here should make.
# If the app will not go, the install stops and says so, with the buffer intact.
set -euo pipefail
cd "$(dirname "$0")/../.."

BUILD=0
FLAVOR=release
for arg in "$@"; do
    case "$arg" in
        --build) BUILD=1 ;;
        --dev) FLAVOR=dev ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

# The three names a flavour changes, and every one of them has to move
# together: the bundle, the executable inside it, and therefore what to ask to
# quit. `BirtaJotCore.AppFlavor` is where the reasoning lives.
APP_NAME="Birta Writer Jot"
EXEC_NAME="BirtaJot"
if [ "$FLAVOR" = dev ]; then
    APP_NAME="Birta Writer Jot Dev"
    EXEC_NAME="BirtaJotDev"
fi
SRC="jot/build/$APP_NAME.app"

# Leave the tree as this run found it. Building here produces jot/.build (the
# SwiftPM cache) and jot/build (the assembled app), together a few hundred
# files and a few hundred megabytes in whichever checkout or worktree happened
# to run the install. /Applications is the copy that gets run, so neither is
# wanted afterwards.
#
# Only what this run created is removed. Someone already iterating on the shell
# has both directories before it starts, and their compile cache survives; a
# clean tree gets one cold `swift build` and keeps nothing. A stale assembled
# app is the worse of the two to leave: it is runnable and branch-shaped, which
# is the confusion the header above already warns about.
#
# `pnpm jot:build` is deliberately outside this. Producing jot/build IS its
# result, and a script that deleted its own output would be useless.
HAD_CACHE=0; [ -d jot/.build ] && HAD_CACHE=1
HAD_BUILD=0; [ -d jot/build ] && HAD_BUILD=1
tidy() {
    # Runs on every exit, success or not, and must never change the status the
    # script is exiting with: `if` rather than `&&`, which under `set -e` fails
    # the whole list when its test is false.
    if [ "$HAD_CACHE" = 0 ]; then rm -rf jot/.build; fi
    if [ "$HAD_BUILD" = 0 ]; then rm -rf jot/build; fi
}
trap tidy EXIT

if [ "$BUILD" = 1 ]; then
    node esbuild.mjs --production
    if [ "$FLAVOR" = dev ]; then
        bash jot/scripts/build-app.sh --dev
    else
        bash jot/scripts/build-app.sh
    fi
fi
if [ ! -x "$SRC/Contents/MacOS/$EXEC_NAME" ]; then
    echo "no app at $SRC: run 'pnpm jot:build' first (or pass --build)" >&2
    exit 1
fi

# /Applications is group-writable by admin on a stock macOS, so this needs no
# sudo. When it is not (a managed Mac), ~/Applications is the user's own and
# Launch Services finds an app there just as well.
DEST_DIR=/Applications
if [ ! -w "$DEST_DIR" ]; then
    DEST_DIR="$HOME/Applications"
    mkdir -p "$DEST_DIR"
    echo "note: /Applications is not writable; installing to $DEST_DIR"
fi
DEST="$DEST_DIR/$APP_NAME.app"

WAS_RUNNING=0
if pgrep -x "$EXEC_NAME" >/dev/null 2>&1; then
    WAS_RUNNING=1
    echo "→ asking the running $APP_NAME to quit (it flushes its buffer first)"
    pkill -TERM -x "$EXEC_NAME" || true
    for _ in $(seq 1 100); do
        pgrep -x "$EXEC_NAME" >/dev/null 2>&1 || break
        sleep 0.1
    done
    if pgrep -x "$EXEC_NAME" >/dev/null 2>&1; then
        echo "install-app: $APP_NAME is still running after 10s. Quit it from the menu bar and re-run; nothing was replaced." >&2
        exit 1
    fi
fi

echo "→ installing to $DEST"
# Stage beside the destination, then swap, so an interrupted copy never leaves
# a half-written bundle where a whole app was. `ditto` preserves the ad-hoc
# signature and the bundle's extended attributes; `cp -R` does not reliably.
#
# The old copy is moved aside rather than deleted first, and only removed once
# the new one is in place. Deleting first leaves a window where a failed `mv`
# means no app at all, which is a worse state than either version of it.
# Flavoured, like everything else here. Two sessions installing different
# flavours at once share this directory, and hardcoded names mean one run's
# `rm -rf` destroys the other's staged bundle mid-copy; in the worst
# interleaving the `mv` below moves the OTHER flavour's bundle into this
# destination, which is the user's hotkey, note and settings changing under
# them without a word.
STAGE="$DEST_DIR/.$APP_NAME.app.incoming"
OLD="$DEST_DIR/.$APP_NAME.app.previous"
rm -rf "$STAGE" "$OLD"
ditto "$SRC" "$STAGE"
if [ -d "$DEST" ]; then mv "$DEST" "$OLD"; fi
if ! mv "$STAGE" "$DEST"; then
    echo "install-app: could not move the new app into place." >&2
    if [ -d "$OLD" ]; then
        mv "$OLD" "$DEST"
        echo "install-app: the previous copy is back at $DEST." >&2
    fi
    exit 1
fi
rm -rf "$OLD"

# One copy only, and there are two ways to end up with more than one: a copy in
# the other standard location, and a copy under the name the app used to have.
# Either is a second app for Launch Services to choose between, and the hotkey
# belongs to whichever happens to be running.
#
# Both directories are swept for the old name, not just the one being installed
# into: the rename is what makes the old bundle a stranger, and it can be
# sitting in either place from an earlier install.
#
# Scoped to THIS FLAVOUR, which is the whole point of there being two. The
# sweep used to name the release bundle literally, so a development install
# deleted `~/Applications/Birta Writer Jot.app`: the release copy, removed by
# the flavour that exists so the release is never touched.
#
# The legacy names belong to the release alone. A development build has no
# predecessor, so there is nothing of its own to clean up under an old name,
# and reaching for one would be reaching at somebody else's app again.
OTHER_DIR=/Applications
[ "$DEST_DIR" = /Applications ] && OTHER_DIR="$HOME/Applications"
STALE=("$OTHER_DIR/$APP_NAME.app")
if [ "$FLAVOR" = release ]; then
    STALE+=("$DEST_DIR/Birta Jot.app" "$OTHER_DIR/Birta Jot.app")
fi
for stale in "${STALE[@]}"; do
    if [ -d "$stale" ]; then
        echo "→ removing the other copy at $stale"
        rm -rf "$stale"
    fi
done

if [ "$WAS_RUNNING" = 1 ]; then
    echo "→ relaunching"
    open "$DEST"
    echo "✓ Installed and running. The hotkey works again once the menu-bar mark is back."
else
    echo "✓ Installed to $DEST. It was not running, so nothing was launched: open it from Finder, or run 'open \"$DEST\"'."
fi
