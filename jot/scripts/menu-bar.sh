#!/usr/bin/env bash
# The app's REAL menu bar, read back from a running copy: every menu, every
# submenu, the checkmarks, and which rows are dimmed.
#
# The one thing no test in `jot/Tests` can see. A menu bar is drawn by the
# system rather than by the app: the rows macOS adds to a menu titled View
# (Enter Full Screen, and the window-tabbing pair when tabbing is on) and to
# `NSApp.windowsMenu` (Fill, Center, Move & Resize, the window list) arrive out
# of process and are never in the `NSMenu` the app built. A probe that builds
# the bar, activates, opens a menu and re-reads it finds exactly the rows it
# authored, while the accessibility tree of the same process shows the
# system's sitting among them. So `JotMenuTests` asserts the half that is ours
# and this reads the half that is not, and it is also the only place the
# checkmarks `JotMenu.applyState` writes can be seen as a person sees them.
#
# Usage: bash jot/scripts/menu-bar.sh [menu name ...]
#   bash jot/scripts/menu-bar.sh              # every menu but Apple's
#   bash jot/scripts/menu-bar.sh View Window  # just those
#
# It needs Accessibility for whatever runs it (System Settings > Privacy &
# Security > Accessibility), because reading another app's menus is what that
# permission governs. Without it this says so and exits 2, which is NOT a
# failure of the app: a machine that cannot look is a different thing from a
# menu that is wrong, and conflating the two is how a check ends up green on
# every machine that cannot run it.
#
# SIGTERM to end the app, never SIGKILL: WebKit's helpers are not children of
# the app and only exit because the app asks them to, so a hard kill leaves a
# set of them running for hours on a shared machine. ONE `trap ... EXIT`, since
# a second REPLACES the first rather than adding to it.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="jot/build/Birta Writer.app/Contents/MacOS/BirtaJot"
[ -x "$APP" ] || { echo "build first: bash jot/scripts/build-app.sh" >&2; exit 1; }

# A throwaway scratchpad and defaults domain, so a look never touches the note
# somebody keeps or the settings they chose.
WORK="$(mktemp -d -t jot-menubar)"
export BIRTA_JOT_SCRATCHPAD="$WORK/Scratch pad.md"
export BIRTA_JOT_DEFAULTS_SUITE="com.birtalabs.jot.menubar.$$"
LOG="$(mktemp -t jot-menubar-log)"

PID=""
end_app() {
    [ -n "$PID" ] || return 0
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
}
# `defaults delete` empties the domain and `cfprefsd` writes the file back, so
# the plist goes too, BY EXACT NAME: a glob over `com.birtalabs.jot.*` would
# take the user's real settings, since the app's own domain is a prefix of
# every throwaway one.
trap 'end_app; rm -rf "$WORK"; rm -f "$LOG"; defaults delete "$BIRTA_JOT_DEFAULTS_SUITE" >/dev/null 2>&1 || true; rm -f "$HOME/Library/Preferences/$BIRTA_JOT_DEFAULTS_SUITE.plist"' EXIT

# ADDRESS THE PROCESS BY PID, THROUGH THE ACCESSIBILITY API. Never through
# System Events, and never by name. This is the part of this script worth
# reading before writing a UI probe of your own, because what it prevents is
# invisible.
#
# A development machine usually has another copy of this app running: the
# release one, a `[DEV]` build, or both, and all of them share the bundle
# identifier `com.birtalabs.jot`. System Events indexes processes by that
# LaunchServices identity rather than by pid, so it collapses them into ONE
# entry and answers `first process whose unix id is <ours>` with whichever copy
# it registered. It does not error and it does not warn. It returns a menu bar,
# in full, with the right shape, the submenus walked and the checkmarks drawn,
# and every row belongs to a build you did not make. Three runs of this script
# reported a release copy's View menu as the newly built one before that was
# caught, and the only tell was a row whose title had been changed hours
# earlier. Asking the same object for `unix id of proc` answered with the
# stranger's pid, which is the thing to check if this ever reappears.
#
# It is the shape AGENTS.md warns about twice over: a reading that is wrong
# about its own subject, arriving as a clean success. A probe that had been
# written to ASSERT rather than to print would have gone green on a stale
# build, or red on a change it never saw.
#
# Bringing "our" process to the front first makes it worse rather than better,
# which is the trap inside the trap: activation goes through the same
# identifier, so it fronts the other copy and every later read follows it
# there. `AXUIElementCreateApplication` takes a pid and has none of this. The
# accessibility trust it needs is inherited from whatever runs this script.
READER="$WORK/menubar.swift"
cat > "$READER" <<'SWIFT'
import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func title(_ element: AXUIElement) -> String { attribute(element, kAXTitleAttribute) as? String ?? "" }

/// One menu and everything under it. An item with no title is a separator, and
/// the mark character is the checkmark as macOS DREW it rather than as the app
/// asked for it.
func walk(_ menu: AXUIElement, indent: String) {
    for item in children(menu) {
        let name = title(item)
        if name.isEmpty { print(indent + "-----"); continue }
        let mark = attribute(item, kAXMenuItemMarkCharAttribute) as? String ?? ""
        let enabled = attribute(item, kAXEnabledAttribute) as? Bool ?? false
        let key = attribute(item, kAXMenuItemCmdCharAttribute) as? String ?? ""
        var line = indent + (mark.isEmpty ? "" : "[\(mark)] ") + name
        if !enabled { line += "  (dim)" }
        if !key.isEmpty { line += "   \(key)" }
        print(line)
        if let submenu = children(item).first { walk(submenu, indent: indent + "    ") }
    }
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, let pid = Int32(arguments[1]) else {
    FileHandle.standardError.write(Data("usage: menubar <pid> [menu ...]\n".utf8))
    exit(2)
}
let wanted = Set(arguments.dropFirst(2))
guard let barValue = attribute(AXUIElementCreateApplication(pid), kAXMenuBarAttribute),
      CFGetTypeID(barValue) == AXUIElementGetTypeID() else {
    FileHandle.standardError.write(Data("no menu bar for pid \(pid)\n".utf8))
    exit(3)
}
let bar = unsafeBitCast(barValue, to: AXUIElement.self)
let menus = children(bar)
print("menu bar: " + menus.map(title).joined(separator: ", "))
for menu in menus {
    let name = title(menu)
    // The Apple menu is the system's and reads the same in every app.
    if name == "Apple" { continue }
    if !wanted.isEmpty && !wanted.contains(name) { continue }
    print("")
    print("\(name):")
    if let submenu = children(menu).first { walk(submenu, indent: "    ") }
}
SWIFT

if ! swiftc -O "$READER" -o "$WORK/menubar" 2>"$WORK/swiftc.log"; then
    echo "could not build the menu-bar reader:" >&2
    cat "$WORK/swiftc.log" >&2
    exit 1
fi

BIRTA_JOT_MEASURE=1 BIRTA_JOT_SHOW_ON_LAUNCH=1 "$APP" 2>"$LOG" &
PID=$!

n=0
while ! grep -q "^jot-measure ready " "$LOG" 2>/dev/null; do
    sleep 0.2; n=$((n + 1))
    if [ $n -gt 150 ]; then echo "timeout waiting for the app to be ready" >&2; cat "$LOG" >&2; exit 1; fi
done
# The window has to have come forward and the bar to have settled before the
# tree is worth reading.
sleep 2

set +e
OUT="$("$WORK/menubar" "$PID" "$@" 2>&1)"
CODE=$?
set -e
if [ $CODE -eq 3 ]; then
    echo "cannot read the menu bar for pid $PID: whatever is running this is probably" >&2
    echo "  not trusted for Accessibility. System Settings > Privacy & Security >" >&2
    echo "  Accessibility." >&2
    exit 2
fi
[ $CODE -eq 0 ] || { echo "$OUT" >&2; exit $CODE; }
echo "$OUT"
