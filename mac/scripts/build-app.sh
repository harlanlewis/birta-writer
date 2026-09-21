#!/usr/bin/env bash
# Build "Birta Writer.app" from the SwiftPM package and the webview bundle.
#
#   pnpm mac:build            # production esbuild, then this
#   bash mac/scripts/build-app.sh [--debug] [--dev] [--out DIR]
#
# `--dev` builds the DEVELOPMENT flavour: "Birta Writer [DEV].app", bundle id
# `com.birtalabs.birta-writer-dev`. It is meant to sit in /Applications beside the
# release rather than replace it, so a change can be looked at without taking
# away the app somebody keeps their notes in. Everything that would make the
# two collide is separate, and `BirtaWriterCore.AppFlavor` is where that list and
# its reasoning live: the id (which names the defaults domain), the note file,
# the summon hotkey, and whether the build may update itself.
#
# Steps: swift build (release unless --debug), assemble the bundle by hand
# (no Xcode project: Info.plist from mac/Resources, the binary, and the web
# assets under Contents/Resources/web/), stamp the version when one is given,
# then sign. Output: mac/build/Birta Writer.app unless --out is given.
#
# Signing is ad-hoc unless BIRTA_CODESIGN_IDENTITY names a real identity, which
# is what the release job sets. Ad-hoc is the right default for a local build:
# it needs no key, no network and no Apple account, and the result runs on the
# machine that built it. A build for anybody else needs a Developer ID identity
# here and notarization after this script (MAR-378).
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO="$PWD"
CONFIG=release
OUT="$REPO/mac/build"
FLAVOR=release
VERSION=""
while [ $# -gt 0 ]; do
    case "$1" in
        --debug) CONFIG=debug ;;
        --dev) FLAVOR=dev ;;
        --out) OUT="$2"; shift ;;
        --version) VERSION="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

# The two names, in one place. Kept in step with `AppFlavor` by
# `shared/__tests__/appFlavor.test.ts`, which reads both files: Swift cannot be
# imported by a shell script, so the id lives twice and a check holds it.
APP_NAME="Birta Writer"
BUNDLE_ID="com.birtalabs.birta-writer"
EXEC_NAME="BirtaWriter"
ICON="AppIcon.icns"
if [ "$FLAVOR" = dev ]; then
    APP_NAME="Birta Writer [DEV]"
    BUNDLE_ID="com.birtalabs.birta-writer-dev"
    # The EXECUTABLE differs too, and it is not cosmetic. `install-app.sh` and
    # anything else that asks a running copy to quit selects it by process
    # name, and two flavours sharing one would mean installing the development
    # build quits the release: the app somebody keeps their notes in, taken
    # away by a build nobody asked to replace it.
    EXEC_NAME="BirtaWriterDev"
    # The dark mark, so the Dock tells the two builds apart at a glance. It
    # is copied in under the release icon's name, below, which keeps
    # `CFBundleIconFile` one value rather than one more key to stamp.
    ICON="AppIconDev.icns"
fi

for f in dist/webview.js dist/webview.css dist/hostPalette.css; do
    if [ ! -f "$f" ]; then
        echo "missing $f: run 'node esbuild.mjs --production' (or pnpm build) first" >&2
        exit 1
    fi
done

echo "swift build -c $CONFIG"
swift build -c "$CONFIG" --package-path mac
SWIFT_BIN="$(swift build -c "$CONFIG" --package-path mac --show-bin-path)"
BIN="$SWIFT_BIN/BirtaWriter"
CLI="$SWIFT_BIN/BirtaWriterCli"

APP="$OUT/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/dist"
cp "$BIN" "$APP/Contents/MacOS/$EXEC_NAME"
# The `bwr` command, which Settings links into a directory on the user's PATH.
# Its name in here is fixed whatever the link is called, because this is a file
# in the bundle rather than a name on PATH; `CommandInstall.executableName` is
# the other end of that. Contents/MacOS rather than Contents/Resources: a
# Mach-O nested under Resources is the arrangement notarization objects to
# (MAR-378). The SAME name in both flavours, since the bundles are what keep
# them apart and the two links differ by their own names.
cp "$CLI" "$APP/Contents/MacOS/bwr"
cp mac/Resources/Info.plist "$APP/Contents/Info.plist"
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
cp mac/Resources/index.html "$APP/Contents/Resources/web/index.html"
# The icons: AppIcon.icns is what Info.plist's CFBundleIconFile names, and
# MenuBarTemplate.pdf is what the status item loads. Both are committed rather
# than generated here, so no build machine needs rsvg-convert; regenerate them
# with mac/scripts/make-icons.sh. The flavour decides which icon, not its name.
cp "mac/Resources/$ICON" "$APP/Contents/Resources/AppIcon.icns"
cp mac/Resources/MenuBarTemplate.pdf "$APP/Contents/Resources/MenuBarTemplate.pdf"
# The first-run hero, both appearances. Committed outputs like the two above.
cp mac/Resources/WelcomeHero.png "$APP/Contents/Resources/WelcomeHero.png"
cp mac/Resources/WelcomeHeroDark.png "$APP/Contents/Resources/WelcomeHeroDark.png"
# The colour themes the app ships with. A launch copies each one into the
# theme library once and never again, so a build that left them out would give
# a fresh install an empty library rather than break; `DefaultThemes.swift`
# declares the four and `DefaultThemesTests` fails when this folder and that
# list disagree in either direction.
# The trailing slash on the SOURCE is what makes this the contents rather than
# the folder: without it a second copy into an existing bundle would nest
# DefaultThemes/DefaultThemes and the app would find no themes at all. Correct
# today only because `rm -rf "$APP"` runs above, and that is too far away to be
# the reason this line is safe.
cp -R mac/Resources/DefaultThemes/ "$APP/Contents/Resources/DefaultThemes"
# The whole webview build: the entry, its stylesheet, the host palette, the
# lazy chunks and every sibling asset they resolve (katex.css, the harper wasm).
cp -R dist/. "$APP/Contents/Resources/web/dist/"
rm -f "$APP/Contents/Resources/web/dist/extension.js" "$APP/Contents/Resources/web/dist/"*.meta.json

# The version, stamped BEFORE signing. Editing Info.plist invalidates whatever
# signature the bundle carries, so the release job used to stamp and then sign
# again; doing it here means one signing path rather than two, and one place
# that has to remember the nested binary below. A build given no --version
# carries whatever mac/Resources/Info.plist says, which is what a local build
# wants: package.json stays 0.0.0 in the tree and the release job is the only
# version authority (docs/RELEASING.md).
if [ -n "$VERSION" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
fi

# Sign, inside out, which for this bundle means TWO binaries and not one. The
# app's own executable sits in Contents/MacOS beside `bwr`, and a nested
# Mach-O has to carry its own signature before the bundle is sealed over it,
# or the notary service refuses the submission. `--deep` used to do this walk
# and is deprecated for signing as of macOS 13: it applies one set of options
# to everything it finds, which is wrong the moment two items want different
# ones, and it only looks in the places it knows about. So the walk is written
# out, and a new binary in this bundle is a line here.
#
# `--options runtime` on both, always, ad-hoc included. The hardened runtime
# is a notarization requirement, and a local build that does not carry it
# cannot tell you the app breaks under it.
#
# `--timestamp` only with a real identity: an ad-hoc signature has no
# certificate for a timestamp to attest to. On a released build it is what
# keeps the signature valid after the signing certificate expires, so an old
# download goes on launching.
#
# `--identifier` on the CLI, because codesign otherwise derives one from the
# filename, and `bwr` names nothing.
IDENTITY="${BIRTA_CODESIGN_IDENTITY:--}"
SIGN=(codesign --force --options runtime --sign "$IDENTITY")
[ "$IDENTITY" = "-" ] || SIGN+=(--timestamp)
"${SIGN[@]}" --identifier "$BUNDLE_ID.bwr" "$APP/Contents/MacOS/bwr"
"${SIGN[@]}" "$APP"

echo "built $APP ($FLAVOR, $BUNDLE_ID${VERSION:+, $VERSION})"
