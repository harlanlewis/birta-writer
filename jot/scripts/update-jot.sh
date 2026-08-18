#!/usr/bin/env bash
# Install or update Birta Jot on a Mac that does not build it: fetch the app
# attached to the newest GitHub Release, verify its checksum, and install it.
#
#   bash jot/scripts/update-jot.sh              # newest release
#   bash jot/scripts/update-jot.sh v2026.818.0  # a specific one
#
# Or, with no checkout at all, on a fresh machine:
#   curl -fsSL https://raw.githubusercontent.com/harlanlewis/birta-writer/main/jot/scripts/update-jot.sh | bash
#
# READ THIS BEFORE RUNNING IT ELSEWHERE. The app is ad-hoc signed: there is no
# Apple Developer ID behind it and it is not notarized, so macOS cannot tell
# you who built it. This script clears the download quarantine, which is the
# check that would otherwise stop it. That is a reasonable trade on a machine
# whose owner also owns the source; it is not one to ask of anybody else, and
# it is why Jot is not offered to other people yet. Notarization is what
# replaces this, and it needs a paid Apple Developer account.
set -euo pipefail

REPO="${BIRTA_JOT_REPO:-harlanlewis/birta-writer}"
TAG="${1:-}"
if [ -n "$TAG" ]; then
    API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
    API="https://api.github.com/repos/$REPO/releases/latest"
fi

echo "→ asking GitHub for ${TAG:-the newest release}"
JSON="$(curl -fsSL "$API")" || { echo "could not reach $API" >&2; exit 1; }

# `|| true`, because a release with no app attached is a case this script
# REPORTS rather than dies on: under `pipefail` a grep that matches nothing
# fails the whole assignment, and `set -e` would take the script out before it
# could say which release it looked at.
url_for() { # url_for <suffix>
    printf '%s' "$JSON" | grep -o "https://[^\"]*BirtaJot-[0-9.]*\.zip$1" | head -1 || true
}
ZIP_URL="$(url_for '')"
SUM_URL="$(url_for '.sha256')"
if [ -z "$ZIP_URL" ]; then
    NAME="$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
    echo "that release (${NAME:-unknown}) has no Birta Jot app attached." >&2
    echo "Releases before the app was first attached do not carry one; pass a newer tag." >&2
    exit 1
fi

TMP="$(mktemp -d -t jot-update)"
trap 'rm -rf "$TMP"' EXIT
echo "→ downloading $(basename "$ZIP_URL")"
curl -fsSL "$ZIP_URL" -o "$TMP/jot.zip"

# The checksum is published beside the zip by the same job that built it, so it
# proves the download arrived intact. It is NOT a signature and proves nothing
# about who built it: both files come from the same place.
if [ -n "$SUM_URL" ]; then
    curl -fsSL "$SUM_URL" -o "$TMP/jot.zip.sha256"
    EXPECTED="$(cut -d' ' -f1 < "$TMP/jot.zip.sha256")"
    ACTUAL="$(shasum -a 256 "$TMP/jot.zip" | cut -d' ' -f1)"
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "checksum mismatch: expected $EXPECTED, got $ACTUAL. Nothing was installed." >&2
        exit 1
    fi
    echo "→ checksum ok"
else
    echo "note: no checksum published beside this asset; skipping that check"
fi

ditto -x -k "$TMP/jot.zip" "$TMP/unpacked"
APP="$TMP/unpacked/Birta Jot.app"
[ -x "$APP/Contents/MacOS/BirtaJot" ] || { echo "the archive did not contain the app" >&2; exit 1; }

# Clear the download quarantine. See the warning at the top of this file: an
# ad-hoc signature is not one Gatekeeper can attribute to anyone, so without
# this the app refuses to open at all.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

DEST_DIR=/Applications
if [ ! -w "$DEST_DIR" ]; then
    DEST_DIR="$HOME/Applications"
    mkdir -p "$DEST_DIR"
    echo "note: /Applications is not writable; installing to $DEST_DIR"
fi
DEST="$DEST_DIR/Birta Jot.app"

WAS_RUNNING=0
if pgrep -x BirtaJot >/dev/null 2>&1; then
    WAS_RUNNING=1
    echo "→ asking the running Birta Jot to quit (it flushes its buffer first)"
    pkill -TERM -x BirtaJot || true
    for _ in $(seq 1 100); do
        pgrep -x BirtaJot >/dev/null 2>&1 || break
        sleep 0.1
    done
    if pgrep -x BirtaJot >/dev/null 2>&1; then
        echo "update-jot: Birta Jot is still running after 10s. Quit it from the menu bar and re-run; nothing was replaced." >&2
        exit 1
    fi
fi

STAGE="$DEST_DIR/.Birta Jot.app.incoming"
rm -rf "$STAGE"
ditto "$APP" "$STAGE"
rm -rf "$DEST"
mv "$STAGE" "$DEST"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null || echo unknown)"
if [ "$WAS_RUNNING" = 1 ]; then
    open "$DEST"
    echo "✓ Birta Jot $VERSION installed and relaunched."
else
    open "$DEST"
    echo "✓ Birta Jot $VERSION installed and started. Press the hotkey (default ⌘⌥⌃J) to summon it."
fi
