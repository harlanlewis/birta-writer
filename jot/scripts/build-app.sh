#!/usr/bin/env bash
# Build "Birta Jot.app" from the SwiftPM package and the webview bundle.
#
#   pnpm jot:build            # production esbuild, then this
#   bash jot/scripts/build-app.sh [--debug] [--out DIR]
#
# Steps: swift build (release unless --debug), assemble the bundle by hand
# (no Xcode project: Info.plist from jot/Resources, the binary, and the web
# assets under Contents/Resources/web/), ad-hoc codesign. No Apple developer
# account is involved; notarization is a distribution step, deferred on
# purpose (MAR-370). Output: jot/build/Birta Jot.app unless --out is given.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO="$PWD"
CONFIG=release
OUT="$REPO/jot/build"
while [ $# -gt 0 ]; do
    case "$1" in
        --debug) CONFIG=debug ;;
        --out) OUT="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

for f in dist/webview.js dist/webview.css dist/hostPalette.css; do
    if [ ! -f "$f" ]; then
        echo "missing $f: run 'node esbuild.mjs --production' (or pnpm build) first" >&2
        exit 1
    fi
done

echo "swift build -c $CONFIG"
swift build -c "$CONFIG" --package-path jot
BIN="$(swift build -c "$CONFIG" --package-path jot --show-bin-path)/BirtaJot"

APP="$OUT/Birta Jot.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/dist"
cp "$BIN" "$APP/Contents/MacOS/BirtaJot"
cp jot/Resources/Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp jot/Resources/index.html "$APP/Contents/Resources/web/index.html"
# The icons: AppIcon.icns is what Info.plist's CFBundleIconFile names, and
# MenuBarTemplate.pdf is what the status item loads. Both are committed rather
# than generated here, so no build machine needs rsvg-convert; regenerate them
# with jot/scripts/make-icons.sh.
cp jot/Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp jot/Resources/MenuBarTemplate.pdf "$APP/Contents/Resources/MenuBarTemplate.pdf"
# The whole webview build: the entry, its stylesheet, the host palette, the
# lazy chunks and every sibling asset they resolve (katex.css, the harper wasm).
cp -R dist/. "$APP/Contents/Resources/web/dist/"
rm -f "$APP/Contents/Resources/web/dist/extension.js" "$APP/Contents/Resources/web/dist/"*.meta.json

codesign --force --deep --sign - "$APP" >/dev/null
echo "built $APP"
