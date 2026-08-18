# Birta Writer Jot

A hotkey-summoned macOS scratchpad running Birta Writer's real editor: full rendering, slash commands, block drag, inline calc, from the first keystroke. It is a menu-bar agent (no Dock icon) that keeps the editor warm in a floating panel and hides it again on demand. The product decisions live on MAR-370; this file is how to build, run and check it.

Jot ships zero behavior the extension lacks. It loads the same `dist/webview.js`, with `webview/ui/hostPalette.css` in place of the palette VS Code injects and a host-capability profile (`shared/hostCapabilities.ts`) that leaves out what only means something inside VS Code: the raw markdown view, the settings UI, proofreading, the read-only toggle, the TOC sidebar. Images are in, because the shell has its own store for them (see "Images" below).

## Build and run

Requires macOS 14 or later and Swift 6 (the Command Line Tools are enough to build; `swift test` needs Xcode for XCTest, and `jot/scripts/test.sh` points at `/Applications/Xcode.app` when it is installed). No Apple developer account: the app is ad-hoc signed, which is fine on machines you own and is not fine to hand to anyone else (see "Other machines" below).

```bash
pnpm jot:build     # production esbuild, swift build, assemble jot/build/Birta Jot.app
pnpm jot:install   # the above, then install to /Applications and relaunch
pnpm jot:run       # build, then open the app out of jot/build
pnpm jot:test      # swift test over jot/Sources/BirtaJotCore
```

`jot/build/` is a build directory: gitignored, and whatever the last checkout produced, so a branch switch quietly changes which Jot the hotkey summons. `/Applications` holds the one copy you actually run, and `pnpm run install:local` puts it there as part of the end-of-work handoff, so it is never a step you take by hand.

Installing leaves the tree as it found it. `jot/.build` (the SwiftPM cache) and `jot/build` (the assembled app) are together a few hundred files and a couple of hundred megabytes, and after the app is in `/Applications` neither is wanted, so `install-app.sh` removes whichever of them that run created. Whichever already existed is kept, so a session already iterating on the shell does not lose its compile cache to someone else's install. `pnpm jot:build` is outside that rule, because producing `jot/build` is the whole point of it.

One consequence to know: `jot/scripts/measure.sh` and `jot/scripts/run.sh` both read `jot/build/Birta Jot.app` and neither builds it, so after an install into a tree that had no build directory they refuse with "build first". Run `pnpm jot:build` before measuring. The alternative was leaving a runnable, branch-shaped app behind in every tree that ever installed, which is the confusion the paragraph above exists to prevent.

Replacing a running copy is the part worth knowing about. `jot/scripts/install-app.sh` sends SIGTERM, which the app turns into its ordinary flush-then-quit, waits for it to go, swaps the bundle and relaunches. It never escalates to SIGKILL: the buffer lives in the web content process until that flush, so a kill to win a race would trade away the bytes the whole persistence design exists to keep. If the app will not quit, the install stops and says so, having replaced nothing.

## Other machines

`bash jot/scripts/update-jot.sh` fetches the app attached to the newest GitHub Release, checks it against the checksum published beside it, and installs it the same way. The nightly `Release` workflow builds and attaches it (`jot-app` in `.github/workflows/release.yml`), so a machine that never builds anything can stay current.

Read the warning at the top of that script before running it anywhere. The app is ad-hoc signed, with no Apple Developer ID behind it and no notarization, so macOS cannot tell you who built it, and the script clears the download quarantine that would otherwise stop it opening. That is a reasonable trade on a machine whose owner also owns the source, and it is not one to ask of anybody else. Notarization is what replaces it, and it needs a paid Apple Developer account; until then Jot is not distributed to other people.

The app appears as a pencil in the menu bar. Clicking it summons or hides the panel; Control-click or right-click opens its menu, which holds the panel toggle, Settings and Quit and nothing about files. Press ⌘⌥⌃J to summon or hide from anywhere; Esc twice hides it (one Esc belongs to the editor: it closes a menu or selects the block). Cmd+F opens find and Cmd+K the link prompt through the Edit menu, since those are VS Code keybindings in the extension. Settings (from the menu, or ⌘,) hold whether Jot opens at login, the hotkey, the scratchpad location, the default save destination, an optional document to edit instead of the scratchpad, and the network opt-in for embeds, link cards and pasted-link titles. See "Network" below for what that switch turns on.

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

## Images

Paste or drop an image and it is saved into an `Attachments` folder beside the document, named by a hash of its own bytes (so pasting the same screenshot twice writes one file), and referenced from the markdown as `Attachments/<name>.png`. The reference is relative on purpose: the note stays portable, and nothing in a file you might share names your home directory.

Save As carries them. The images the note actually references are copied into an `Attachments` folder beside the file you chose, and the references are already correct there, which is why nothing in the document text has to be rewritten. Images the folder holds but the note does not use stay behind, because an attachments folder accumulates everything ever pasted and a note that uses one screenshot should not drag the rest of it along. If a file cannot be copied the save still happens and an alert names what stayed behind, since the text is what you asked to keep.

The page reaches those files through the same `birta://` scheme that serves the app, with the document's own folder as a second resource root (`BirtaJotCore.ResourceRoots`). A document cannot read outside that folder: the request path is refused before it touches the disk if it traverses, and the resolved path is refused if a symlink leads out.

How much that folder holds is the user's choice, and worth knowing when making it. The default scratchpad sits alone under Application Support, so the root is one directory with an `Attachments` folder in it. Point Preferences at a document in a large directory and every file beside it becomes readable by a document that references it, which is the same bargain VS Code's `localResourceRoots` makes for a workspace. It is not a reason to avoid the feature; it is a reason not to point Jot at your home directory.

One thing to know before reading a failure in the paste check. `measure.sh` drives the paste by sending the editing selector to the web view, not by pressing the menu's key equivalent, because an accessory app driven from a shell frequently cannot take activation, and a menu chord with no key window reaches nothing at all. Delivered the other way it failed intermittently and looked exactly like a defect in the editor, which is worth knowing because the symptom points at the wrong layer: ask the app what it saw at the moment of the chord (`NSApp.isActive`, `panel.isKeyWindow`) before believing the editor did anything wrong. What the check therefore covers is the pasteboard, WebKit's own paste handling, the bridge and the store; what it does not cover is the menu binding, which needs a real keyboard.

## Icons

Two, both committed and both regenerated by `bash jot/scripts/make-icons.sh` from the SVGs beside them in `jot/Resources/`. The marks are drawn in a private repository, which stays the source of truth; the copies here are deliberate, so that a build never depends on that checkout and a public clone can still regenerate. Regenerating needs `rsvg-convert` and ImageMagick, the same two the extension's `media/icon.png` is drawn with. No build step needs them: because the outputs are committed, no build machine or CI runner has to have either. Both outputs are byte-reproducible, so a diff on one of them means the artwork changed and never that it was regenerated.

`AppIcon.icns` is the app icon, named by `CFBundleIconFile` in `Info.plist`. macOS does not round an app icon for you, so `make-icons.sh` cuts the artwork to the shape: Apple's grid puts 824 square of art on a 1024 canvas at corner radius 185.4, with the margin the system's own drop shadow is drawn into. The mark is a wordmark, so at the smallest sizes macOS asks for it reads as a coloured tile rather than as words. That is a property of the mark rather than of the export.

`MenuBarTemplate.pdf` is the menu-bar mark. PDF because a status item is drawn at the display's own backing scale, and a template image because macOS renders one from its alpha alone, which is what inverts it for a dark menu bar and for the highlighted state. It is drawn deliberately smaller than the bar's own thickness, which `statusItemImage` in `App.swift` sets: the mark is a filled box reaching its own edges, where the SF Symbols beside it carry their padding inside the glyph, so matching their nominal size would draw a visibly larger neighbour. `swift run` has no bundle to read it out of and falls back to a stock symbol.

## Opening at login

Settings has the switch. The registration is `SMAppService.mainApp`, and there is no stored preference behind it: System Settings edits the same record, so a copy in `UserDefaults` would be a second answer that is wrong whenever the user used the other door. Settings asks the system every time the row is shown, including when the window comes forward.

`BirtaJotCore.LoginItemState` is what the four `SMAppService.Status` values mean, and it is pure so the awkward ones can be tested. The one worth knowing: `requiresApproval` leaves the switch on and says macOS is holding it, because the registration does exist and only the launch is pending, and a switch that snapped back to off would report a refusal that did not happen. A button next to it opens the Login Items pane.

The registration names the bundle it is made from, which is the other reason `/Applications` is the copy to run: a login item pointing into `jot/build` launches whatever a later checkout left there.

## Network

Off by default, and with the switch off the app makes no outbound request of any kind. Turning it on enables three things, all of them rung 1 in [`docs/NETWORK_POSTURE.md`](../docs/NETWORK_POSTURE.md): a URL you typed goes to its own host and nowhere else.

- An embed loads in an iframe the page fetches itself.
- A link alone on its own line can render as a card of the page's own title and description.
- A pasted bare URL offers you the page's title as its link text. It is an offer: nothing reaches the file until you take it, because `pasteUnfurlAutoApply` is left at its default of false.

The shell answers the last two (`resolveLinkCard`, `unfurlUrl`) in `BirtaJotCore.PageMetadataFetcher`, under the same rules the extension applies, and the rules are the interesting part because the input is a URL out of a document: http(s) only, an SSRF guard on the original URL and on every redirect hop, a redirect limit, a byte cap, a deadline, and HTML content types only. Every failure is the same answer, the plain link, because every failure has the same remedy.

The SSRF guard exists twice, once per surface, and the cases live in `shared/__fixtures__/urlGuardCases.json` so both test suites read them. Add a case there rather than in one suite: a rule that only one implementation enforces is then a failing test instead of a difference nobody noticed.

`resolveEmbedMeta`, the caption on a provider embed card, is answered with nothing. It needs the provider recognizer, which lives in `shared/embedProviders.ts`, and a second copy of that table in Swift is the duplication this shell has otherwise been careful to avoid. The card renders; it just has no fetched caption.

## Where the bytes are

One buffer, autosaved to `~/Library/Application Support/Birta Jot/Scratchpad.md` (Preferences can point Jot at another file; the bytes stay with the file they were typed into) on every content update the page reports, atomically (temp file, fsync, rename). Hiding, quitting and Save As first ask the page to flush and wait a bounded second, as the extension's will-save participant does, then write. The file trails the editor by at most one sync-scheduler window (`webview/syncScheduler.ts`) plus one in-flight write.

## Checking it

`bash jot/scripts/measure.sh` runs the built app under `BIRTA_JOT_MEASURE=1`, drives it through that mode's debug signals, and prints the intervals MAR-374 asks about (first mount, warm summon to caret, cold recovery after the WebContent process is killed) plus idle memory, and it checks that inserted text reaches the scratchpad after a hide and survives the kill. A figure it prints is a reading; quote it from an idle machine, never from a document.

Manual checklist, because a window server and a global hotkey are outside what CI can drive: summon from a fullscreen app; type, hide, `cat` the scratchpad; quit mid-typing and relaunch; toggle System Settings > Appearance and watch the panel follow; Cmd+S then Reopen Last Saved; open a menu, press Esc once (menu closes) and twice (panel hides).

The editor itself stays covered by the repo's harness: `node e2e/run.mjs jotHost` mounts the bundle with the Jot profile in Chromium, and `BIRTA_E2E_BROWSER=webkit` runs the same suite in the engine the panel renders in. That WebKit run speaks for rendering and DOM; for typed sequences it does not (Playwright's WebKit key injection puts text after a Return on the previous line, the app's own NSEvent path does not), which is why `measure.sh` types through the panel itself.
