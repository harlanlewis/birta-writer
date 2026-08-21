#!/usr/bin/env bash
# Install or update Birta Writer on a Mac that does not build it: fetch the app
# attached to the newest GitHub Release, verify its checksum, and install it.
#
#   bash jot/scripts/update-jot.sh              # newest release
#   bash jot/scripts/update-jot.sh v2026.818.0  # a specific one
#
# On a machine with no checkout, fetch this file, read it, then run it. Piping
# it straight into a shell is deliberately not suggested: the whole subject of
# this script is that Jot's app cannot yet prove who built it, and running an
# unread script from the network is the same trust question one level up.
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

# The trailing `\"` matters: without it, `url_for ''` also matches the leading
# part of the .sha256 asset's URL and returns it truncated at `.zip`. That
# happens to be the right URL, which is worse than a wrong one, because it is
# correct by accident and independent of nothing.
#
# `|| true`, because a release with no app attached is a case this script
# REPORTS rather than dies on: under `pipefail` a grep that matches nothing
# fails the whole assignment, and `set -e` would take the script out before it
# could say which release it looked at.
url_for() { # url_for <suffix>
    printf '%s' "$JSON" \
        | grep -o "https://[^\"]*BirtaJot-[0-9.]*\.zip$1\"" \
        | head -1 \
        | tr -d '"' \
        || true
}
ZIP_URL="$(url_for '')"
SUM_URL="$(url_for '.sha256')"
if [ -z "$ZIP_URL" ]; then
    NAME="$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
    echo "that release (${NAME:-unknown}) has no Birta Writer app attached." >&2
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
    echo "that release published no checksum beside its app, so nothing was installed." >&2
    echo "The checksum is the only thing proving the download arrived whole; an" >&2
    echo "ad-hoc signed app carries nothing else to check. Pass a release that has one." >&2
    exit 1
fi

ditto -x -k "$TMP/jot.zip" "$TMP/unpacked"
APP="$TMP/unpacked/Birta Writer.app"
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
DEST="$DEST_DIR/Birta Writer.app"

WAS_RUNNING=0
if pgrep -x BirtaJot >/dev/null 2>&1; then
    WAS_RUNNING=1
    echo "→ asking the running Birta Writer to quit (it flushes its buffer first)"
    pkill -TERM -x BirtaJot || true
    for _ in $(seq 1 100); do
        pgrep -x BirtaJot >/dev/null 2>&1 || break
        sleep 0.1
    done
    if pgrep -x BirtaJot >/dev/null 2>&1; then
        echo "update-jot: Birta Writer is still running after 10s. Quit it from the menu bar and re-run; nothing was replaced." >&2
        exit 1
    fi
fi

# Old copy aside, new copy in, then remove the old: deleting first leaves a
# window where a failed move means no app at all.
STAGE="$DEST_DIR/.Birta Writer.app.incoming"
OLD="$DEST_DIR/.Birta Writer.app.previous"
rm -rf "$STAGE" "$OLD"
ditto "$APP" "$STAGE"
if [ -d "$DEST" ]; then mv "$DEST" "$OLD"; fi
if ! mv "$STAGE" "$DEST"; then
    echo "update-jot: could not move the new app into place." >&2
    if [ -d "$OLD" ]; then
        mv "$OLD" "$DEST"
        echo "update-jot: the previous copy is back at $DEST." >&2
    fi
    exit 1
fi
rm -rf "$OLD"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null || echo unknown)"
if [ "$WAS_RUNNING" = 1 ]; then
    open "$DEST"
    echo "✓ Birta Writer $VERSION installed and relaunched."
else
    open "$DEST"
    echo "✓ Birta Writer $VERSION installed and started. Press the hotkey (default ⌘⌥⌃J) to summon it."
fi
