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

The app appears as a pencil in the menu bar. Press ⌘⌥⌃J to summon or hide the panel; Esc twice hides it (one Esc belongs to the editor: it closes a menu or selects the block). Cmd+S is Save As: the buffer goes to a chosen `.md` file and the scratchpad is cleared; "Reopen Last Saved" in the menu brings it back. When Jot is bound to a document instead (Preferences), Save As writes a copy and leaves the document alone. Cmd+F opens find and Cmd+K the link prompt through the Edit menu, since those are VS Code keybindings in the extension. Preferences (from the menu, or ⌘,) hold the hotkey, the scratchpad location, an optional document to edit instead of the scratchpad, and the network opt-in for embeds; link cards and pasted-link titles are fetched by the host in the extension and Jot does not answer those requests yet, so they stay off.

Layout: `Sources/BirtaJotCore` is everything testable without a window (hotkey parsing, the flush/seq guard ported from `shared/saveFlushController.ts`, atomic writes, the bridge codec and the boot config); `Sources/BirtaJot` is the AppKit/WebKit app; `Resources/index.html` is the page template, served over the `birta://app/` scheme with the CSP and theme class filled in; `scripts/build-app.sh` assembles the bundle by hand, no Xcode project.

## Where the bytes are

One buffer, autosaved to `~/Library/Application Support/Birta Jot/Scratchpad.md` (Preferences can point Jot at another file; the bytes stay with the file they were typed into) on every content update the page reports, atomically (temp file, fsync, rename). Hiding, quitting and Save As first ask the page to flush and wait a bounded second, as the extension's will-save participant does, then write. The file trails the editor by at most one sync-scheduler window (`webview/syncScheduler.ts`) plus one in-flight write.

## Checking it

`bash jot/scripts/measure.sh` runs the built app under `BIRTA_JOT_MEASURE=1`, drives it through that mode's debug signals, and prints the intervals MAR-374 asks about (first mount, warm summon to caret, cold recovery after the WebContent process is killed) plus idle memory, and it checks that inserted text reaches the scratchpad after a hide and survives the kill. A figure it prints is a reading; quote it from an idle machine, never from a document.

Manual checklist, because a window server and a global hotkey are outside what CI can drive: summon from a fullscreen app; type, hide, `cat` the scratchpad; quit mid-typing and relaunch; toggle System Settings > Appearance and watch the panel follow; Cmd+S then Reopen Last Saved; open a menu, press Esc once (menu closes) and twice (panel hides).

The editor itself stays covered by the repo's harness: `node e2e/run.mjs jotHost` mounts the bundle with the Jot profile in Chromium, and `BIRTA_E2E_BROWSER=webkit` runs the same suite in the engine the panel renders in. That WebKit run speaks for rendering and DOM; for typed sequences it does not (Playwright's WebKit key injection puts text after a Return on the previous line, the app's own NSEvent path does not), which is why `measure.sh` types through the panel itself.
