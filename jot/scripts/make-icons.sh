#!/usr/bin/env bash
# Regenerate Jot's two icons from the marks in jot/Resources/.
#
#   bash jot/scripts/make-icons.sh
#
# Outputs, both checked in and both read by build-app.sh:
#
#   jot/Resources/AppIcon.icns          the app icon, every size macOS asks for
#   jot/Resources/MenuBarTemplate.pdf   the menu-bar mark, vector and alpha-only
#
# The marks are drawn in a private repository, which stays the source of truth;
# the SVGs here are deliberate copies, so that packaging never depends on that
# checkout being present and a public clone can still regenerate. A brand
# refresh starts by copying the two SVGs in, then running this.
#
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick). Neither
# is a build dependency: the outputs are committed, so no build machine or CI
# runner ever runs this. That is the same trade media/icon.png makes.
set -euo pipefail

cd "$(dirname "$0")/../.."
RES=jot/Resources
OUT_ICNS="$RES/AppIcon.icns"
OUT_PDF="$RES/MenuBarTemplate.pdf"

for tool in rsvg-convert magick iconutil; do
    command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The app icon. macOS does not round an app icon for you, so the artwork is cut
# to the shape itself: Apple's grid puts 824x824 of art on a 1024 canvas, corner
# radius 185.4, with the 100px margin all round that the system's own drop
# shadow is drawn into. Shipping the flat square instead reads as a tile that
# forgot to be an icon next to everything else in the Dock.
rsvg-convert -w 824 -h 824 "$RES/birta-writer-jot-logo-light.svg" -o "$WORK/art.png"
magick -size 824x824 xc:none -draw 'roundrectangle 0,0 823,823 185.4,185.4' -alpha extract "$WORK/mask.png"
magick "$WORK/art.png" "$WORK/mask.png" -alpha off -compose CopyOpacity -composite "$WORK/rounded.png"
magick "$WORK/rounded.png" -background none -gravity center -extent 1024x1024 "$WORK/icon1024.png"

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
# iconutil takes these names and no others; the @2x of one size and the @1x of
# the next are the same pixels, and both have to be present.
gen() { magick "$WORK/icon1024.png" -resize "${1}x${1}" -filter lanczos "$ICONSET/$2.png"; }
gen 16 icon_16x16
gen 32 'icon_16x16@2x'
gen 32 icon_32x32
gen 64 'icon_32x32@2x'
gen 128 icon_128x128
gen 256 'icon_128x128@2x'
gen 256 icon_256x256
gen 512 'icon_256x256@2x'
gen 512 icon_512x512
gen 1024 'icon_512x512@2x'
iconutil -c icns "$ICONSET" -o "$OUT_ICNS"

# The menu-bar mark. PDF because a status item is drawn at whatever the display's
# backing scale is, and a template image is rendered from its alpha alone, which
# is what lets macOS invert it for a dark menu bar and for the highlighted state.
# 16pt is the drawn size; the vector means the number is a default, not a limit.
#
# SOURCE_DATE_EPOCH is what makes the output reproducible: cairo stamps a
# creation date into the PDF otherwise, so regenerating an unchanged mark
# produced a diff every time and a real change to the artwork was
# indistinguishable from the timestamp moving. The .icns needs no such help.
SOURCE_DATE_EPOCH=0 rsvg-convert -f pdf -w 16 -h 16 "$RES/birta-writer-jot-icon.svg" -o "$OUT_PDF"

echo "wrote $OUT_ICNS and $OUT_PDF"
