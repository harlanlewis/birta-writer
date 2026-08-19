# Birta Writer Jot

A hotkey-summoned macOS scratchpad running Birta Writer's real editor: full rendering, slash commands, block drag, inline calc, from the first keystroke. It is a menu-bar agent (no Dock icon) that keeps the editor warm in a panel and hides it again on demand. The panel can be told to stay above other applications' windows, and by default does not: a window that will not go behind anything is a window you fight, and the hotkey brings it back in one keystroke. The product decisions live on MAR-370; this file is how to build, run and check it.

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

The app appears in the menu bar as the boxed Birta Writer Jot mark (see "Icons" below). Clicking it summons or hides the panel; Control-click or right-click opens its menu, which holds the panel toggle, Settings and Quit and nothing about files. Press ⌘⌥⌃J to summon or hide from anywhere; Esc twice hides it (one Esc belongs to the editor: it closes a menu or selects the block). Cmd+F opens find and Cmd+K the link prompt through the Edit menu, since those are VS Code keybindings in the extension. Settings (from the menu, the gear in the toolbar, or ⌘,) is three panes in the shape macOS settings windows have, which is what `toolbarStyle = .preference` draws. Its window is titled for the app rather than for the pane, which is the one place it departs from that shape on purpose: a multi-pane settings window names the selected pane, and that assumes the app is named somewhere else on screen, which for an app in the menu bar and not the Dock it is not. Turning Show in Dock on gives it a name there and weakens that argument, without reversing it: the setting is off by default, and a window titled one way with the icon on and another with it off would be worse than either. The toolbar under the title names the pane. General holds login, floating, whether the app appears in the Dock, the summon hotkey, whether launching starts blank, and the network opt-in; Editor holds autosave; Advanced holds the file paths and the agent command. Paths and the command are in Advanced so the two panes anyone opens are short, and a row whose label says what it does carries no caption at all. See "Network" below for what that switch turns on.

## Saving

Jot edits one file. There is nothing to file away and nothing that empties the panel; the window names the file where macOS names a file, in the titlebar beside the traffic lights:

```
◉ ◉ ◉   Scratchpad.md — Edited
```

That is the platform's own treatment rather than one of ours, and the gestures come with it. A click reveals the file in Finder. Cmd-click, Ctrl-click or right-click opens the path popup: the file, then every folder above it up to the volume, each revealing itself. `Edited` appears exactly while the buffer holds bytes the file does not, which with autosave on is a flicker and with autosave off is the answer to "have I saved". No proxy icon, because the panel edits one plain `.md` file and never a package, so the icon would be the same generic mark on every note.

`BirtaJotCore.WindowTitle` holds everything about that decidable without a screen: whether the suffix appears, that its separator travels with it rather than with the name, and where the popup's walk up the folders stops. `BirtaJot.TitleBarView` draws it as a leading titlebar accessory, which is the only way to get a leading title into a panel whose titlebar band is already the page's own toolbar.

Everything the note can DO is in the menu bar, where macOS keeps it: File has New Note, Save, Save a Copy As, Copy Everything, Share and Reveal Last Save in Finder.

- Autosave (Settings, on by default) writes as you type, after a short pause and never later than a ceiling that continuous typing cannot outrun. That ceiling is the whole crash-safety story: it is how far the file is ever allowed to trail the editor.
- Cmd+S writes now. With autosave on it is a flush and an acknowledgement rather than news; it earns its place by being the key everyone presses, and by being the write that happens when autosave is off.
- Cmd+N starts a new note, in the folder the scratchpad lives in, named by the date. No Save sheet, and that is the macOS answer rather than a shortcut past it: the buffer is written before the switch every time, so there is never an unsaved change to ask about. A bound document is left alone, because New Note makes a note in Jot's own folder rather than closing the file you pointed Jot at.
- Shift+Cmd+S writes a COPY somewhere you choose. The panel goes on showing the note, still bound to the same file, which is what every other editor on the machine does.

`JotMenu` is the one table the main menu is built from AND the list declared to the page as `hostShortcuts`, so the keyboard cheatsheet prints what the menu actually binds. Two lists kept by hand would eventually print a key nothing binds, and a cheatsheet that lies is worse than one that omits; the page's own policy is that a printed key cannot be a rebindable default, which is why the extension declares none of these and links to VS Code's Keyboard Shortcuts instead.

`BirtaJotCore.AutosavePolicy` is the one rule and the only pure piece worth having: the setting's scope is the EDIT trigger and nothing else. Hiding the panel and quitting write whatever the setting says, because a preference that stops writing on the way out is one that loses work rather than one anybody asked for. Its tests pin that asymmetry, including the case where the setting must change nothing.

The editing controls are in a dock at the bottom leading corner rather than in the titlebar row, which the window's own chrome now owns. Collapsed it is a serif T, with a chevron on hover pointing the way the click goes; expanded it shows every control that changes the document, in one fixed opinionated order, scrolling sideways when the window is too narrow for it. There is nothing to add, remove or reorder, and the gear offers no Customize Toolbar or Hide Toolbar: two controls and a fixed dock is not an arrangement worth offering to rearrange, and the top bar is the only route to search and settings, so it does not hide. The open or closed choice is remembered, in the view-state bag the panel already carries rather than as a setting anyone has to go and find.

None of that is a fork of the editor. `formattingInBottomDock` and `fixedToolbarLayout` are ARRANGEMENTS in `shared/hostProfile.ts`, declared by this shell and read by `webview/`, and which controls dock is derived from `ITEM_MUTATES` rather than listed: a control docks exactly when it changes the document. The extension could declare the same two tomorrow and get the same panel.

The window itself is quiet until you point at it. While the pointer is elsewhere the panel is the page, the traffic lights, the window's title and the top bar's search and settings; the formatting dock in the bottom leading corner fades in when the pointer arrives and out when it leaves. The shell owns that: `AppearanceObservingView`'s tracking area is the one source of truth, and it tells the page by setting `jot-resting` on the body, which `jot/Resources/index.html` styles. That stylesheet also carves the traffic lights' corner out of the toolbar, takes its bottom hairline off, and turns off elastic overscroll, which would otherwise rubber-band the fixed toolbar away from the top edge. All three are facts about a window rather than about the editor, which is why they are the host page's and not `webview/`'s.

Layout: `Sources/BirtaJotCore` is everything testable without a window (hotkey parsing, the flush/seq guard ported from `shared/saveFlushController.ts`, atomic writes, the autosave rule, the agent request codec, the bridge codec and the boot config); `Sources/BirtaJot` is the AppKit/WebKit app; `Resources/index.html` is the page template, served over the `birta://app/` scheme with the CSP and theme class filled in; `scripts/build-app.sh` assembles the bundle by hand, no Xcode project.

## Asking an agent

`/ai` works here, and Settings holds the command it runs, in the same shape as the extension's `birta.agent.command`: a shell command with `{prompt}` where the quoted request goes. A command tuned for the extension can be pasted in unchanged, because `BirtaJotCore.AgentRequest` is a literal port of the extension's composition and its tests carry the same cases.

Jot writes the note to disk before the run, always, whatever the autosave setting says. That is not about safety here: the agent edits the FILE, so the bytes it opens have to be the bytes on screen and the `path.md#L1` reference has to name something real.

One real difference from the extension, which is why it is written down rather than left to be discovered: there is no merge. The extension folds an agent's edit around whatever you typed while it ran and says so when a hunk overlaps. Jot reloads the file when the run finishes, so an edit made in the panel during a run is the losing side. The merge engine lives in the extension's TypeScript and porting it is its own job.

## Images

Paste or drop an image and it is saved into an `Attachments` folder beside the document, named by a hash of its own bytes (so pasting the same screenshot twice writes one file), and referenced from the markdown as `Attachments/<name>.png`. The reference is relative on purpose: the note stays portable, and nothing in a file you might share names your home directory.

Saving a copy carries them. The images the note actually references are copied into an `Attachments` folder beside the file you chose, and the references are already correct there, which is why nothing in the document text has to be rewritten. Images the folder holds but the note does not use stay behind, because an attachments folder accumulates everything ever pasted and a note that uses one screenshot should not drag the rest of it along. If a file cannot be copied the save still happens and an alert names what stayed behind, since the text is what you asked to keep.

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

One buffer, written to `~/Library/Application Support/Birta Jot/Scratchpad.md` (Settings can point Jot at another file; the bytes stay with the file they were typed into) atomically (temp file, fsync, rename), on the schedule `AutosavePolicy` and the autosave setting decide. Hiding, quitting, Cmd+S, New Note, saving a copy and handing the file to an agent each first ask the page to flush and wait a bounded second, as the extension's will-save participant does, then write immediately, whatever the autosave setting says. With autosave on and none of those happening, the file trails the editor by one sync-scheduler window (`webview/syncScheduler.ts`), plus the autosave hold, plus one in-flight write; the hold has a ceiling that continuous typing cannot outrun, and that ceiling is the bound. With autosave off nothing is written between those moments, which is what the setting means.

## Checking it

`bash jot/scripts/measure.sh` runs the built app under `BIRTA_JOT_MEASURE=1`, drives it through that mode's debug signals, and prints the intervals MAR-374 asks about (first mount, warm summon to caret, cold recovery after the WebContent process is killed) plus idle memory, and it checks that inserted text reaches the scratchpad after a hide and survives the kill. A figure it prints is a reading; quote it from an idle machine, never from a document.

`BIRTA_JOT_OPEN_SETTINGS=general|editor|advanced` opens Settings on a pane at launch, which is how a pane is proven to construct without a person to click it. The same seam as `BIRTA_JOT_SCRATCHPAD` and `BIRTA_JOT_DEFAULTS_SUITE`, and used with them.

Manual checklist, because a window server and a global hotkey are outside what CI can drive: summon from a fullscreen app; type, hide, `cat` the scratchpad; quit mid-typing and relaunch; toggle System Settings > Appearance and watch the panel follow; type and watch the file change with autosave on, then turn it off and confirm Cmd+S and quitting still write; open a menu, press Esc once (menu closes) and twice (panel hides).

The editor itself stays covered by the repo's harness: `node e2e/run.mjs jotHost` mounts the bundle with the Jot profile in Chromium, and `BIRTA_E2E_BROWSER=webkit` runs the same suite in the engine the panel renders in. That WebKit run speaks for rendering and DOM; for typed sequences it does not (Playwright's WebKit key injection puts text after a Return on the previous line, the app's own NSEvent path does not), which is why `measure.sh` types through the panel itself.
