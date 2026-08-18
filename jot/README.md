# Birta Writer Jot

A hotkey-summoned macOS scratchpad running Birta Writer's real editor: full rendering, slash commands, block drag, inline calc, from the first keystroke. It is a menu-bar agent (no Dock icon) that keeps the editor warm in a floating panel and hides it again on demand. The product decisions live on MAR-370; this file is how to build, run and check it.

Jot ships zero behavior the extension lacks. It loads the same `dist/webview.js`, with `webview/ui/hostPalette.css` in place of the palette VS Code injects and a host-capability profile (`shared/hostCapabilities.ts`) that leaves out what only means something inside VS Code: the raw markdown view, the settings UI, proofreading, the read-only toggle, the TOC sidebar, image upload.

## Build and run

Requires macOS 14 or later and Swift 6 (the Command Line Tools are enough to build; `swift test` needs Xcode for XCTest, and `jot/scripts/test.sh` points at `/Applications/Xcode.app` when it is installed). No Apple developer account: the app is ad-hoc signed, which is fine to run locally and is not fine to hand to anyone else (notarization is a distribution step, deferred on purpose).

```bash
pnpm jot:build     # production esbuild, swift build, assemble jot/build/Birta Jot.app
pnpm jot:run       # build, then open the app
pnpm jot:test      # swift test over jot/Sources/BirtaJotCore
```

The app appears as a pencil in the menu bar. Press ⌘⌥⌃J to summon or hide the panel; Esc twice hides it (one Esc belongs to the editor: it closes a menu or selects the block). Cmd+S is Save As: the buffer goes to a chosen `.md` file and the scratchpad is cleared; "Reopen Last Saved" in the menu brings it back. Preferences (from the menu, or ⌘,) hold the hotkey, the scratchpad location, an optional document to edit instead of the scratchpad, and the network opt-in for link cards and embeds.

Layout: `Sources/BirtaJotCore` is everything testable without a window (hotkey parsing, the flush/seq guard ported from `shared/saveFlushController.ts`, atomic writes, the bridge codec and the boot config); `Sources/BirtaJot` is the AppKit/WebKit app; `Resources/index.html` is the page template, served over the `birta://app/` scheme with the CSP and theme class filled in; `scripts/build-app.sh` assembles the bundle by hand, no Xcode project.

## Where the bytes are

One buffer, autosaved to `~/Library/Application Support/Birta Jot/Scratchpad.md` (Preferences can move it) on every content update the page reports, atomically (temp file, fsync, rename). Hiding, quitting and Save As first ask the page to flush and wait a bounded second, as the extension's will-save participant does, then write. The file trails the editor by at most one sync-scheduler window (`webview/syncScheduler.ts`) plus one in-flight write.

## Checking it

`bash jot/scripts/measure.sh` runs the built app under `BIRTA_JOT_MEASURE=1`, drives it through that mode's debug signals, and prints the intervals MAR-374 asks about (first mount, warm summon to caret, cold recovery after the WebContent process is killed) plus idle memory, and it checks that inserted text reaches the scratchpad after a hide and survives the kill. A figure it prints is a reading; quote it from an idle machine, never from a document.

Manual checklist, because a window server and a global hotkey are outside what CI can drive: summon from a fullscreen app; type, hide, `cat` the scratchpad; quit mid-typing and relaunch; toggle System Settings > Appearance and watch the panel follow; Cmd+S then Reopen Last Saved; open a menu, press Esc once (menu closes) and twice (panel hides).

The editor itself stays covered by the repo's harness: `node e2e/run.mjs jotHost` mounts the bundle with the Jot profile in Chromium, and `BIRTA_E2E_BROWSER=webkit` runs the same suite in the engine the panel renders in. That WebKit run speaks for rendering and DOM; for typed sequences it does not (Playwright's WebKit key injection puts text after a Return on the previous line, the app's own NSEvent path does not), which is why `measure.sh` types through the panel itself.
