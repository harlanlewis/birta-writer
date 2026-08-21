#!/usr/bin/env bash
# Build "Birta Writer Jot.app" from the SwiftPM package and the webview bundle.
#
#   pnpm jot:build            # production esbuild, then this
#   bash jot/scripts/build-app.sh [--debug] [--dev] [--out DIR]
#
# `--dev` builds the DEVELOPMENT flavour: "Birta Writer Jot [DEV].app", bundle id
# `com.birtalabs.jotdev`. It is meant to sit in /Applications beside the
# release rather than replace it, so a change can be looked at without taking
# away the app somebody keeps their notes in. Everything that would make the
# two collide is separate, and `BirtaJotCore.AppFlavor` is where that list and
# its reasoning live: the id (which names the defaults domain), the note file,
# the summon hotkey, and whether the build may update itself.
#
# Steps: swift build (release unless --debug), assemble the bundle by hand
# (no Xcode project: Info.plist from jot/Resources, the binary, and the web
# assets under Contents/Resources/web/), ad-hoc codesign. No Apple developer
# account is involved; notarization is a distribution step, deferred on
# purpose (MAR-370). Output: jot/build/Birta Writer Jot.app unless --out is given.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO="$PWD"
CONFIG=release
OUT="$REPO/jot/build"
FLAVOR=release
while [ $# -gt 0 ]; do
    case "$1" in
        --debug) CONFIG=debug ;;
        --dev) FLAVOR=dev ;;
        --out) OUT="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

# The two names, in one place. Kept in step with `AppFlavor` by
# `shared/__tests__/appFlavor.test.ts`, which reads both files: Swift cannot be
# imported by a shell script, so the id lives twice and a check holds it.
APP_NAME="Birta Writer Jot"
BUNDLE_ID="com.birtalabs.jot"
EXEC_NAME="BirtaJot"
if [ "$FLAVOR" = dev ]; then
    APP_NAME="Birta Writer Jot [DEV]"
    BUNDLE_ID="com.birtalabs.jotdev"
    # The EXECUTABLE differs too, and it is not cosmetic. `install-app.sh` and
    # anything else that asks a running copy to quit selects it by process
    # name, and two flavours sharing one would mean installing the development
    # build quits the release: the app somebody keeps their notes in, taken
    # away by a build nobody asked to replace it.
    EXEC_NAME="BirtaJotDev"
fi

for f in dist/webview.js dist/webview.css dist/hostPalette.css; do
    if [ ! -f "$f" ]; then
        echo "missing $f: run 'node esbuild.mjs --production' (or pnpm build) first" >&2
        exit 1
    fi
done

echo "swift build -c $CONFIG"
swift build -c "$CONFIG" --package-path jot
BIN="$(swift build -c "$CONFIG" --package-path jot --show-bin-path)/BirtaJot"

APP="$OUT/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/dist"
cp "$BIN" "$APP/Contents/MacOS/$EXEC_NAME"
cp jot/Resources/Info.plist "$APP/Contents/Info.plist"
# The flavour, written into the copy rather than kept as a second plist. One
# source of truth for everything else in there, and the two keys that differ
# are the two the app reads to know which build it is: `CFBundleIdentifier`
# names the defaults domain, and the names are what the Finder and the menu
# bar show. `PlistBuddy` rather than `defaults`, which rewrites the file in its
# own format and would reorder a bundle's plist for no reason.
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $EXEC_NAME" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp jot/Resources/index.html "$APP/Contents/Resources/web/index.html"
# The icons: AppIcon.icns is what Info.plist's CFBundleIconFile names, and
# MenuBarTemplate.pdf is what the status item loads. Both are committed rather
# than generated here, so no build machine needs rsvg-convert; regenerate them
# with jot/scripts/make-icons.sh.
cp jot/Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp jot/Resources/MenuBarTemplate.pdf "$APP/Contents/Resources/MenuBarTemplate.pdf"
# The first-run hero, both appearances. Committed outputs like the two above.
cp jot/Resources/WelcomeHero.png "$APP/Contents/Resources/WelcomeHero.png"
cp jot/Resources/WelcomeHeroDark.png "$APP/Contents/Resources/WelcomeHeroDark.png"
# The whole webview build: the entry, its stylesheet, the host palette, the
# lazy chunks and every sibling asset they resolve (katex.css, the harper wasm).
cp -R dist/. "$APP/Contents/Resources/web/dist/"
rm -f "$APP/Contents/Resources/web/dist/extension.js" "$APP/Contents/Resources/web/dist/"*.meta.json

codesign --force --deep --sign - "$APP" >/dev/null
echo "built $APP ($FLAVOR, $BUNDLE_ID)"
