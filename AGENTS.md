# Agent and contributor instructions for Birta Writer

This is the canonical, tool-agnostic instruction file for the repository, and the one every agent and contributor should actually read. `CLAUDE.md` at the repo root is only a pointer (`@AGENTS.md`) so Claude Code finds its way here.

Everything here is written in English: code, comments, commit messages, docs, test descriptions, and log strings. For user-facing UI text, keep the i18n system intact and treat English as the source language.

## Project basics

- Package manager: `pnpm` only. No npm, no yarn.
- Build: run `pnpm build` after changing code, to confirm it compiles.
- Debug: press F5 for an Extension Development Host (`.vscode/launch.json`).
- Language and tooling: all TypeScript. The extension side uses `tsconfig.json`, the webview side `tsconfig.webview.json`.
- Dual-target build: `dist/extension.js` (Node.js) and `dist/webview.js` (browser), produced by `esbuild.mjs`.
- Syntax level: modern JS and CSS are fine (native CSS nesting, `:has()`, optional chaining, top-level `await`). The only runtimes are Electron (VS Code) and Node 18, and esbuild transpiles to es2020 at build time, so nothing needs down-levelling. Prefer the concise modern form, such as nesting.
- Packaging: `pnpm run package`, which writes the VSIX to `releases/`. It must always go there.
- Local install: `pnpm run install:local` (`scripts/install-local.mjs`) runs the whole handoff below in one command, for both surfaces: the extension into VS Code, and the Mac app into `/Applications` as `Birta Writer [DEV].app`. It never touches your `settings.json`, and the only manual step left is the window reload. The Mac app needs no reload; a running copy of that build is asked to quit, replaced, and relaunched. The DEVELOPMENT flavour, beside the release rather than over it: `Birta Writer [DEV].app` keeps its own settings, its own note and its own summon hotkey, so a change can be reviewed without taking away the copy somebody keeps their notes in. `BirtaWriterCore.AppFlavor` holds what has to stay separate and why. The release copy is deliberately never touched by the handoff; it updates itself, or `mac/scripts/update.sh` installs it by hand.

### Product names

Every surface a user opens is called Birta Writer. That is the display name in the app bundle, the menu bar, the settings window, the Marketplace listing title and any window that names itself, and there is no second user-facing name to choose between.

The surfaces are told apart only where prose has to tell them apart: Birta Writer for Mac, Birta Writer for VS Code. That is a qualifier, not a second product name, and it never reaches a display string. Its one load-bearing use is `mac/CHANGELOG.md`, where the misfiling guard needs a subject it can match.

The Mac app's former name is fully retired, identifiers included: the surface is `mac/` on disk, the modules are `BirtaWriter` and `BirtaWriterCore`, the defaults domain is `com.birtalabs.birta-writer`, the harness variables are `BIRTA_MAC_*`, and the release asset is `BirtaWriter-<version>.zip`. There is no internal codename, on purpose: a codename that is also a retired product name misleads tickets, docs and release assets, and the one thing it bought (a short disambiguator) is what the "for Mac" qualifier is for. `noLegacyBrand.test.ts` bans the old word tree-wide, case-insensitively, with shipped history (the changelogs) as the one exemption.

`MAC_APP_NAME` stays a separate constant from `PRODUCT_NAME` in `shared/product.ts` even though the two hold the same string: one names a program whose spelling reaches the filesystem, the other names the product line, and collapsing them would make any future divergence a rename of paths rather than of a label.

Two identifiers must not drift apart from their readers, and both fail quietly if they do. `com.birtalabs.birta-writer` is the defaults domain, the flavour discriminator `AppFlavor` reads, and the prefix `mac/scripts/reap.sh` scopes itself by; changing it resets every stored setting. `ReleaseFeed.assetPrefix` (`BirtaWriter-`) is how an installed copy recognizes its own update in a release's assets, and a mismatch there returns nil rather than failing, so fixes ship and nobody receives them. Both were changed once, deliberately, when the codename was purged pre-launch: that release orphaned every earlier install (no settings carried over, no self-update offered), which was priced in then and must not be repeated casually now.

### Dependencies

Adding, removing, or bumping a dependency carries two obligations beyond the lockfile.

1. Regenerate the attribution appendix with `pnpm notices`. The script name is `notices`, not `licenses`: `pnpm licenses` is a pnpm builtin, and a script by that name is silently shadowed. We ship a bundle (`vsce package --no-dependencies`), so every dependency is inlined into `dist/` and minification strips the license headers that would otherwise carry its notice. `licenses/THIRD_PARTY_LICENSES.md` is where MIT, ISC, and BSD attribution and Apache-2.0 section 4 are actually discharged. It is generated from the esbuild metafiles (what the bundles inline), not from the dependency tree, so it never claims we ship tree-shaken code. CI's `perf-bundle` job fails if it is stale, and `shared/__tests__/thirdPartyNotices.test.ts` fails if a direct dependency is unattributed or an upstream package changes its license out from under a recorded election. Neither sees code a package embeds under a second license (Graphviz inside an Apache wrapper, the OFL fonts inside MIT KaTeX), so a dependency add or bump also gets `pnpm notices:audit`, which prints candidates by shape for you to judge and record in `EMBEDDED_COMPONENTS`; a run that finds nothing says how many packages it inspected.
2. Keep `@types/vscode` pinned to `engines.vscode`'s floor: the types exactly, the engine as `^`. A caret on the types resolves to the newest 1.x, which lets the compiler bless APIs that do not exist in the oldest VS Code we claim to support. Nothing else checks that compatibility claim.

### Brand assets

`media/` holds the Birta Writer marks. They are drawn in a private repository, which stays the source of truth, and a refresh starts by copying from it. The copies here are deliberate rather than a reference: packaging must not depend on a private checkout being present.

`media/icon.png` is the extension and Marketplace icon, generated from `media/birta-writer-logo-light.svg` at 256 square:

```bash
rsvg-convert -w 256 -h 256 media/birta-writer-logo-light.svg -o /tmp/icon-raw.png
magick /tmp/icon-raw.png -background '#f3efe3' -alpha remove -alpha off -strip PNG24:media/icon.png
```

It has to be a PNG, and so does every image in `README.md`. `vsce` rejects an SVG icon (`SVGs can't be used as icons`) and rejects an SVG image in the readme unless it comes from a host on its own trust list, so pointing either at an SVG fails `pnpm run package` rather than degrading. The flatten is what keeps the tile opaque: the mark's ground is its own paper, not the surface behind it.

Birta Writer for Mac's two icons follow the same rule from `mac/Resources/`: `AppIcon.icns` for the app and `MenuBarTemplate.pdf` for the menu bar, both committed and both regenerated by `bash mac/scripts/make-icons.sh` from the SVG copies beside them. Committing the outputs is what keeps `rsvg-convert` and ImageMagick off every build machine and CI runner. `mac/README.md` has the shape rules that script encodes, including the squircle macOS does not apply for you.

### Git commit convention

Keep the English type prefix (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `release:`) and write the description in English: `feat: add image upload`, `fix: correct table drag offset`.

Cite the Linear issue when a commit closes tracked work. End the commit body with a `Closes MAR-NN` line, one per issue, or `Closes MAR-NN, MAR-MM` for a commit that lands more than one. This is the link that keeps the backlog honest; without it a shipped fix can sit in `In Progress` indefinitely, because nothing points from the code back to the ticket. Never bury a tracked fix inside a large omnibus commit without naming its issue.

## End-of-work handoff (always)

When a session changes `src/`, `webview/`, `shared/`, or `package.json`, finish by making the build testable in the user's own editor with zero extra steps for them. Do this by default, without being asked.

1. `pnpm test`, all green.
2. Update `CHANGELOG.md` if the change is observable by a user: a new capability, a changed or removed behavior or setting, or a user-visible bug fix. Rules below.
3. Review `docs/BENEFITS.md`. Unlike the CHANGELOG, an append-only log, this is a refined document: if the change altered a capability it describes, its fidelity or safety story, or the tool-compatibility table, revise that entry in place rather than appending. Most changes won't touch it. Keep the tone matter-of-fact, stating what the capability is and why it matters, never marketing copy.
4. `pnpm run install:local`, which folds in step 1. It runs `pnpm test`, then `pnpm run package` (writing `releases/birta-writer-0.0.0.vsix`), then installs into VS Code, removes any legacy copy, and verifies exactly one remains. Then it builds the Mac app's DEVELOPMENT flavour from the same `dist/` and installs it to `/Applications`, beside the release rather than over it. If VS Code truly isn't installed it builds and packages, then skips that install with a message rather than failing; the Mac app is skipped the same way off macOS or without Swift. Its install is unconditional on macOS on purpose, because the app runs the same `dist/webview.js` the extension does, so nearly every change reaches it and a rule for when to skip is one more thing to get wrong.
5. End your reply by telling the user to reload: Cmd+Shift+P, then "Developer: Reload Window".

Don't touch `package.json`'s version to mark a build. It stays `0.0.0`, and real CalVer versions are stamped only by the CI `Release` job ([`docs/RELEASING.md`](docs/RELEASING.md)). The window reload is what confirms the new build is live.

### Writing the CHANGELOG entry

There are two changelogs, split by product, and the first question is which file the entry belongs in.

`CHANGELOG.md` is the editor and the extension. It ships inside the VSIX and is what the VS Code Marketplace and Open VSX render on their Changelog tabs.

`mac/CHANGELOG.md` is the Mac app: its panel and window, menu bar, settings, file handling, packaging and install. `.vscodeignore`'s `mac/**` keeps it out of the VSIX, which is the whole point. The app is installable from neither registry, so an app entry on a Marketplace tab reaches a reader who cannot act on it, and spends the attention the actionable entries need.

The test is whose behavior changed, not which names appear. An entry that changes the app and mentions VS Code only to say the extension is unaffected is an app entry. An editor change goes in `CHANGELOG.md` alone, even though the app runs the same `dist/webview.js` and therefore gets it too: the app's file would otherwise be a copy of the whole log. A Mac user reads both, and `mac/CHANGELOG.md` says so at the top.

An entry in `mac/CHANGELOG.md` that names its subject calls it Birta Writer for Mac, and this is load-bearing rather than a style note. Both products are called Birta Writer, so a bare product name no longer says which one an entry is about, and the misfiling guard cannot match one without firing on most of the editor's own entries. The app's former name used to be that disambiguator; the qualifier is what replaced it, and `shared/__tests__/changelogSplit.test.ts` matches the qualifier and the historical spelling together.

Both files are stamped with the same version by the same release job, and a version appears in the app's only when something about the app changed in it. That same guard holds the version headings in step and fails on an app entry written into the extension's file.

Add or amend an entry under `## [Unreleased]`, in the right Keep a Changelog section: `Added`, `Changed`, `Removed`, `Fixed`, plus `Deprecated` and `Security` when they apply.

- Never write a version heading by hand. The nightly `Release` job rolls `[Unreleased]` into one and commits it back (`scripts/stamp-changelog.mjs`, `docs/RELEASING.md`), so `[Unreleased]` holds only what has not shipped.
- Write for a user of the editor: the observable behavior and any `birta.*` setting keys, not the internal plugins or APIs.
- The gate is observability, not effort. A speed-up a user can feel is `Changed`; an invisible refactor, internal perf change, tooling, test, or dependency bump is omitted, because it is in git.
- Observable is necessary and not sufficient. The second question is whether a reader can act on it, or decide whether they were affected, and it is asked of the change before it is asked of the sentences describing it. Cosmetic polish a user could point at but would never look up is below the floor: a hairline removed, a spacing value nudged, an icon's weight changed. The section is scanned, so a line nobody can act on spends a little of the attention the actionable ones need. The near case that does belong is the small visible fix, because it tells someone who hit it to stop working around it. Nothing enforces this one; the four rules `.claude/prose-guard` judges are prose mechanics, and whether an entry earned its place is not among them.
- When a fix is conditional, find the condition and say it out loud, in the ticket and in the entry. Calling a conditional fix "the remaining case" overstates it, and the reader who is still affected stops looking.
- Order entries by significance within a section, and flag a breaking change inline.
- Don't add a Highlights section yourself. The release-notes generator lifts the top items into it (taxonomy in `docs/RELEASING.md`, "What goes in").
- `Security` is direct and accurate: don't inflate, don't deflate. Say what an attacker could and could not do, then stop. A reader scans this section to decide whether to act, so overstating spends their trust on urgency that was not there, and understating costs them a decision they should have made. Check the severity against our code rather than an upstream advisory, which describes the dependency's exposure and not this editor's (2026-08-05: a link-href sanitizer whose "stored XSS" the webview CSP had already made dead was first written up as "could run their script when you clicked"). Where a defence already existed, say so plainly rather than naming the mechanism; the reader wants their exposure, not the architecture.

Do it while the change is fresh. It is the one step you can't reconstruct later.

### Installing by hand

`pnpm build` only rebuilds `dist/`; the user's editor runs an installed copy, so a window reload alone never picks up source changes. `pnpm run install:local` is the path, and `scripts/install-local.mjs` is the reference for the individual steps. Three things it handles that are easy to get wrong by hand:

- Never edit or delete the user's `settings.json` as part of an install. The `--force` install does not touch it, so their `birta.*` config carries across every reinstall.
- Confirm exactly one copy of the editor is installed, `birtalabs.birta-writer`. The check stands on its own: nothing uninstalls an older id first, so two copies over the same `.md` files is a state the verification has to catch rather than one the install has already prevented.
- The `code` CLI is often not on `PATH` on this machine; the script falls back to `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`. If VS Code truly isn't installed, skip and say so rather than failing the handoff.

For iterative debugging, F5 (Extension Development Host) is faster, with no packaging step.

## Key file map

```
src/extension.ts                              Extension entry; registers CustomEditorProvider
src/MarkdownEditorProvider.ts                 Provider core (message routing, webview lifecycle)
shared/saveFlushController.ts                 Save flush/seq protocol (stale guard, injectable timeout); host-agnostic, lives with the shared protocol layer
src/config.ts + shared/config.ts              The birta.* config seam: typed snapshot reads + settings write-back
src/externalChanges.ts                        External-change detection ADR + both mechanisms' constants
src/errorSink.ts                              Extension-side failure sink (console vs deduped notification)
src/searchNavigation.ts                       Catches a search-hit/goto target off the raw tab the WYSIWYG swap is closing
src/webviewMessaging.ts                       Typed extension-to-webview send funnel
src/webviewHtml.ts                            Webview HTML/CSP construction
src/utils/getNonce.ts                         CSP nonce generation
src/utils/imageService.ts                     Local image save (MD5 dedup) + server upload
webview/index.ts                              WebView entry
webview/pm.ts                                 THE ProseMirror import funnel (raw @milkdown/prose surface + getView/getState); guarded by pmFunnel.test.ts
webview/editor.ts                             Editor composition root (chrome plugins + the injected FormatModule)
webview/format/                               FormatModule seam: per-format presets/serialization/NodeViews/diff profile (markdown is format #1)
webview/crashReporter.ts                      Webview crash boundary (posts structured crash messages)
webview/editing/blockOps.ts                   Published block-operations surface for UI components
webview/utils/calc.ts                         Deterministic calc engine (eval-free parser, =/=> detection, block evaluation, refresh scanner); units via the lazy mathjs seam in calcUnits.ts
webview/plugins/calc.ts                       Inline-calc ProseMirror wiring: advisory =/=> suggestions + the auto-insert rule
webview/plugins/calcRefresh.ts                Answer maintenance: refresh, variable cascade, withdrawal (consent model in its header)
webview/blockWidth.ts                         Per-block PRESENTATION preferences (width, code word-wrap, list numbering) + block identity: occurrence-disambiguated content anchors
webview/utils/orderedMarkers.ts               Ordered-list numbering vocabulary + marker spelling; holds the argument for why a style is presentation, never source
webview/plugins/listNumbering.ts              Numbering lifecycle: the `numbering` attr is the live truth, the state bag is the reload mirror
webview/serialization.ts                      Serializer config (stringify options, table handler, pure-markdown preset)
packages/minimal-diff/src/index.ts            Format-agnostic minimal-diff engine (LCS merge + round-trip protection), workspace package
webview/utils/minimalDiff.ts                  Markdown FormatProfile (classifier + normalizers) + profile-bound minimal-diff API
webview/messaging.ts                          WebView/Extension message protocol (the only comms layer)
webview/style.css                             VS Code theming (--vscode-* CSS variables)
webview/ui/chrome.css                         Chrome design tokens (--ui-radius/-space/-fs, card recipe) + the .ui-btn primitive; guarded by chromeTokens.test.ts
webview/i18n/index.ts                         t() / kbd() translation functions
webview/commandChords.ts                      THE resolver every surface asks for a printable chord; the never-guess rule
shared/fixedChords.ts                         The chords the editor binds itself, per command: the only ones printable with no host
webview/ui/fullscreenSurface.ts               THE fullscreen shell (grounds + control geography) every lightbox composes
webview/ui/hoverSelection.ts                  Hover and the arrows share one menu highlight; the guard that stops a still pointer taking it back
webview/ui/icons.ts                           SVG icons
webview/ui/tooltip.ts                         Tooltip component
webview/ui/toast.ts                           THE transient-message surface: one node per surface class, reused; tone and dwell are the caller's
webview/components/toolbar/index.ts           Top main toolbar: composition root over the sibling modules (layout, menus, typography, image panel)
webview/components/toolbar/dock.ts            The formatting row: the second holder for toolbar items, under the formattingInSecondRow arrangement
webview/components/selectionToolbar/index.ts  Floating selection toolbar
webview/components/table/tableView.ts         Table NodeView (overlay chrome: grips, insert bars, drag-reorder)
webview/components/table/reorder.ts           Pure row/column block-reorder + drop-index helpers
webview/components/codeBlock/index.ts         Code block UI
webview/components/toc/index.ts               Table of contents (TOC) panel
webview/components/linkPopup/index.ts         Link hover popup
webview/components/imageView/index.ts         Image NodeView (selection/lightbox/toolbar)
webview/ui/hostPalette.css                    The --vscode-* palette a non-VS-Code host links (the Mac app, the e2e harness); guarded by hostPalette.test.ts
shared/hostProfile.ts                         What the surface IS: the one profile a page declares in window.__i18n.host (capabilities, arrangements, shortcuts) and the only reader of it
mac/                                          Birta Writer for Mac, the menu-bar app (SwiftPM) around dist/webview.js; mac/README.md
mac/Tests/BirtaWriterTests/                      The APP target under test: real windows, laid out and read back, before anything is shown
mac/scripts/reap.sh                           Clears what a run leaves outside every repo: development-build processes and throwaway defaults domains; fired by a SessionEnd hook
mac/scripts/install-app.sh                    Installs the built app to /Applications, replacing a running copy through its own flush-then-quit
mac/scripts/menu-bar.sh                       The app's REAL menu bar, read by pid through the accessibility API; what macOS adds to a menu the app built exists nowhere else, and why System Events cannot be asked
mac/scripts/make-icons.sh                     Regenerates AppIcon.icns and MenuBarTemplate.pdf from the SVGs in mac/Resources; outputs are committed
mac/Sources/BirtaWriterCore/WindowTitle.swift    What a macOS window title says, with no window: whether Edited is drawn at all, and the path popup's walk
mac/Sources/BirtaWriter/AppMenu.swift            THE menu table: every menu built from it, the page's hostShortcuts declared from it, and why the chords are the extension's
mac/Sources/BirtaWriterCore/MenuState.swift      What a menu row draws of the state it toggles, and why an option nobody touched reads as on
mac/Sources/BirtaWriterCore/StyleCategories.swift  The style-check vocabulary ported for the Style Options submenu; guarded against the page's own list
mac/Sources/BirtaWriterCore/AppKitDefaults.swift  The AppKit behaviours turned off before NSApplication exists, and why a menu bar cannot be edited after the fact
mac/Sources/BirtaWriter/TitlebarActions.swift    New Note, Open and Open Recent as titlebar buttons; which SF Symbol each takes, and why the near alternatives are wrong
mac/Sources/BirtaWriter/RecentsMenu.swift        The Open Recent menu, filled by itself rather than by whichever of its two surfaces raised it
mac/Sources/BirtaWriter/SpellService.swift       Spelling and grammar from NSSpellChecker: why it is sliced across run-loop turns, and why requestChecking is not usable
mac/Sources/BirtaWriterCore/ProofreadFilter.swift  Which flagged spans are prose and which are paths or identifiers; a port of shared/proofreadFilter.ts, and why it counts in UTF-16
mac/Sources/BirtaWriterCore/RecentFiles.swift    What the recents list keeps, where the More boundary falls, and when a row says more than a file name
mac/Sources/BirtaWriter/TitleBar.swift           Draws it as a leading titlebar accessory; why the label is sized from what its cell needs and centred on `bounds`, never on what it reports or was built at
mac/Sources/BirtaWriter/TitlebarDrag.swift       Makes the band draggable where the page is not using it; why the CSS answer does not exist in WebKit
mac/Sources/BirtaWriterCore/TitlebarBand.swift   Where that strip starts and stops, how wide the title may be drawn so a strip is still left, and what a double click on a titlebar is the user's setting to decide
mac/Sources/BirtaWriter/TitlePopover.swift       The Name/Tags/Where popover the title opens, and why it is built rather than inherited from NSDocument
mac/Sources/BirtaWriter/MissingFileScreen.swift  What the panel says when the bound file has gone, and the two lanes its card keeps clear so the titlebar can still name its own controls
mac/Sources/BirtaWriter/StatusOverlay.swift      The transient status line: legible with no frame, so the ink is measured and the scrim is the page's own paper colour
mac/Sources/BirtaWriterCore/ActiveBinding.swift  WHICH of the app's three file settings is in force, so a rename writes back to the one it was read from
mac/Sources/BirtaWriterCore/Frontmatter.swift    The metadata block split off the body, host side: a port of shared/contentTransform.ts and shared/lineMap.ts, and why the block the panel holds is mirrored rather than re-read from the buffer
mac/Sources/BirtaWriterCore/DocumentTypes.swift  The file types the Mac app OPENS against the one it WRITES, and why those are two lists; the Open With claim's Swift half
mac/Sources/BirtaWriterCore/DocumentName.swift   What a typed filename means: the extension kept, `/` and `:` refused, an unchanged field not a rename
mac/Sources/BirtaWriterCore/AutosavePolicy.swift  When the app writes, when it does not, and when it asks instead; what the autosave setting promises in both directions
mac/Sources/BirtaWriterCore/DockPresence.swift  What moving Show in Dock has to do, and why turning it OFF is the direction that needs the window put back
mac/Sources/BirtaWriterCore/RowAvailability.swift Whether a settings row can do what it says, and what colour the sentence under it is; the two are independent and both surfaces read them here
mac/Sources/BirtaWriterCore/UnsavedChanges.swift What the quit sheet says when autosave is off and the buffer is ahead of the file
mac/Sources/BirtaWriterCore/AboutInfo.swift      What the About window says, and THE repository string its two GitHub links and the updater's release feed all derive from
mac/Sources/BirtaWriterCore/SystemRequirements.swift  Which Macs a build of the app runs on, decided off the bundle rather than off a floor written here; the two update paths' preflight
mac/Sources/BirtaWriterCore/AgentRequest.swift   /ai command composition, a literal port of src/agentBridge/askAgent.ts; same test cases both sides
mac/Sources/BirtaWriterCore/AgentReference.swift What Copy Reference puts on the clipboard, a port of src/agentBridge/format.ts; mirrored test cases, and its header names the two places the two deliberately differ
mac/scripts/update.sh                     The other-machine path: fetch the app off the newest GitHub Release, verify, install (ad-hoc signed, so it clears quarantine)
e2e/enterCaret/                               Return must leave the caret in the block it just made; the WebKit-only class of defect that gate exists for
```

## Architecture constraints

- WebView and Extension communication goes only through the wrappers in `webview/messaging.ts`.
- The webview side never `import`s the VS Code API directly. It gets a handle via `acquireVsCodeApi()`.
- Don't keep global state outside modules. Singletons like the editor view are the exception.
- UI and UX principles live in `docs/DESIGN_PRINCIPLES.md`: decoration semantics (strikethrough means "delete this", dotted underline means "reconsider", color means source), the "annotation is advisory, reversible, and quiet" rules, and gutter and theming conventions. Check a new affordance against it before adding a visual channel.

### Color and theming

CSS must use `--vscode-*` variables so light and dark themes both work. No custom colors, guarded by `noColorLiterals.test.ts`. Accents (selection, focus, drag chrome) use `var(--vscode-focusBorder)` with no literal fallback, because inside VS Code the variable always exists: pinned and custom themes only override the native set, never remove it. Never give a `--vscode-*` variable a literal fallback. The last of them were removed in MAR-54, so the only ones left in the tree are fixtures inside `noColorLiterals.test.ts`.

Outside VS Code the palette is `webview/ui/hostPalette.css`, emitted as its own asset (`dist/hostPalette.css`) and never imported by the bundle. `hostPalette.test.ts` fails when a `--vscode-*` variable is referenced anywhere in `webview/` and not defined there, so a new variable is a two-file change. The chrome guards skip that file by name; a new sweep over every `.css` under `webview/` needs the same line.

### Hosts other than VS Code

The webview has one entry and one composition root. A host that is not VS Code (the Mac app, the e2e harness) is a page that stubs `acquireVsCodeApi`, sets `window.__i18n`, answers `ready` with `init`, and links the host palette. What differs per host is declared, not forked, and `shared/hostProfile.ts` is where a host declares it: ONE key, `window.__i18n.host`, holding three kinds of fact. Absent means the VS Code profile, so the extension page and every existing harness page are unchanged.

Four rules hold this together, and a new difference between surfaces should reach for them in this order rather than adding a fifth mechanism.

- **One declaration, one reader.** A host fact goes in the profile, never as a bare field beside the thirty-odd `birta.*` settings that share that blob. Consumers ask `hostHas`, `hostArranges`, `hostHasCommand` or `hostShortcuts`; nothing else reads the declaration, so the absent-means-VS-Code rule has one home and no call site re-derives it. Two call sites once derived the same layout flag independently, one of them through a raw `globalThis` cast, which is what that rule exists to stop.
- **A capability names what the HOST provides, never what the editor does.** A text editor to switch to, a settings window, an agent, an image store. An editor feature is gated by its own `birta.*` setting. Get this wrong and the profile becomes a feature-flag list, which is the thing it is not.
- **A layout difference is an ARRANGEMENT, not a capability.** Where two surfaces want the same controls in different places, both can do it and only one prefers to; gating that on a capability claims a host cannot do something it can. Arrangements are named in the profile and read with `hostArranges`.
- **Gate by declaring what a thing NEEDS, then filter once.** A list of items each carrying an optional `needs: HostCapability`, filtered in one place, beats a ternary at each site: a new gated item adds a field and no new branch. `webview/components/toolbar/typography.ts` is the worked example, for both its font choices and its row groups.
- An arrangement can WITHDRAW a command, and it goes through the same predicate. A capability says the host cannot answer; an arrangement says the surface has settled the question the command exists to reopen (Customize Toolbar where the layout is not the user's). Both are declared on the command's own metadata, `hostCapability` and `absentUnder`, and both are read by `hostHasCommand`, so the gear row, the slash row, the palette and `runEditorCommand` withdraw it together and no surface gains a branch. A command may carry both, and `swapTocSide` is the one that needs to: there is no side to swap without a sidebar, and nothing to ask on a surface that fixes the side. They are read capability first, then arrangement, so "why is this absent" is answered by whichever fires first. What is refused is a pair that cannot be told apart, an arrangement declared only by hosts that also lack the capability, where it would withdraw nothing the capability had not already withdrawn; `hostProfile.test.ts` asks each gate with the other satisfied.

Two declarers restate the profile by hand, because neither Swift nor an HTML bootstrap can import TypeScript: the e2e mac page, and the app's Swift, which is split across two files (capabilities in `Prefs.bootConfig`, arrangements and shortcuts in `Bridge.i18nObject`, which is what assembles the one key). `src/webviewHtml.ts` is not one of them; it imports `HOST_PROFILES.vscode`, and only its empty `arrangements` and `shortcuts` are literals. `shared/__tests__/hostProfile.test.ts` reads all three files and fails when they disagree. Gathering the facts under one key is what makes that guard writable once instead of once per field: arrangements and shortcuts were added as separate bare fields and had NO guard, so Swift could have stopped declaring either and every test would still have passed. The Mac app ships zero behavior the extension lacks; anything it needs lands in `webview/` first and both surfaces get it. VS Code is Chromium and the Mac app is WebKit, so a rendering change that matters to the panel gets a `BIRTA_E2E_BROWSER=webkit` run, and so does anything that edits the document from the keyboard. A WebKit red is a claim about the product until the panel says otherwise, and the way to ask the panel is `bash mac/scripts/measure.sh`, whose typing check drives real keystrokes through the app's own NSEvent path. Both instruments agreeing is the answer; disagreement is the only thing that makes the engine's key delivery worth suspecting.

The class of defect this exists for: in an empty textblock, where widget decorations are the only things present, WebKit cannot hold an insertion point in front of a `contenteditable=false` widget that has no content before it. It re-anchors the caret to the end of the previous block, so the next character typed lands on the previous line. One such widget is enough, and Chromium tolerates the arrangement. Every widget decoration at a block's first inline position therefore takes a negative `side`, so it sorts before the caret rather than after it; `plugins/emptyLineHint.ts` and `plugins/headingFold/foldDecorations.ts` are the two that sit there, and `e2e/enterCaret` pins the gesture in both engines.

### Chrome skin

Chrome composes `webview/ui/chrome.css` instead of re-authoring anatomy. Corner radii come from the `--ui-radius-*` scale, chrome text sizes from `--ui-fs-*`, floating menus and popups from the `--ui-card-*` recipe. New buttons compose the `.ui-btn` primitive (`class="ui-btn ui-btn--icon my-btn"`; filled CTAs use `--primary` or `--secondary`). Menu rows and group headers compose `.ui-menu-row` and `.ui-heading ui-menu-heading`, with containers retheming rows via `--ui-menu-ink` and `--ui-menu-hover-bg`. Advisory popup pills compose `.ui-notice`.

Two invariants:

- `chrome.css` must stay the FIRST stylesheet reached in the webview entry's import graph, which is not the same as first among `index.ts`'s own import lines: `import "./perfBoot"` sits above it and must stay there. Primitives and surface classes tie on specificity, so bundle order decides who wins. Guarded by `cssImportOrder.test.ts`, which walks the eager graph in evaluation order.
- The old surface classes (`.tb-btn`, `.sel-tb-btn`, `.tb-fmt-item`, `.fm-suggest-item`, and the rest) are shells that are BROKEN without their primitive class. Every creation site must compose both.

Gotcha: a composed button that keeps a visible resting border must restate `border-color` in its own `:hover`, because the primitive's hover border is the usually-transparent `toolbar-hoverOutline`.

The `hidden` attribute is honoured once, globally, by `[hidden] { display: none !important }` at the top of `chrome.css`. Never restate it per element. `[hidden] { display: none }` is a UA rule, so any author-level `display` beats it and a node set `hidden` in JavaScript goes on drawing and goes on taking its width, which surfaces as whatever downstream measurement counted it rather than as a visible leftover. Ten elements carried their own restatement before the rule landed, and the tenth was found by a tab strip measuring four tabs in a row that was showing two. The one thing the global rule forecloses is `hidden="until-found"`, which needs the element laid out; nothing uses that value, and anything that wants it needs its own rule and a note saying why.

`chromeTokens.test.ts` fails the suite on a new raw radius or a sub-14px font literal. It and `noColorLiterals.test.ts` both read CSS wherever it is authored: `.css` files, stylesheets parked in a `.ts` template literal (`findBar/highlightStyles.ts` is one of several; `webview/__tests__/cssParses.test.ts` enumerates them), and inline style writes (`el.style.borderRadius = "7px"`, `style.cssText`, `style.setProperty`). `webview/__tests__/helpers/cssSources.ts` documents what is extracted and what deliberately is not.

Document content is a separate system (em-based, `--content-*`). Don't mix the two.

## Launch performance

Perceived performance is a first-class product goal beside data fidelity, and always was: opening, writing, and every operation the user waits on, at any document size within reason. Webview cold start (open a `.md`, editor painted) is where it is measured most closely, and it is also the cost of switching back from the raw editor, since VS Code disposes the webview on switch-away. The goal does not reorder the phase spine. Fidelity is phase 0 and wins a direct conflict, because a fast editor that loses a byte is worse than a slow one that does not. What the goal changes is the verdict on a cost the user can feel at the size where it shows: that is a defect to fix, never a property of large documents to be accepted.

Size-independence is the test to hold a change to. No pass on the user's path may be proportional to the document when it could be proportional to the viewport or to the edit, and what can be neither belongs on another thread. Whether the keystroke itself meets that bar is read from `pnpm perf:typing huge-outline`, and the work that runs between keystrokes on a timer (the sync pipeline's whole-document serialize, merge and verification reparse, and the decoration passes) shows up in the same report's `block` column; `pnpm perf huge-outline` reads the open-time half.

### Keeping it fast

- Keep the launch bundle lean. Anything not needed for first paint loads lazily, the moment the document actually needs it. Mirror `webview/utils/katexLoader.ts` and `mermaidLoader.ts` (cached dynamic `import()`) and the lazy grammar chunk in `webview/highlighterLanguages.ts`. Don't add a static `import` of a heavy dependency to the eager graph.
- Decoration never imposes on the interaction thread, and proofreading is a decoration. Keep it off the mount path: it must never block the editor becoming interactive, it settles in after first paint (`requestIdleCallback`), never synchronously during create and never as a reaction to the user's first touch. Off the mount path is necessary and not sufficient, because a whole-document pass deferred past paint still lands on the frames the user is already typing into. So a decoration's work is proportional to the viewport, not the document: it materializes for the blocks near the screen and follows the scroll, while document-wide STATE (a fold, a setting) stays document-wide even though its chrome does not. The fold gutter is the worked example (MAR-215), and `e2e/gutterWindow` holds the invariants that make windowing safe, chief among them that adding or removing chrome never moves content. A decoration that walks every block is a defect to fix rather than a cost to schedule, and one that hands the whole document to the host is the same defect crossing a boundary. A feature the user has disabled must cost nothing: no scan, no lazy dependency loaded.
- Resolve bundled sibling assets against the entry `<script>`, not `import.meta.url`. esbuild chunk splitting shifts modules between `dist/` and `dist/chunks/`, which silently breaks relative URLs (see `katexCssHref` in `katexLoader.ts`).
- Inject `::highlight()` rules on first use, never eagerly. Blink resolves a style for every registered custom-highlight name while resolving every element's style, so a rule in the eagerly-loaded stylesheet costs launch time even when nothing is highlighted and no JavaScript runs. The cost lands in `create` and `paint`, and scales with document size: one four-line rule cost the `large` fixture 3.4%, and moving the find bar's three rules out of `findBar.css` into an injected `<style>` took 10.8% back off it. `webview/components/findBar/highlightStyles.ts` is the worked example and holds the full provenance. Prefer an inline `<style>` over a lazily-linked stylesheet, which loads asynchronously and would paint the first matches unstyled.

### Measuring

Measure before and after; don't guess. The harness (`e2e/perf/`, see its README) drives the real production bundle in headless Chromium and reads the `mdw:` User-Timing marks (`webview/perf.ts`).

- `pnpm perf` reports median launch spans per fixture. Build first with `node esbuild.mjs --production --metafile`. Pass a fixture name to measure one.
- The default sweep stops at `large`, 96 KB. Two heavy fixtures sit outside it and are reachable by name from either runner: `xlarge` (~300 KB) and `huge-outline` (~765 KB, a deep outline over unwrapped prose with no tables, code or images). Neither is in `FIXTURES`, so neither is ever gated or measured by `pnpm perf`, because `launch-perf` blocks every PR and measures every default fixture on both sides; `xlarge` is still swept by `pnpm perf:typing` as it always was. Reach for one when a cost is suspected of scaling with document size, which is the class of defect the gated fixtures are too small to make legible.
- `pnpm perf:bundle` is the zero-variance eager-bytes metric: a cheap, browser-free backstop that catches bytes added without asking, such as an accidental heavy static import. It gates on a budget ceiling (`--check`, the `eagerBudget` key in `e2e/perf/bundle-baseline.json`), not a ratchet. Raise the ceiling deliberately with `--set-budget`.
- Removing eager bytes produces no CI signal on its own, because the budget is a ceiling: `--check` simply passes with more room, and the space is immediately re-spendable. Finish a bytes win with `--set-budget` so the ratchet sticks.
- The launch A/B is same-session (`pnpm perf --compare before.json after.json`), with a warmup run discarded. Absolute ms drift on a laptop, so a `before.json` captured earlier is untrustworthy: stash the change, rebuild, capture `before`, restore, capture `after`. Treat a delta under about 3%, the noise floor, as neutral.
- A stored number is a record, not a reading. Re-measure before quoting one. `bundle-baseline.json` holds the ceiling and nothing else, and `e2e/perf/bundleBaseline.test.mjs` fails if a measured figure creeps back in. The same trap applies to `e2e/perf/baseline.json` and to any figure pasted into a ticket or a doc.
- A test runner's own report can lie about cost. Vitest's JSON `endTime - startTime` includes the time a file sat queued behind others, so a file can read as the expensive one and cost a fraction of that when run alone. Measure a file in isolation before calling it expensive, and before thinning a gate on the strength of it.
- The `paint` span (`create-end` to `editor-painted`) is the initial view render: ProseMirror's first DOM build, style, layout and paint, plus any work a plugin schedules from its `view()` onto the frames before that paint. If a plugin schedules its own rAF at mount, suspect this span. Work moved in front of first paint is invisible to every other one.

### CI perf gates

`launch-perf` (`pnpm perf:ab`, `e2e/perf-ab.mjs`) is required and blocking on every PR. It builds the merge-base and head, measures both back to back on one runner, and gates on the launch delta, catching time added without bytes that the eager-bytes backstop cannot see. It gates only the `medium`, `large`, and `realistic` fixtures (`realistic` is the mixed-construct real-document shape: wide tables, mermaid, unwrapped paragraphs), and double-confirms a regression across two passes before failing.

`typing-perf` (`.github/workflows/typing-perf.yml`, `pnpm perf:typing:ab`) gates per-keystroke dispatch the same way: same orchestrator, same merge-base interleave, same double-confirm. It fails the `xlarge` dispatch median at 10% or worse AND at least 0.5 ms. Launch is what a user pays once; dispatch is what they pay thousands of times on a large document (MAR-224).

An intentional cost merges through either gate via the `perf-accept` PR label or a `Perf-Regression-Accepted: <reason>` commit trailer.

A gate whose statistic has a sample count that depends on machine load defeats its own double-confirm, because both passes draw on that same load-dependent quantity. Gate on a median under a minimum-sample floor, the way the caret gate does, rather than on a per-burst sum.

Three things about `typing-perf` are deliberate and easy to get wrong:

- It runs only on PRs touching `webview/`, `packages/`, or the perf harness, behind a `paths` filter, and it is not a required check. It is the most expensive check in the repo and most PRs cannot move per-keystroke dispatch, so paying minutes on every one of those compounds badly across a day of small PRs. A required check that a `paths` filter skips would leave those PRs waiting forever, hence advisory.
- `block` (total longtask ms) is reported, never gated. Its threshold is a fixed 50 ms, so a slower machine pushes sub-threshold tasks over it and the number inflates super-linearly. A null A/B on identical bundles moves it while dispatch medians hold, and the same burst reads more than an order of magnitude higher on a CI runner than on a laptop.
- Size it from a completed CI job, never from local timings; the runner is roughly twice as slow per keystroke. The cost is dominated by the largest fixture itself (mount plus burst), not by how many fixtures are in the list, so dropping a smaller one buys little. Cut keystrokes or pairs.

## Prose and comments

A comment states the current contract and the constraint that must hold, not the history. A sentence in the past tense belongs in git: "strictly read then write, and it must stay that way" is a constraint, "it used to interleave them" is a changelog in the wrong file. A ticket id at the end of a line is a pointer and is useful; a paragraph about what that ticket found is not.

Never put a measured figure in a comment or a doc. A bare number reads exactly like a checked one, which is how a stale figure gets quoted forward in good faith, and the same rule already governs `bundle-baseline.json` and `baseline.json` above. Three ways out, in order: name the command (`pnpm perf large` never rots), assert the figure in a test where it cannot drift silently, or state the mechanism the code already shows. "It walks the whole document per keystroke" needs no measurement. When a figure goes, the claim goes with it: swapping it for a vague magnitude keeps the claim and destroys the only thing that made it checkable.

`.claude/prose-guard` opts this repository into the mechanical layer, and it judges EVERY line of prose rather than only list items. Scope is by convention so a new document is covered the day it lands: `CHANGELOG.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`, and anything under `docs/` or `.claude/`. That file is the live switch, and `rm` on it retires the guard everywhere. Before deleting a marker, confirm which one the installed hook actually reads, by tripping the guard and reading the deny, which names the marker it read. A marker the installed plugin does not look for is a guard that is off with nothing to say so, and a merged rename is not an installed one.

Four rules, each with the scope it earns. No em dash, anywhere; there is always a plain substitute. No bold, except in a table row (a first column is structure) or a thematic break (`***` is a rule, not emphasis). No italic in `CHANGELOG.md`, where an entry is scanned and emphasis is decoration; italic stands elsewhere, because in durable prose it marks a contrast that plain text loses. No absolute claim about a performance cost unless the line carries a before and an after.

The guard applies an edit to the file in memory before judging, so it can tell a paragraph from the inside of a code fence. Fenced and indented code, inline code spans, and escaped asterisks are never judged, and a dunder path such as `webview/__tests__/setup.ts` is an identifier rather than bold.

Three things are deliberately outside it and must stay outside. `webview/__tests__/fixtures/**` and `samples/**` are content under test: `e2e/corpus` walks both and parses every `.md` it finds, so a file there exists to carry the syntax the rules ban. `licenses/THIRD_PARTY_LICENSES.md` and `THIRD_PARTY_NOTICES.md` are generated. Everything about comments is judgement and is not automated; see the plugin's `writing-technical-prose` skill for the genre rules.

## Issue tracking

All bugs and planned work live in Linear, team "Birta Writer", `MAR-` prefix. Never GitHub Issues, and never local files. The `MAR-` prefix predates the rebrand and is unchanged. The team name is what the Linear tools take, and querying a wrong one returns an empty list that reads exactly like an empty queue.

- Known bug: `#Bug` label, only for issues still unfixed after development.
- Feature request: `#Improvement` label. Record maturity, implementation approach, and affected files.
- File, close, update, and audit through the `/devlog` skill (`.claude/skills/devlog/SKILL.md`). Triggers: "record a bug", "record a feature request", "close an issue", "audit the backlog", `/devlog`.

### Lifecycle

Keeping the backlog honest matters as much as filing it. Close the loop when work ships.

- When a commit ships tracked work, move its issue to `Done` with a comment citing the SHA, and put `Closes MAR-NN` in the commit body. The link has to exist in both directions.
- Before closing, verify against the code, not the CHANGELOG. A feature can ship with a different implementation than the ticket described.
- Audit for silently-shipped work when reviewing the backlog or picking up an `In Progress` issue. Read recent omnibus commits' diffs, not their subjects. A tracked fix buried in an unrelated commit is the classic way work gets done but never closed.
- A ticket's reproduction and its stated cause are separate reliabilities. The reproduction survives being quoted; the cause filed beside it often does not, and work built on a false cause looks correct and passes its own tests. Re-derive the cause before building on it.
- When you close a ticket, grep the tree for its id: a carve-out or a scoping comment naming it has just started lying. Cite code by symbol rather than by line number, which drifts out from under a ticket that sits for a while.
- The CHANGELOG and Linear are complementary. The CHANGELOG records what shipped, including untracked work; Linear tracks planned work and bugs. "Not in Linear" never means "not shipped".

### Sequencing

The `phase-*` labels are the roadmap spine, in order: `phase-0-fidelity` (round-trip trust, existential, comes first), `phase-1-performance` (speed the user can feel, reusing the slot vacated by the retired `phase-1-vscode-parity`, which shipped in 0.2.3), `phase-2-syntax`, `phase-3-interaction`, `phase-4-differentiators`. Within a phase, order by `priority`, and pick the first High or Urgent down the spine.

`phase-5-surfaces` does not rank. It is exploration, not queued work, so the "first High-or-Urgent down the spine" rule skips it, and a High there never outranks a phase-0 bug. Promoting it is a roadmap change the owner makes explicitly (decision D8).

Where `docs/WHY_THIS_FORK.md` disagrees with the `phase-*` labels, the labels win. Its 1 to 4 list is the founding rationale, not the live spine.

### Strategy documents

Strategy and exploration live in a private repository, never in `docs/`: surfaces, engine ownership, AI posture, publishing, positioning, brand. None of it is measured or committed scope, so quote fragments of it as arguments rather than findings.

The exception is [`NETWORK_POSTURE.md`](docs/NETWORK_POSTURE.md), which records shipped network behavior and the consent ladder. Read it before touching anything that makes an outbound request.

## Testing

### Stack

| Layer | Framework | Scope |
|-------|-----------|-------|
| Extension unit tests | Vitest 4.x (Node env) | `src/utils/`, `src/MarkdownEditorProvider.ts` |
| WebView unit tests | Vitest 4.x + jsdom 24.x | `webview/utils/`, `webview/messaging.ts` |
| Integration tests | @vscode/test-electron + Mocha | `src/test/`, in a real Extension Host: activation, `onWillSaveTextDocument` and `waitUntil` reaching disk, the custom-editor save cycle with a live webview |
| Mac shell tests | XCTest + SwiftPM | `mac/Tests/BirtaWriterCoreTests` over the host-free half, `mac/Tests/BirtaWriterTests` over the app: real AppKit windows, laid out and read back before anything is shown. Run by `bash mac/scripts/test.sh`, not by `pnpm test` |

The `vscode` module is mocked centrally via `__mocks__/vscode.ts`, injected by `resolve.alias` in `vitest.config.ts`. Do not `vi.mock("vscode")` in individual test files.

Integration versus unit boundary. Unit tests mock `vscode` and cover the flush protocol logic (seq ordering, stale rejection, timeout) against a controllable fake webview. Integration tests run in a downloaded VS Code and verify what a mock can't: that VS Code fires our will-save participant and applies its `TextEdit[]` to disk, and, driving the real Milkdown editor, that an edit living only in the webview is carried to disk by the save flush. Opening a `.md` swaps the text tab to the rendered editor, so an integration test that needs the raw editor has to dirty the document first, or it measures the wrong surface. That last test uses `birta._test.insertText`, an invisible, uncontributed, test-only command that posts `__testInsertText` to the active webview; no product code path invokes it. Webview behavior is otherwise exercised by the `e2e/` Chromium harness. The integration suite (`src/test/**`) compiles via `tsconfig.integration.json` to `out/`, and is excluded from Vitest and the perf harness. It downloads VS Code on first run (cached in `.vscode-test/`, gitignored) and is not part of `pnpm test`, so run it explicitly. `BIRTA_ITEST_VSCODE` selects the VS Code build under test (default `stable`), and `BIRTA_ITEST_EXECUTABLE` points the suite at an already-installed VS Code-family binary instead (the fork smoke-test path, e.g. VSCodium's `Contents/MacOS/VSCodium`); the nightly release job runs the suite against the `engines.vscode` floor and against stable, the only place the floor compatibility claim is ever launched, so a floor-only failure blocks the release rather than shipping (the first such run found two floor-only bugs that every prior release had carried).

The extension-test host answers every save prompt itself. Under `extensionTestsLocationURI`, VS Code's `FileDialogService.showSaveConfirm` returns Don't Save without a dialog and logs `refused to show save confirmation dialog in tests` at trace level, and Don't Save reverts the shared text model. So an integration probe that closes a dirty tab and finds the edit gone has watched the harness answer a prompt, not the product discard anything; before writing that up as data loss, run the file under `--log trace` and read the renderer log for that line (MAR-368, MAR-59).

### Test commands

```bash
pnpm test              # run all unit tests once (Vitest)
pnpm test:changed      # only the tests affected by what this branch and the working tree touch
pnpm test:watch        # watch mode (during development)
pnpm test:coverage     # run tests + coverage report (coverage/)
pnpm test:integration  # build + compile + run the real-VS-Code suite (downloads VS Code first run)
```

`test:changed` is the inner loop. It runs only the test files reachable from what the branch and the working tree have touched, which on an ordinary branch is a handful rather than the whole suite. The full `pnpm test` stays the gate before a push; this is what to run between them.

Reach for it before reaching for a faster test environment, because the two are not competing for the same seconds. A faster environment takes a fraction off every full run; this one stops running most of the suite at all, and it does it on the loop a person repeats all day rather than the one they run once before pushing. It also costs nothing in confusion, which a second DOM implementation does: see the note in `vitest.config.ts` on why the webview project has exactly one environment.

One harness at a time, and `e2e/harnessLock.mjs` enforces it. `pnpm test`, `pnpm test:coverage`, `pnpm test:e2e`, `pnpm perf`, `pnpm perf:typing` and both `perf:*:ab` forms take a machine-wide lock, and the second one refuses with the name of what is already running. `BIRTA_NO_HARNESS_LOCK=1` overrides.

Three things are outside it, each on purpose. Watch mode is exempt: a watcher is idle for hours, and holding the lock that long would only teach people to route around the guard. `pnpm perf:bundle` is exempt because it is a browser-free byte count that contends with nothing. `pnpm test:integration` is NOT locked, and that one is a gap rather than a decision: it launches a real VS Code and is as heavy as anything here, but it compiles to CommonJS and importing the lock's ESM from there needs a workaround worth less than the protection. Run it alone by hand. The gap is not hypothetical: `diskDrift`'s external-write case has gone red under a concurrently running lane and green with the machine to itself, control included, so a red integration run taken under any other load is not evidence until it repeats alone.

`bash mac/scripts/measure.sh` is outside the lock too, and it is heavy: it launches the real app, drives WebKit, and briefly takes the clipboard. Say so when you hand the lock to a peer, because a machine that looks quiet by the lock can still have a panel being driven on it, and an app-level run and a browser sweep disturb each other in both directions.

The lock knows about our harnesses and nothing else. Foreign load - another repo's browser automation, a stray headless Chromium orphaned days ago - is invisible to it and produces the same failures, so a red suite while the lock is uncontended still means check `ps` before believing it. The signature to recognize: every test passes and the run still exits nonzero, because it is Vitest's reporter RPC timing out rather than an assertion. What you find there may belong to a peer session in another repo, so `ListAgents` and ask before killing it; the process table is machine-wide and a quiet `ps` is not consent.

The lock exists because the prose here did not work. Run two and they do not merely take longer, they produce failures that are not real: measured back to back on one machine, `corpus` failed at a 60 s document-open timeout under contention and passed 44/44 in 9.0 s alone, and a sweep that never finished inside 600 s takes 261.5 s with the machine to itself. Vitest suites go red and pass on a rerun. `perf:typing`'s `block` metric inflates super-linearly, because its `longtask` threshold is a fixed 50 ms and contention pushes sub-threshold tasks over it. A perf capture in particular must have the machine to itself, or its numbers are not evidence.

`node e2e/run.mjs` prints per-suite times and the slowest eight, so a suite that has quietly become the expensive one is visible without instrumenting anything.

Running a suite inside a `git worktree` needs care with `node_modules`. Symlinking the whole directory from the main checkout makes the workspace package resolve there: `node_modules/@birta/minimal-diff` is a relative symlink to `../../packages/minimal-diff`, so a worktree that symlinks `node_modules` wholesale tests the main checkout's engine rather than its own, silently, with a green suite. If your change touches `packages/`, build `node_modules` as per-entry symlinks with a real `@birta/` directory pointing at the worktree's own package, or run `pnpm install` in the worktree.

### Leaving the machine as you found it

A session that launches Birta Writer for Mac owns processes and files outside every repo, and the harness lock can see none of them: WebKit helper processes, and a throwaway defaults domain per run. Both outlive the session that made them.

`bash mac/scripts/reap.sh` reports what is there and `--reap` clears it, and a `SessionEnd` hook runs it for you, so this is not something to remember. `--check` exits nonzero on litter, for a gate. `mac/scripts/measure.sh` asserts its own teardown and fails rather than reporting, and `shared/__tests__/sessionTeardownHook.test.ts` holds the hook's registration and the reaper's safety together, because a teardown that silently stops running is the failure this whole path is about.

That script is where the reasoning lives; three things in it are worth knowing before you write a probe of your own.

A hard kill orphans WebKit. The helpers are XPC services rather than children of the app, so nothing reaps them: they exit because the app asks them to, on SIGTERM through its own handler. End an app you launched with `kill <pid>`, never `kill -9`, and never by pattern. A probe that builds a `WKWebView` starts the same three helpers a whole app does.

A second `trap ... EXIT` REPLACES the first rather than adding to it, so a cleanup registered its own way switches off everything the earlier trap did, silently, while the script still passes.

`defaults delete` on a throwaway domain leaves the plist, because `cfprefsd` writes it back. Remove the file too, and never by a glob over `com.birtalabs.birta-writer.*`: the app's own domain is a prefix of every throwaway one, so a glob there takes the user's real settings.

Foreign load is the other half and is not yours to clean. The process table is machine-wide, so an orphan may belong to a session in another repo or to the user; `ListAgents` names the live peers and asking costs a message. What is yours is what you started, which is what the reaper scopes itself to.

### Layout and naming

```
src/__tests__/              Extension-side unit tests (Node env)
webview/__tests__/          WebView-side unit tests (jsdom env)
webview/__tests__/setup.ts  jsdom global setup (injects acquireVsCodeApi)
shared/__tests__/           Shared-type tests
packages/*/src/__tests__/   Workspace-package tests (Node env; e.g. the minimal-diff core)
__mocks__/vscode.ts         Central vscode API mock
```

- Test files are named `<module>.test.ts`, matching the module under test.
- Follow AAA (Arrange, Act, Assert), with two levels: `describe`, then `it`.
- `it` descriptions take the form `<input condition> should <expected result>`, in English.

### Coverage floors

| Module | Min line coverage |
|--------|-------------------|
| `src/utils/imageService.ts` | 85% |
| `src/utils/getNonce.ts` | 100% |
| `shared/textEdit.ts` | 90% |
| `shared/contentTransform.ts` | 90% |
| `shared/lineMap.ts` | 90% |
| `webview/utils/slug.ts` | 90% |
| Overall | 70%, enforced |

Only the overall figure is a gate. `vitest.config.ts` sets `thresholds: { lines: 70, functions: 70 }` globally and nothing per module, so the six rows above are a convention that no check enforces. Treat them as the bar for a review, not as something CI will catch.

### Required workflow

After feature work: write unit tests with at least one case each for core logic, boundary values, and error paths; run `pnpm test`; run `pnpm build` to confirm it compiles; only then `git commit`.

After a bug fix: first add a test that reproduces the bug, in the same commit as the fix; confirm it fails before the fix and passes after; run `pnpm test` and confirm the whole suite passes before committing. Confirm it against the pre-fix implementation itself (`git show main:<file>`), never against a revert of the line your fix touched: a test can track your fix and still have been unable to catch the bug. A mutation matrix does not substitute for that replay, and the replay does not substitute for it, because mutation pins the fix's scope, which did not exist before the fix.

### Choosing what to assert

Coverage is not the bar. Two bugs shipped with their broken lines executed by passing tests, so the assertion, not the coverage, is what to get right.

- An expected-output assertion can only confirm what you already believe. Prefer invariants, which hold regardless of what the author expects. Where a space is combinatorial (payload against destination, block against target), enumerate it rather than sampling by hand: `webview/__tests__/pasteMatrix.test.ts` and `corpusMoveSampling.test.ts` are the worked examples, and the matrix found two real defects on its first run.
- An instrument that measured nothing reports success, so assert what the instrument reached and not only what it found. An enumeration must assert its own size, because a sweep that reached nothing passes: a schema-wide gate built each node from one editor's schema and inserted it into another's, so every type mismatched, fell through a skip, and it went green having enumerated none. A mutation run needs an arm proving each edit applied, because a mutation that never landed reads as a survivor, and it needs the run's own outcome told apart from a run that never happened, because an arm expecting a red is satisfied by every nonzero exit there is: a harness lock refusing to start, a name filter matching no test, a crash in setup. That one inverts the usual asymmetry and is worth knowing by sight. Elsewhere the quiet failure is a pass, so a red gets investigated; here the arm wants a red, so the refusal it never ran arrives dressed as the confirmation it was hoping for, and nobody audits a success. Assert that the run reached its subject before reading its verdict. An assertion over a predicate has to discriminate something, because one holding at the threshold, at the variant it claims to rule out, and at a hardcoded `if (true)` is decoration, and a differential oracle fed the same input twice agrees with itself whatever the predicate says. Build fixtures from the editor under test, and assert both the covered count and the list of what could not be reached (`blockAddDeleteResidue.test.ts` is the worked example).
- The sharper form of the same question, and the one that generates checks rather than catching you afterwards: what would still pass if this were broken? A guard, an enumeration, or a comparison can be ABSENT rather than wrong, and absence is invisible to every green run, so auditing the guards you have never finds it. Two host-profile fields were declared by three surfaces with no comparison between them, and the app's Swift could have stopped declaring either with the suite still green; they were found by going looking for what had no guard, not by checking that the guards passed. The two shapes to recognise: a coverage assertion written over arrays the loop itself partitions is a tautology, because every item leaves through exactly one of them, so assert a FLOOR on how many returned a real verdict instead of a sum of the buckets they were sorted into; and a hand-written list of cases is a list a new case never joins, so derive the enumeration from the type (`CaseIterable`, a registry, the schema) and let its own size be the assertion.
- A guard names the files it reads, so MOVING content silently empties it. This is the sibling of absence above and it is worse, because the guard did work once: it keeps passing, on a corpus that no longer holds the thing it was written for, and no run reports a coverage of zero. Splitting the changelog by product moved 35 entries into `mac/CHANGELOG.md`, and `changelogClaims.test.ts` read only `CHANGELOG.md`, so every `birta.*` citation and every quoted string in those entries stopped being checked with the suite green. Nothing asks this question for you, so ask it of any change that moves, renames, or splits a file: what was reading this, and does its scope follow? Distinguish it from the near miss it resembles, a check whose subject is intact and whose QUESTION is wrong (`attached` answers whether AppKit accepted a view, never whether it has a width); that one is still tied to something, and still fails when its own subject breaks.
- A guard can also be pinned by a string that is not in the vocabulary of the thing it guards, and then no reading of your own change can reach it. The sibling above is about a guard whose corpus moved; this one is about a guard you never knew existed. Replacing the `/ai` failure marker with a corner message left a check in `e2e/slashMenu` asserting `.agent-pending--error`, a CSS class, in a suite about the slash menu: the plugin's own unit tests and its own e2e suite were both updated, a grep over the diff found nothing, and the only thing that found it was running the whole sweep rather than the suites the change appeared to touch. So run the whole sweep before believing a rename is done, and treat "I updated the tests for this file" as a claim about one file rather than about the behaviour.
- Ask that question of FINISHED work, not only while writing a check. Both findings above were reached by going back over code that was already merged or already green, never by a run going red: a guard whose corpus had quietly emptied under it, and a changelog corruption that had shipped and was rendering an entry as a heading. Neither could have been found by asking at the moment the check was written, because at that moment both were correct. A green suite is the normal condition of this class of defect, not a sign of its absence, so the pass is something to schedule rather than something a failure will prompt. Distinguish it from the other move that finds the same class, which is noticing you have no evidence for something and building the instrument that would give you it; that one is not a re-reading and does not need finished work to act on.

- The fault every shape above shares has a second face, and only one of the two is loud. Those are all checks that PASS for a reason unrelated to their subject, which is why finding one takes a deliberate pass and a green run never prompts it. A check can equally FAIL for a reason unrelated to its subject, and that face announces itself, which is why it gets less thought and still costs more than it looks. `corpusMoveSampling.test.ts` walks a real corpus and takes about a minute with the machine to itself, so under a per-test timeout it goes red whenever the box is busy and the thing being asserted is the load rather than the code. The damage is not the flake: a red nobody can act on teaches the next reader to re-run rather than read, and re-running is precisely the move that buries a real intermittent the day one arrives. A check that is slow by nature gets a timeout sized from its own measured cost, or none, never one a shared machine can trip. The same rule already appears one section up as a perf-gate statistic that depends on machine load; it is the same hazard wearing different clothes.

- Pick invariants the production code can answer, not ones the test has to re-derive. `pasteMatrix` keeps two: schema-valid (`doc.check()`) and round-trip stable (serialize, parse, serialize). Three more specific ones were removed after firing fourteen times, every firing a bug in the test's own Markdown-reparsing helpers rather than in the editor. Round-trip stability caught every real defect on its own, because corrupt Markdown reparses into something else generically, with no per-construct rule to maintain. Specificity that lives in test-side parsing is not strength; it just moves a parser somewhere that has no tests of its own.
- A red against the pre-fix code proves the test depends on the fix, not that it fires for the reason written beside it. A document-global gate can arm on something hundreds of positions away from the gesture under test, and asserting the outcome pins none of that. Print the node shapes rather than inferring them from the red.
- If a write-up names a safety branch as the reason a design is sound, delete that branch and watch a test go red. Otherwise the branch is decoration, and so is a test that survives every mutation you can think of.
- A prop-level test cannot catch a handler race. Calling `someProp("handlePaste", ...)` directly bypasses event dispatch, which is the layer such bugs live in: one paste inserted two images because a `document`-level listener bubbled after ProseMirror's own handler on the editor element (MAR-277). Anything registering `handlePaste`, `handleDrop`, or `handleKeyDown`, or otherwise depending on which listener wins, needs an `e2e/` check dispatching a real event. `e2e/pasteImage` is the worked example. Gotcha: a bare `.ProseMirror img` selector reports a phantom image, because ProseMirror renders its own `<img class="ProseMirror-separator">` into contenteditable. Query `img:not(.ProseMirror-separator)`.
- A reproduction that matches a ticket's numbers exactly can still describe a state no gesture reaches. Drive the case through the editor before believing it: a harness calling an internal path directly can force a branch the UI never enters, and the numbers agree either way.
- Mark a known-but-unfixed combination `it.fails` with its issue id, never skip it. `it.fails` errors the moment the bug is fixed, so the list must shrink (`KNOWN_GAPS` in `pasteMatrix.test.ts`). Before promoting one, check it is failing where you think: `it.fails` passes when the body throws for any reason, its own setup guard included, so it can read as a live pin on a construct it never reached.

- Prose in a test file can be EXECUTABLE without anyone intending it to be, and then the file's own documentation is what breaks it. A test written to assert which environment it ran in explained, in its header, that other files pin themselves with an environment docblock, and spelled that directive in order to say so. Vitest parses the docblock, so the file set its own environment to the one it was written to contrast with, and its assertions then failed for a reason with nothing to do with their subject. This is not a typo to avoid near one directive, it is a category, and the sting is that the usual defence, writing the reasoning down beside the thing, is what created the hazard. Anything a runner reads out of a comment can be triggered by a comment ABOUT it, and three tools here do read comments: `@vitest-environment`, `eslint-disable`, and `@ts-expect-error`. Grep for them rather than trusting a count, and note that the first takes more than one value, so a sweep for the `jsdom` spelling alone misses the file pinned to `node`. `@ts-expect-error` is the one to fear, because a stray one changes nothing until the error it was expecting stops happening, and then fails somewhere unrelated. The remedy in order: do not spell a live directive in prose at all, break it or name it indirectly; and then, for the case where somebody spells it anyway, a file whose subject is its own execution context asserts that context first, before anything that would be misread as a finding, with a message naming which of the two it is.

- Import reachability is not a proxy for runtime use, and a guard built on it passes forever without testing its subject. Asked which test files exercise the sanitizer, the import graph answers with nearly half the webview suite, because the editor composition root imports the loader and almost every test builds an editor. Narrowing the target from the loader to the two production sinks moves the count by a single file. The opposite signal is no better: a search for files naming the sanitize API finds one, because the rest drive it through the editor. Both answers are wrong in opposite directions and neither is close. Reach for reachability only where the question really is "can this be reached"; for "what actually runs this", instrument the function to record its caller and run the suite, which answers in one pass and answers exactly.

- A probe's error handling can hide the finding, and the result it hands back is shaped exactly like the answer you were hoping for. Instrumenting `loadSanitizer` to record its callers reported ZERO callers, with no error and no gap in the output, because its own `try`/`catch` swallowed the failure of the recording. Nothing calls it reads as good news, so this does not merely fail to inform you, it actively confirms you. The `catch` was wider than the thing it was catching for, which is the shape to distrust and the one you can see while writing it: a catch put there defensively, with no specific failure in mind, cannot distinguish the failure it was imagining from the one that matters. A probe gets no `catch` at all unless the catch itself reports, because an instrument that cannot tell "nothing happened" from "I could not look" is worth less than one that crashes. The same floor belongs on anything that measures rather than asserts: a timing harness checks that the run it just timed actually collected the work, and refuses rather than reporting, because a stopwatch held over an empty room returns a very good number.

### Before `git push`

- Run `pnpm test`. Push only if everything passes.
- Run `pnpm typecheck`. Neither esbuild (`pnpm build`) nor Vitest typechecks, because both transpile with types erased, so an interface or annotation error passes every local test and build and then fails CI's `unit-test` job at its `pnpm typecheck` step.
- Run `pnpm test:e2e`. It is the local pre-push gate for webview behavior, and CI does not run it, so nothing downstream will catch what it catches. Anything touching `webview/` needs it, and jsdom's lack of a layout engine means whole classes of change (positioning, viewport, scroll) are observable only here. The harness lock refuses to run it alongside `pnpm test`; see "One harness at a time" above.
- CI's `unit-test` job runs on every push and PR (`.github/workflows/ci.yml`). A failure blocks the build.

### Handling test failures

A newly introduced failure: locate the code change, fix it, re-run. An expectation that no longer matches intended behavior: update the test, but only if the change was intentional. Anything else: check the jsdom version and confirm the vscode mock is complete.

Prohibited:

- Do not skip (`it.skip`) or comment out failing tests to make CI pass.
- Do not change expected values to mask a bug, unless the implementation changed intentionally and was reviewed.
- Do not push to `main` or `dev` without running tests.

### Mock rules

- Call `vi.clearAllMocks()` in `beforeEach` for each `describe` block.
- Mock filesystem operations via `vscode.workspace.fs`. Never write to the real disk.
- Don't test `private` methods. Verify behavior through the public interface.
- For time-dependent logic use `vi.useFakeTimers()` and `vi.useRealTimers()`. Never wait on a real `setTimeout`.
  - `vi.useFakeTimers()` fakes `performance` too, and a faked `performance.now()` starts at 0. Code that sleeps via `setTimeout` but reads time via `performance.now()`, such as `webview/syncScheduler.ts` where every window is a `now() - mark` comparison, therefore boots into a state no real webview is ever in, and an elapsed-window check reads `0 - 0 >= 300` as false. If a test depends on a scheduler window, wind the clock past it first rather than trusting the default; `useFakeClockPastIdle` in `savePipeline.test.ts` is the worked example.
  - Vitest 3 enforces `testTimeout`, which Vitest 2 did not always do. If a test starts failing on time after a runner upgrade, measure it on the old runner before assuming the new one made it slower: it may simply have started exceeding a limit it always exceeded. Prefer a per-`describe` timeout, with the measured cost in a comment, over raising the project-wide default. That rule earned its keep on the move to Vitest 4: the heavy corpus suites timed out under `pnpm test:coverage` on the new runner, and the same command on the old one, same machine, timed out harder. The cause was machine contention, and blaming the upgrade would have reverted the fix for the flake it was landed to remove.

## Autosave

The editor is `CustomTextEditorProvider`-backed, so the backing `TextDocument` carries native dirty state. Saving is governed entirely by VS Code's built-in `files.autoSave` and `files.autoSaveDelay`; there is no extension-specific autosave, and the former `markdownWysiwyg.autoSave` and `autoSaveDelay` settings were removed before the rename. With the VS Code default (`files.autoSave: "off"`), edits stay dirty until Cmd+S or hot exit, exactly like any text editor.

### View to document sync invariant (never lose an edit on save)

The edit lives in the webview (Milkdown); the `TextDocument` is what VS Code saves. The pipeline carrying edits from webview to document must satisfy, in order of priority:

1. A save never persists content older than the editor state. The extension registers `onWillSaveTextDocument` and, via `waitUntil`, asks the webview to serialize the live document now, returning those bytes as the save's edits (`_flushWebviewEdits`, `flushPendingEdit`). A save is bounded by a roughly 1 s timeout, so a wedged webview degrades to "save current document" rather than hanging.
2. An edit is save-capturable the moment the user perceives it. The first edit after a save dirties the `TextDocument` within an IPC hop (leading-edge sync in `webview/editor.ts`). `onWillSaveTextDocument` only fires for a dirty document, so this is what makes a fast Cmd+S actually save.
3. Ordering is total. Every outbound content message carries a monotonic `seq`, and the extension drops any `update` a flush has superseded, so a slow in-flight sync can never revert a newer save (`_appliedSeq`).

The webview-to-document debounce is load-bearing for crash safety, not performance: it bounds how far the `TextDocument`, which hot exit backs up, trails the editor. Serialization is O(document size) and runs off the keystroke path, on typing pause, max-wait, or save, never per keystroke. Do not lengthen the debounce toward "save less often", which breaks the crash-safety window, and do not move serialization back onto the keystroke, which reintroduces per-keystroke O(n) cost. On very large documents typing is still bounded by ProseMirror's per-keystroke view reconciliation, a separate document-size-scaling cost unrelated to this pipeline.

`webview/syncScheduler.ts` must be the ONLY delay in this pipeline. Its trigger is `webview/plugins/docChange.ts`, which reports every doc-changing transaction synchronously. Never put a debounce or throttle upstream of it, and never route the trigger through one. The scheduler already implements leading edge, trailing edge, and max-wait together, so a second timer upstream can only starve it. Milkdown's `@milkdown/plugin-listener` (an unconditional trailing `debounce(fn, 200)`) used to sit there and broke invariants 1 and 2 at once (MAR-145). Its 200 ms constant put a fifth of a second between the first keystroke and the document going dirty, and because a trailing debounce resets on every keystroke, continuous typing never fired it at all: the scheduler was never asked, its max-wait never engaged, and the document stayed clean for the whole burst, so a Cmd+S mid-burst was a no-op and hot exit backed up stale bytes. Pinned by `e2e/syncLatency`.
