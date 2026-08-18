# Birta Writer Jot

A hotkey-summoned macOS scratchpad running Birta Writer's real editor: full rendering, slash commands, block drag, inline calc, from the first keystroke. It is a menu-bar agent (no Dock icon) that keeps the editor warm in a floating panel and hides it again on demand. The product decisions live on MAR-370; this file is how to build, run and check it.

Jot ships zero behavior the extension lacks. It loads the same `dist/webview.js`, with `webview/ui/hostPalette.css` in place of the palette VS Code injects and a host-capability profile (`shared/hostCapabilities.ts`) that leaves out what only means something inside VS Code: the raw markdown view, the settings UI, proofreading, the read-only toggle, the TOC sidebar, image upload.

## Build and run

Requires macOS 14 or later and Swift 6 (the Command Line Tools are enough to build; `swift test` needs Xcode for XCTest, and `jot/scripts/test.sh` points at `/Applications/Xcode.app` when it is installed). No Apple developer account: the app is ad-hoc signed, which is fine on machines you own and is not fine to hand to anyone else (see "Other machines" below).

```bash
pnpm jot:build     # production esbuild, swift build, assemble jot/build/Birta Jot.app
pnpm jot:install   # the above, then install to /Applications and relaunch
pnpm jot:run       # build, then open the app out of jot/build
pnpm jot:test      # swift test over jot/Sources/BirtaJotCore
```

`jot/build/` is a build directory: gitignored, and whatever the last checkout produced, so a branch switch quietly changes which Jot the hotkey summons. `/Applications` holds the one copy you actually run, and `pnpm run install:local` puts it there as part of the end-of-work handoff, so it is never a step you take by hand.

Replacing a running copy is the part worth knowing about. `jot/scripts/install-app.sh` sends SIGTERM, which the app turns into its ordinary flush-then-quit, waits for it to go, swaps the bundle and relaunches. It never escalates to SIGKILL: the buffer lives in the web content process until that flush, so a kill to win a race would trade away the bytes the whole persistence design exists to keep. If the app will not quit, the install stops and says so, having replaced nothing.

## Other machines

`bash jot/scripts/update-jot.sh` fetches the app attached to the newest GitHub Release, checks it against the checksum published beside it, and installs it the same way. The nightly `Release` workflow builds and attaches it (`jot-app` in `.github/workflows/release.yml`), so a machine that never builds anything can stay current.

Read the warning at the top of that script before running it anywhere. The app is ad-hoc signed, with no Apple Developer ID behind it and no notarization, so macOS cannot tell you who built it, and the script clears the download quarantine that would otherwise stop it opening. That is a reasonable trade on a machine whose owner also owns the source, and it is not one to ask of anybody else. Notarization is what replaces it, and it needs a paid Apple Developer account; until then Jot is not distributed to other people.

The app appears as a pencil in the menu bar. Clicking it summons or hides the panel; Control-click or right-click opens its menu, which holds the panel toggle, Settings and Quit and nothing about files. Press ⌘⌥⌃J to summon or hide from anywhere; Esc twice hides it (one Esc belongs to the editor: it closes a menu or selects the block). Cmd+F opens find and Cmd+K the link prompt through the Edit menu, since those are VS Code keybindings in the extension. Settings (from the menu, or ⌘,) hold the hotkey, the scratchpad location, the default save destination, an optional document to edit instead of the scratchpad, and the network opt-in for embeds; link cards and pasted-link titles are fetched by the host in the extension and Jot does not answer those requests yet, so they stay off.

## The chute

A note in Jot is finished by leaving. The row along the bottom of the panel is the two ways out:

```
[ status                       ] [ Copy and Delete ] [ Save ] [ ··· ]
```

Copy and Delete (⌥⌘C) puts the whole note on the clipboard, empties the buffer and hides the panel, so the paste lands in the app the note was headed for. Save (⌘S) writes it to the destination Settings names, with a file name taken from the first heading or from the date, and empties the buffer the same way. Both leave what they took in one undo slot, which the ··· menu offers back as "Restore Deleted Note" or "Reopen Last Saved" until the next action replaces it.

The ··· menu holds Save As (⇧⌘S), Save to a folder used recently, Copy Everything, Share, Discard, that restore item, Reveal Last Save in Finder, and Settings.

Two rules the code keeps rather than assumes:

- The chute is the SCRATCHPAD. When Settings point Jot at a document instead, no action may empty it: Copy and Delete becomes Copy, Discard is not offered, and Save writes a copy. `BirtaJotCore.ChuteDecision` is that rule, next to `SaveAsDecision`, both pure and both tested.
- A default destination is a place two notes can collide. Save never overwrites: `BirtaJotCore.DestinationName` numbers a name that is taken, because a silent overwrite there destroys a note with no gesture that says so.

The window itself is quiet until you point at it. While the pointer is elsewhere the panel is the page, the traffic lights and the settings gear; the toolbar's other buttons and the action row fade in when the pointer arrives and out when it leaves. The shell owns that: `AppearanceObservingView`'s tracking area is the one source of truth, and it tells the page by setting `jot-resting` on the body, which `jot/Resources/index.html` styles. That stylesheet also carves the traffic lights' corner out of the toolbar and takes its bottom hairline off, both facts about a window rather than about the editor, which is why they are the host page's and not `webview/`'s.

The undo slot is one deep and in memory: a chute that keeps copies on disk of everything it was told to delete is not a chute. What makes the loss survivable is that Copy and Delete puts the note on the clipboard on its way out, and Save writes the file first.

Layout: `Sources/BirtaJotCore` is everything testable without a window (hotkey parsing, the flush/seq guard ported from `shared/saveFlushController.ts`, atomic writes, the bridge codec and the boot config); `Sources/BirtaJot` is the AppKit/WebKit app; `Resources/index.html` is the page template, served over the `birta://app/` scheme with the CSP and theme class filled in; `scripts/build-app.sh` assembles the bundle by hand, no Xcode project.

## Where the bytes are

One buffer, autosaved to `~/Library/Application Support/Birta Jot/Scratchpad.md` (Preferences can point Jot at another file; the bytes stay with the file they were typed into) on every content update the page reports, atomically (temp file, fsync, rename). Hiding, quitting and Save As first ask the page to flush and wait a bounded second, as the extension's will-save participant does, then write. The file trails the editor by at most one sync-scheduler window (`webview/syncScheduler.ts`) plus one in-flight write.

## Checking it

`bash jot/scripts/measure.sh` runs the built app under `BIRTA_JOT_MEASURE=1`, drives it through that mode's debug signals, and prints the intervals MAR-374 asks about (first mount, warm summon to caret, cold recovery after the WebContent process is killed) plus idle memory, and it checks that inserted text reaches the scratchpad after a hide and survives the kill. A figure it prints is a reading; quote it from an idle machine, never from a document.

Manual checklist, because a window server and a global hotkey are outside what CI can drive: summon from a fullscreen app; type, hide, `cat` the scratchpad; quit mid-typing and relaunch; toggle System Settings > Appearance and watch the panel follow; Cmd+S then Reopen Last Saved; open a menu, press Esc once (menu closes) and twice (panel hides).

The editor itself stays covered by the repo's harness: `node e2e/run.mjs jotHost` mounts the bundle with the Jot profile in Chromium, and `BIRTA_E2E_BROWSER=webkit` runs the same suite in the engine the panel renders in. That WebKit run speaks for rendering and DOM; for typed sequences it does not (Playwright's WebKit key injection puts text after a Return on the previous line, the app's own NSEvent path does not), which is why `measure.sh` types through the panel itself.
