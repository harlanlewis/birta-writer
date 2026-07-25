# Multi-surface investigation — Birta Writer beyond VS Code

**Status:** investigation / gap analysis only. No implementation. Written 2026-07-25.

**Question:** what is the gap between Birta today (a VS Code extension) and shipping it
as (1) a standalone **web app** and (2) a standalone **installable desktop app**, with
maximum code sharing?

This document maps the *categories* first (breadth), then goes area-by-area (depth),
then covers runtime choices, cross-cutting product concerns, what's genuinely blocked,
and a recommended sequence. It's the output of a fan-out across nine focused
investigations of the codebase plus external runtime research.

---

## 0. The one structural fact that shapes everything

Birta is, architecturally, **one editor that already runs in a browser, wrapped by one
host (VS Code)**. The editor (`webview/`, ~built into `dist/webview.js`, esbuild
`platform: browser`) never imports `vscode`; it talks to the host through a **single
typed `postMessage` protocol** (`shared/messages.ts` — ~80 messages both directions —
funnelled through one `acquireVsCodeApi()` call in `webview/messaging.ts:15`, guarded by
`typedWebviewSends.test.ts`). Everything in `src/` is the *host half* of that protocol.

So the project is **not "build two new apps."** It is:

> **Enumerate everything VS Code silently provided, re-provide the host minimum on each
> surface behind the protocol that already exists, and re-earn the brand promises
> (fidelity, offline, privacy, no-tracking) that were partly the host's doing.**

The seam is real and already enforced. The work concentrates in two buckets: (A) a
handful of bootstrap-time couplings *outside* the protocol (theming, `acquireVsCodeApi`,
`window.__i18n`, CSP), and (B) the large "shell" VS Code gave for free (files, tabs, a
raw editor, commands, settings UI, search).

Birta is unusually well-positioned for this because the seam, a pure `shared/` core, a
`packages/*` workspace with one extracted package already (`@birta/minimal-diff`), a
browser-based test/perf harness, and a multi-product brand system all exist *today*.

---

## 0.5 Strategic reframe — the factory, edit-once, and web-last

Three directional decisions (maintainer, 2026-07-25) that reshape the whole analysis:

**(a) Web is last, and it's a different product.** Almost every "genuinely hard on web"
finding in this document is a *local-files-in-a-browser* problem (no file-watching, no
sibling-link resolution, no `asWebviewUri` equivalent, sandbox permission friction). A
**cloud-backed** web app doesn't have those — it has *server* problems instead (sync,
accounts, hosting, the privacy contract). So the web surface is not "the port, but harder";
it's **a cloud writing service that reuses the editor**, whose value lives in
cloud/multi-device/sharing — a separate build, correctly sequenced last. The scary
web/FSA/OPFS sections below become mostly moot for the near term.

**(b) "Edit once, deploy everywhere" for the writing experience.** Any change to the
*editing experience* must ship to every surface with zero per-host re-implementation. The
naive version of this — "move keybindings/commands/settings into core" — is **wrong**, and
worth stating why: when Birta runs *as a VS Code extension it must behave like one*.
Keybindings must resolve through and be rebindable in VS Code's Keyboard Shortcuts UI, be
`when`-gated, appear in the native palette, and settings must live in the native Settings
UI with real user/workspace scopes. You cannot move that into core and keep the extension
feeling native.

The resolution (detailed in **§14**): separate a command's **definition + behavior**
(edit-once core) from its **binding + surfacing** (a host capability). VS Code provides
binding/surfacing natively and the core's defaults stand down there; a standalone host uses
a core-shipped default keybinding/palette/settings engine. This is exactly Monaco's own
pattern — it ships `StandaloneKeybindingService`/`StandaloneCommandService`/standalone
config that the VS Code workbench overrides via DI and never constructs. So the seam is:

> **Core owns command *definitions and behaviors*, the editing surface, and *default*
> engines for binding/palette/menus/settings/raw-editing. The host owns binding &
> surfacing (natively when it can — VS Code — else via the core defaults) plus all OS
> integration** (files, windows, persistence, dialogs, asset-URL minting).

Under this model the VS Code extension does **not** surrender native feel — its own
keybinding/palette/settings services stay in use; only the shared command *table* is
edit-once. Birta is already ~70% there: `shared/editorCommands.ts` and `shared/config.ts`
are the definition tables, and `package.json`'s contributions are a hand-authored
projection reconciled by drift tests — which become *generators* (§14).

**(c) "Factory/playbook for many apps" — but NOT a shared editor core.** *(Corrected after
maintainer input — an earlier draft over-indexed on this; recorded honestly.)* The Birta
Labs portfolio may include apps with **nothing in common but the parent brand and being web
apps** — e.g. `harlanlewis/retire-early`, a family retirement calculator that shares no
ProseMirror, no markdown, no VS Code with Birta Writer. So there are **two different shared
layers, and we were conflating them:**

- **Layer 1 — the Birta Writer editor core**, shared across *Writer's own surfaces only*
  (extension → desktop → maybe cloud web). This is the real, bounded code-sharing target of
  this whole document. It is **not** portfolio-wide; Birta Writer may be the *only*
  "markdown-read/write + editor" app that ever exists. The editor-core extraction is
  therefore justified by **two real consumers (the extension + a desktop shell)** — not by a
  fleet of hypothetical future editors. That is a *modest* extraction, and the YAGNI
  discipline in §13 fully applies: don't build a grand "editor factory" for editors that may
  never come. The `webview/format/` "markdown is format #1" seam is a nice-to-have that
  *may* pay off if a second format ever appears — treat it as latent optionality, **not** as
  evidence a multi-format factory should be built now.
- **Layer 2 — the Birta Labs "how we make a good app" playbook**, shared across the
  *portfolio* (Writer, retire-early, future apps). This is **format- and domain-agnostic
  infrastructure/convention, not an editor**: the brand/design-system tokens (`docs/BRAND.md`
  is already portfolio-tier: company / constant / product naming, a utility glyph for
  favicons/app-icons), release + code-signing + auto-update templates, a web-app skeleton,
  CI/testing conventions, hosting/deploy patterns, and (if apps ever need accounts) a shared
  auth/identity story. This is the lighter, real "factory" the portfolio benefits from — and
  it is mostly *tooling and taste*, not a big software abstraction.

Consequences (deliberately un-grand):
- **The editor-core work is scoped to Writer, validated by Writer's own second surface.**
  The cheapest second surface is the Tauri desktop shell, so **desktop-first still holds** —
  it proves the extraction against a *second real host* (extension + desktop), which is all
  the justification the abstraction needs. No claim that it seeds a fleet of editors.
- **The `HostServices` contract is defined by the simplest of Writer's surfaces**, not by VS
  Code (which over-fits), and not by imagined other products. Keep it small; let VS Code be a
  rich adapter above the minimal line (§14).
- **The portfolio playbook is harvested, never designed top-down.** Extract shared brand/
  release/CI conventions from Writer + retire-early *as they actually repeat*, into light
  templates — not a framework. Two data points (Writer, retire-early) is exactly enough to
  see what genuinely recurs and refuse to abstract what doesn't.
- **Edit-once is a within-Writer property** (its 2–3 surfaces), not a portfolio property. It
  still shrinks Writer's QA matrix (shared conformance suite proves the writing experience
  once; each host runs a thin integration suite) — but it says nothing about retire-early.

Net effect on the plan: **desktop (Tauri) is Writer's priority second surface and the
validation vehicle for a *modest, Writer-scoped* core extraction; cloud web is a later,
separate product; the portfolio "factory" is a light brand+tooling playbook harvested across
independent apps, not a shared editor engine.** Local-file hardness largely disappears on
desktop; the real work is the edit-once seam and the shell chrome (§6).

---

## 1. Category map (think about these before any detail)

Grouped into three bands.

### Band A — Portability of the core (the good news)
1. **The postMessage protocol as the platform-adapter seam** — is it clean? (mostly yes)
2. **Webview browser-portability** — `acquireVsCodeApi`, the `--vscode-*` theme contract,
   CSP/nonce, lazy asset loading, `window.__i18n`.
3. **Build / bundling / deps / monorepo shape** — dual esbuild target, Node-only vs
   browser-safe deps, per-surface build targets, package restructuring.

### Band B — The VS Code surface we must rebuild (the work)
4. **File / document layer** — read/write, image persistence, local-link resolution, path
   autocomplete, external-change detection, the save-flush invariant.
5. **Save & persistence model** — no `TextDocument`, no `onWillSave`/`waitUntil`, no hot exit.
6. **Config / settings** — no VS Code settings store; need our own store + a settings UI.
7. **Shell chrome** — a raw/source markdown editor (Birta has none), a file browser,
   multi-document/tabs, command palette + rebindable keybindings, find-in-files,
   status bar, quick-pick, dialogs, outline.

### Band C — Runtime & product strategy
8. **Desktop runtime choice** — Electron vs Tauri vs others (the footprint concern).
9. **Web platform reality** — File System Access API / OPFS / fallback; the hard limits.
10. **Cross-cutting product**: code-sharing architecture, identity/auth, sync, offline/PWA,
    licensing (FSL), privacy posture, telemetry/support, branding/onboarding, i18n,
    accessibility, per-surface performance, testing matrix, distribution/updates,
    monetization, maintenance cost, and the "one product vs three products" tension.

---

## 2. The adapter seam & the implied `HostAdapter`

The typed protocol is a genuinely strong boundary: payloads are almost all plain data
(strings/numbers/booleans/`Uint8Array`); VS Code specifics (`Uri`, `fsPath`,
`WorkspaceEdit`, tab groups) live on the host side and don't cross the wire. ~30 of the
messages are pure UI or settings any surface can satisfy trivially.

**The leaks (named adapter responsibilities), concentrated in three places:**
- **`webviewUri`** — a `vscode-webview://` opaque asset URL is baked into the protocol
  (`ProjectImage.webviewUri`, `imagePathResolved`, the `imageUriMap` round-trip). Produced
  by `webview.asWebviewUri`. This is the single most VS-Code-specific value on the wire.
- **Workspace-root path semantics** — `openFile.path`, `rootRelative`, the `@/` alias all
  presume a workspace root that a single-file surface doesn't have.
- **Shell-chrome messages with no cross-surface analog** — `openSettings`,
  `openKeybindings`, `wordCount` (→ status bar), `focusState` (→ when-clause context key),
  `switchToTextEditor` (assumes a separate raw editor exists).

**Five bootstrap-time reach-arounds *outside* the protocol** (the real porting surface):
1. `acquireVsCodeApi()` global — isolated to `webview/messaging.ts:15`; the jsdom test
   setup already stubs it, so the shim is a known quantity.
2. The `--vscode-*` CSS palette (see §3) — the biggest one.
3. VS Code theme body-classes (`vscode-light`/`vscode-dark`) that `nativeThemeBridge.ts`
   observes; JS reads computed `--vscode-*` values (Mermaid canvas, etc.).
4. The host-fixed nonce CSP with `vscode-webview://` origin.
5. `window.__i18n` — a synchronous config snapshot injected before the bundle; the editor
   reads feature gates / fonts / width from it at boot. Any surface must emit an equivalent.

**Implied `HostAdapter` interface** (what every surface must provide): document
load/apply/flush + external-change; filesystem read (link resolve, dir list, workspace
index, project images, frontmatter scan); **asset-URL minting** (`toDisplayUrl` /
`toStoredPath` — the `asWebviewUri` equivalent, the key leak); image persistence; a single
network fetch (unfurl); OS file picker; clipboard; open-external; settings read/write +
change events; and a "host shell" bucket (settings UI, status bar, focus context,
plain-text switch, crash sink, disk-drift). Settings dominate by message count; the FS +
asset-URL bucket dominates by coupling risk.

---

## 3. Webview browser-portability — theming is the #1 blocker

Loading `webview/index.ts` in a plain tab is a **small-to-moderate** effort to first
interactive prototype, because coupling is narrow and already abstracted. Ranked blockers:

1. **Theming (largest).** ~90 distinct `--vscode-*` variables, consumed ~580× across 22
   CSS files, with **no literal fallbacks by project mandate** (`AGENTS.md`), plus ~37 JS
   reads of computed values. Unset → the UI renders invisible/unstyled. A standalone
   surface must author a synthetic light/dark (and high-contrast) `--vscode-*` palette on
   `:root` sourced from the brand palette, and set the matching body class. Broad but
   mechanical. The `--ui-*` chrome token system (`chrome.css`) is self-contained and
   *portable*; only the color leaves need supplying. **This is likely the single largest
   mechanical port** and it doubles as the accessibility-contrast migration.
2. **Host stub + `window.__i18n`.** Replace `acquireVsCodeApi` (one function); emit
   `__i18n`. Read-only render works with a no-op host; full editing needs the
   reply-bearing messages (image upload, path/link resolution) implemented or stubbed.
3. **Static HTML/CSP page** replacing `src/webviewHtml.ts` (same-origin CSP; keep the
   entry served at a path ending `dist/webview.js` or generalize `katexLoader.ts`'s
   entry-script lookup).
4. **Content persistence** behind the same `update`/`flushResult` messages.

**No Node/VS Code imports leak into the webview bundle** — verified. Lazy asset loaders
(KaTeX/Mermaid/grammars/embeds) are bundler-native and survive a normal static server;
KaTeX fonts are inlined as data URIs, so no font-host config.

---

## 4. File / document layer — the hard center, and where web hits walls

Five VS Code primitives recur: `workspace.fs`, `Uri`/`fsPath`, workspace-folder root,
`asWebviewUri`, and `onWillSave`+`waitUntil`+`WorkspaceEdit`. Every "hard on web" flag
traces to one of these having no browser equivalent. Porting difficulty (hardest first):

| Subsystem | Web | Desktop | Why |
|---|---|---|---|
| **External-change detection** (`externalChanges.ts`, `diskDrift.ts`) | **Very hard / partly impossible** | Low–Mod | No FS-watch API in the browser (File System Access has no change events — only poll `lastModified` on held handles); mechanism A (another editor changed the in-memory doc) has *no* analog. Needs a server or degrades to polling. |
| **Local link resolution & open** (`linkResolver.ts`) | **Hard** | Low–Mod | Needs workspace enumeration (`findFiles`) + opening an arbitrary sibling the user never granted — both sandbox-blocked. Resolver *logic* is already pure (injected `ResolverIo`). |
| **Image display / path resolution** | **Hard** | Low | No `asWebviewUri` equivalent for a sibling path on web; Tauri `convertFileSrc` is a drop-in. |
| **Image persistence** (`imageService.ts`) | Mod–Hard | Mod | Dir-discovery + display URL assume ambient FS; swap MD5→SHA (`crypto.subtle`); write logic ports. |
| **Path/link autocomplete** | Mod–Hard | Low | Ranking already pure; only the two enumeration IO sources need backends. |
| **Save pipeline** (`saveFlushController.ts`) | Low–Mod | Low | The version/seq guards are pure and dependency-free; losing `waitUntil` *removes* a constraint. New work = own the save target + crash-safety backup. |
| **Destructive-change tripwire** (`destructiveGuard.ts`) | Trivial | Trivial | Pure string math. |

**The save-flush invariant** (a save never persists content older than the editor —
Birta's original data-loss fix) is built on `onWillSaveTextDocument` + `waitUntil`, which
**has no browser/desktop primitive**. But that's a *constraint being removed*: off VS Code
you own the save button, so you pull the serialized content and write it — no foreign save
to intercept. The `SaveFlushController` logic ports as-is; you add your own atomic write +
crash backup (OPFS/IndexedDB on web).

**Structural help:** the pure logic is already separated from IO in nearly every subsystem
(`saveFlushController`, `linkResolver` with injected `ResolverIo`, `contentTransform`,
`destructiveGuard`, `shared/linkTargetSuggest`). Porting is mostly *re-implementing the
injected IO seam per platform*, not rewriting logic. The one un-abstracted invasive
dependency to wrap first is **`asWebviewUri` + the `_imageUriMaps` round-trip** → a
`toDisplayUrl(absPath)` / `toStoredPath(url)` port interface. `_workspaceRootFor` is
already the single "what is the root" chokepoint — the place to inject a platform root.

The recurring web escape hatch is **"add a server backend"**, which restores fs/watching/
workspace — at the cost of no longer being a pure client app (it becomes the desktop model
with the filesystem on a server).

---

## 5. Config / settings — low risk, but the settings UI is real work

**Verdict: low-to-medium effort, low risk.** `src/config.ts` is *already* the single
VS-Code-coupled chokepoint ("the ONE place we touch `getConfiguration('birta')`") over a
VS-Code-free `shared/config.ts` shape (90 manifest keys → a 61-field typed snapshot with a
full defaults table pinned by test). The webview never reads settings directly — it
consumes injected bootstrap values + live broadcast messages and writes back via intent
messages.

Cleanest refactor: a `ConfigStore` interface (`get`/`getAll`/`update`/`onDidChange`).
The VS Code adapter = today's `config.ts`; standalone adapters = localStorage/IndexedDB
(web) or a config file (desktop). The three scope-write variants collapse to one flat
`update` (there's no user/workspace/folder tree off VS Code). The 31-branch
`onDidChangeConfiguration` listener rewires to `store.onDidChange(keys)` — same typed
message payloads, only the trigger changes.

**Cost center:** VS Code renders the entire settings editor for free from the 90-key
`contributes.configuration` block. A standalone settings UI must be built — but it can be
*generated* from that same machine-readable schema (types/enums/descriptions/order all
present). Watch-items: the `toolbar.items.*` nested-key deep-merge-with-defaults, and the
`_networkWriteInFlight` race (a sync store removes it — revisit so it doesn't mask a bug).
Notably: **no `globalState`/`workspaceState`/`secrets`/`Memento` usage anywhere** —
nothing hidden to migrate.

---

## 6. Shell chrome we must build ("fill in the VS Code surface ourselves")

Four **LARGE** surfaces dominate, then a bounded MEDIUM tier, then SMALL plumbing.

**LARGE:**
1. **Document/save model** — file read/write, dirty tracking, autosave,
   save-prompt-on-close (today VS Code's native Save/Don't-Save/Cancel via
   `tabGroups.close()`), revert/diff, external-change/conflict.
2. **Raw / source Markdown editor** — Birta has *none*; "Edit Raw Markdown" literally hands
   the file to VS Code's text editor (`vscode.openWith(uri, "default")`). A standalone app
   needs a whole second editing surface (syntax highlight, line numbers, cursor↔WYSIWYG
   line sync). This directly affects the "safety net, not a wall" north star. **Detailed
   design in §15** (CodeMirror 6, serialize↔parse toggle, fidelity companion positioning).
3. **Multi-document + file browser + local-link navigation** — Birta edits exactly one file
   and asks VS Code to open any other. Needs a tab model, a file-explorer tree,
   "open folder," and in-app link-follow.
4. **Command palette + keybindings + `when`-context system** — 99 commands, 29 keybindings,
   87 palette entries, 149 `when` clauses, 88 generated editor-actions
   (`shared/editorCommands.ts`). Needs a command registry, palette UI, a rebindable-keymap
   engine with context evaluation, and a shortcuts-editor UI. (ProseMirror typing chords
   port for free; the *command surface* invoking them does not.) **Resolved by the
   capability taxonomy in §14** — definitions stay core/edit-once; only the standalone
   binding+surfacing engine is net-new, and it's generated from the shared tables.

Plus **find-in-files → editor navigation** is a build-from-scratch feature (today it's
`revealLine` interception glue over VS Code's search).

**MEDIUM:** settings store + UI (§5); the workspace/project-root concept (image dedup dir,
path completion, file index all assume a folder); tab management (preview/pinned/columns);
gotoSymbol/outline.

**SMALL:** quick-pick widget; OS file dialogs; status-bar strip (word/char/reading-time);
external-URL open (with our own trusted-domains confirm) + clipboard.

**Non-issues / already ours:** the in-content right-click menu is already Birta's own
(`webview/components/contextMenu.ts`); typing-level ProseMirror chords port free; the
string catalog (`package.nls.json`) is reusable.

---

## 7. Build, dependencies, monorepo

Current: two esbuild targets (`extension.js` node/cjs, `vscode` external; `webview.js`
browser/esm, splitting on). The **~4 MB webview graph is already the browser target and
ships unchanged** — the large reusable asset; only a ~40 KB host layer is new per surface.

**The one genuinely Node-coupled runtime dep is Harper** (Automattic's Rust/WASM
spell-grammar engine, ~300 MB resident, loaded from a `file://` URL, extension-hosted).
For web it needs a browser-WASM re-host (`fetch` + HTTP URL, ideally in a Worker); for a
Tauri desktop it could move host-side *natively* (it's already Rust). Everything heavy in
the webview (Milkdown/ProseMirror, mathjs, katex, mermaid, refractor) is already
browser-safe and lazy-chunked. The SSRF-guarded unfurl `fetch` (`node:dns`/`node:net`)
**cannot** run in a browser (CORS + no socket/DNS introspection) — proxy or drop on web.

**Recommended monorepo split** (the seam makes this a mechanical extraction, not a
rewrite): `packages/core` (promote `shared/` + messages + editor-commands + minimal-diff),
`packages/editor` (the `webview/` renderer as a library exporting a mount function + the
host interface), `packages/host-vscode` (today's `src/`), `packages/host-web`,
`packages/host-desktop`. Add a *new* boundary test (analogous to `pmFunnel.test.ts`)
banning host assumptions from the core.

**Distribution today:** VSIX only (CalVer from the clock, nightly `release.yml`, Marketplace
publish dormant until `VSCE_PAT`). Web adds static hosting + PWA (no signing). Desktop adds
per-OS installers, **code signing + notarization**, and **auto-update** infra — materially
heavier than the current single Ubuntu VSIX job.

---

## 8. Runtime recommendations

### Desktop → **Tauri v2**
Directly serves the two mandates (low footprint + reliable native file access):
installers ~3–10 MB, idle RAM ~30–50 MB (roughly half Electron); Rust host with a scoped
`fs` plugin **and a native file-watcher** that maps onto Birta's external-change detection —
the exact capability that's near-impossible on web. Real datapoint: Hoppscotch's
Electron→Tauri migration went 165 MB → 8 MB bundle, ~70% less RAM.

**The one real cost: Linux WebKitGTK.** Tauri uses each OS's webview (WebView2 / WKWebKit /
WebKitGTK); WebKitGTK is the weak link and varies by distro. For a contenteditable-heavy
ProseMirror surface this is a genuine per-release QA line item, not a footnote — though
Birta already targets es2020 + modern CSS, which WebKitGTK mostly handles. Keep Electron in
reserve only if WebKitGTK proves unworkable for the editor specifically. Tauri v2 has
first-party updater + documented signing/notarization (slightly more assembly than
electron-builder).

### Web → **Chromium-first File System Access API + OPFS + fallback** (the vscode.dev model)
- **File System Access API** gives true "open a folder, edit files in place" — but is
  **Chromium-only** in 2025 (Safari/Firefox ship *only* OPFS and consider the disk pickers
  harmful). Permissions don't auto-survive reload: persist handles in IndexedDB, then
  `queryPermission → requestPermission` on launch (Chrome 122+ adds persistent grants).
- **OPFS** is the universal (all browsers), fast, *sandboxed* store — great as the working
  copy / crash-safety buffer, but the files aren't user-visible and can't reach the user's
  real `.md`.
- **Safari/Firefox** degrade to upload/download + optional sync backend. **Accept a
  two-tier web experience** — nobody delivers full in-place local editing on Safari/Firefox
  from a tab, because the platform forbids it.
- Ship it as an **installable PWA** for a free desktop-lite tier (service-worker-cache the
  shell + Harper WASM + lazy chunks to keep the offline promise).

**Hard web limits to state plainly:** no watching arbitrary disk for external changes;
sibling/relative-link resolution only inside a *granted* directory; imperfect
re-granting across sessions; Safari/Firefox can't edit in place at all.

**Prior art** confirms the shape: VS Code (Electron desktop + vscode.dev on FSA, one
frontend), Obsidian (Electron, no browser build — deliberate), Zed (fled Electron to native
Rust/GPU — the "why people leave Electron" statement), Typora/MarkText (Electron WYSIWYG —
the footprint gap Tauri closes).

---

## 9. Cross-cutting product categories

- **Code-sharing architecture** — the seam exists; draw the core boundary at the message
  protocol; keep the VS Code extension as *one of N hosts* and as the regression oracle
  (the fidelity corpus proves the core still works).
- **Identity/auth** — today: zero, and that's a *stated value*. Anonymous/local-only must
  stay the default; a login wall contradicts the thesis. Bias to "no account, or account
  for sync only."
- **Sync & storage** — local-first is the only on-brand posture. **They already built the
  hard half of conflict resolution**: minimal-diff + external-change detection + the
  "surface the collision, you pick the winner, never silently merge" philosophy is exactly
  right for multi-device sync — reuse it, don't reach for CRDTs (which fight byte-fidelity).
  Real-time co-editing is a *different product*.
- **Offline / PWA** — "offline by default" is a headline promise; the editor is already
  local-capable (Harper WASM, bundled KaTeX/Mermaid). The PWA is where this is real work
  (service-worker-cache the WASM + lazy chunks; cold first-visit is a new cost).
- **Licensing (FSL-1.1-ALv2)** — not OSI open-source. Shipping a hosted web app makes that
  service one of "the products we offer," so the FSL then also protects it from third-party
  re-hosting (good). But **every release becomes Apache-2.0 after 2 years** — any version is
  freely re-hostable after 24 months, a real constraint to decide *before* pricing. Decide
  per-package licensing for community-facing shared packages.
- **Privacy posture (the hardest reconciliation)** — "nothing leaves your machine" is the
  most differentiated claim. **Desktop preserves it almost verbatim** (position it as "the
  private one"). **Web local-only** can still keep *content* local (FSA + OPFS + WASM) but
  must defend a subtler claim: "the app is served over the network, your document bytes are
  not" — content vs. app-delivery, needs an auditable served-page CSP. **Web sync mode**
  genuinely sends content off-device → a different contract (E2E? what the server sees).
  The `application`-scope consent guarantee doesn't survive off VS Code — reinvent
  "this toggle can't be set by a shared config."
- **Telemetry / error reporting / support** — today errors assume a VS Code host to report
  to (`errorSink.ts`, `crashReporter.ts`); standalone can white-screen with nowhere to send
  the error. On-brand answer: opt-in, local-first crash logs (show the user, let them
  choose to send). Web/desktop need their own support/feedback path (not "file a Linear
  issue").
- **Branding / onboarding** — the brand system (`docs/BRAND.md`) is *already built for
  multiple products/surfaces* (three-tier naming, a required utility glyph for
  favicon/app-icon, domains `birtalabs.com`/`birta.dev` in hand). But **first-run
  onboarding is net-new**: no host to provide the explorer/palette/settings/empty-state, or
  to teach the slash menu / block handles / keyboard grammar. Caveat: the drawn wordmark
  *doesn't exist yet* (BRAND is a discovery plan) — shipping surfaces may front-run the
  identity work; sequence that dependency.
- **i18n / a11y** — `t()`/`kbd()` survive a host swap, but `window.__i18n` (locale, bundle,
  manifest strings) is VS Code's `l10n` machinery today; a host must supply the payload.
  a11y (high-contrast, reduced-motion, screen-reader) is partly inherited via `--vscode-*`
  and must be owned by the core — same migration as theming.
- **Performance per surface** — launch perf is already CI-gated, but the measured thing
  differs: web's dominant cost becomes *network delivery of bundle + WASM cold*, making the
  eager-bytes budget even more load-bearing; the "webview disposed on switch-away" re-mount
  cost *disappears*. The existing Chromium perf harness (`e2e/perf/`, `mdw:` marks) ports
  almost directly to web — a latent asset. Set per-surface budgets; one gate can't span
  "re-mount in VS Code" and "first paint over 3G."
- **Testing across 3 surfaces** — the **fidelity corpus + minimal-diff tests are
  host-agnostic** (crown jewels, unchanged); jsdom/Chromium webview tests port to web.
  The `@vscode/test-electron` integration suite does *not* port — each host needs its own
  equivalent proving the save-fidelity invariant on its persistence layer. Build a shared
  conformance suite every host adapter must pass.
- **Distribution/updates** — three different pipelines/signing regimes (§7). Extend the
  existing "automate the tax" bias (`install:local`, CalVer): every new host's release must
  be fully automated on day one or it rots (one maintainer).
- **Other easy-to-forget items:** file associations / "Open with" per surface (OS registration
  vs File Handling API); rich clipboard flavors (web clipboard is permission-gated); export /
  "no lock-in" must become a *visible, tested* web feature (the founding grievance);
  trademark exposure rises for a public web app; governance/CLA for a higher-profile
  source-available product.

---

## 10. What's genuinely blocked vs. merely work

**Blocked/near-impossible on pure web (no server):** watching disk for external edits;
following a local link to a sibling file the user never granted; resolving relative image
paths to renderable URLs without a granted directory; a real "workspace" of folders; the
SSRF-guarded unfurl fetch. All are browser-sandbox invariants; all dissolve with either
(a) a Chromium directory grant (partial), or (b) a server backend (full, but changes the
product).

**Just work (bounded), heaviest first:** the `--vscode-*` → own-token theming migration;
the raw source editor; command/keybinding/palette system + settings UI; multi-doc/file
browser; per-host save + crash-safety; desktop signing/notarization/auto-update.

**Ports cleanly or free:** the Milkdown/ProseMirror core, all lazy asset loaders, the
`--ui-*` chrome tokens, minimal-diff + fidelity corpus, config *shape*, the pure IO-injected
logic (link resolver, save-flush guards, content transform, destructive guard), the perf
harness, ProseMirror typing chords, i18n functions.

---

## 11. Recommended sequence (factory-validated, web-last)

Framing: **"the Birta Writer editing experience on all of *its* surfaces."** The editor
core is shared across Writer's own surfaces (extension → desktop → maybe cloud web) — this
is a *modest, Writer-scoped* extraction, not a portfolio-wide editor factory (§0.5c). VS
Code was the first shell; each of Writer's surfaces supplies only OS integration. Desktop is
the priority second surface *and* the validation vehicle for the extraction; cloud-web is a
separate, later product. Cheapest-learning-first, not cheapest-to-build-first.

**Rung 0 — free/near-free reach (do first, independent of the extraction).**
- **VS Code-family hosts.** Cursor, Windsurf, VSCodium, code-server, Positron already speak
  the extension API. Publishing to **Open VSX** (already Birta's namespace) covers most of
  these for ~zero marginal work — reach expansion with no new shell. Verify nothing relies on
  Marketplace-only APIs.
- **Scope the "web extension" (vscode.dev / github.dev) path.** A `browser`-field web
  extension build runs *inside* browser VS Code and reuses **all** of VS Code's shell — you
  skip the entire §6 rebuild. The blockers are the same Node couplings the standalone port
  faces anyway (`harper` `file://`, `node:dns` SSRF fetch, `workspace.fs` specifics), but you
  pay them *without also building a shell*. This is very likely the **cheapest path to
  "Birta in a browser"** and should be scoped before committing to a standalone web app.

**Rung 1 — extract the core behind a *minimal* host contract.** Keep the VS Code extension
green throughout (regression oracle; the fidelity corpus proves the core still works).
- Define `HostAdapter` as *what the simplest app needs*, not what VS Code offers.
- Wrap the two invasive seams first: `asWebviewUri`/`_imageUriMaps` → `toDisplayUrl`/
  `toStoredPath`; inject the root via `_workspaceRootFor`. (These pay off in the extension
  today — see §13.)
- Move toward edit-once: begin migrating command dispatch + a default palette UI + keybinding
  handling into core, with the extension *projecting* to native surfaces.

**Rung 2 — desktop on Tauri v2 = app #2 = factory validation.** The cheapest non-VS-Code
host; preserves privacy/offline/local-file with the least new invention (native fs + watcher
cover external-change detection; no accounts, no CSP-as-security-boundary, no FSA gymnastics).
Building it is what forces the adapter to be *right* (extracted from two real hosts, not one).
Do the synthesized `--vscode-*`/brand token set + the settings store & generated settings UI
here — all reused by every later app. Decide Linux posture explicitly (full support vs
"Linux users get the PWA") given the WebKitGTK/contenteditable risk (§13).

**Rung 3 — harvest the factory.** Once two hosts share the core, template the per-app layer
(brand tokens, feature/format selection, defaults, release automation) so app #3 is a
config + a host binding, not a project. Optionally prove the FormatModule seam with a
format #2. *Harvest, don't design top-down.*

**Rung 4 — cloud web, a separate product, only when the cloud story is wanted.** Server +
sync + accounts + hosting + privacy contract. Reuses the editor core but is otherwise its own
build. Not on the near-term path.

Throughout, apply Birta's existing investment ordering as the tie-breaker: **fidelity must
hold identically on every host before any host adds a host-specific feature.**

---

## 12. Open decisions for the maintainer

1. **Factory vs. surfaces:** commit to "core-as-factory, apps are cheap" (recommended, per
   §0.5) vs. hand-porting each surface? Determines how much goes into core vs. host.
2. **Cheap-reach rungs:** pursue Open-VSX/VS-Code-family + a vscode.dev web-extension build
   *before* the standalone work? (Recommend yes — highest ROI, validates demand.)
3. **Reference host:** accept that the adapter contract is defined by the *simplest* app, with
   VS Code as a rich adapter above the line (recommended) vs. letting today's protocol be the
   contract?
4. **Desktop runtime + Linux:** Tauri v2 with full Linux support, Tauri with Linux-as-PWA, or
   Electron for guaranteed rendering parity on the contenteditable-heavy editor?
5. **Cloud web:** is the cloud/sync product actually wanted, and if so, what's the privacy
   contract (E2E? what the server sees)? — gate before any web work.
6. **Accounts / monetization:** never / sync-only / required; and pricing in light of the FSL
   2-year Apache conversion (any version is freely re-hostable after 24 months).
7. **Identity sequencing:** the drawn wordmark/glyph (per `docs/BRAND.md`, not yet created) —
   before or after the first non-extension app? Standalone surfaces front-run it.
8. **De-risk probe (cheap, reversible):** stand up `dist/webview.js` in a bare HTML page with
   a stub host for an afternoon to convert the "small-to-moderate prototype" *guess* into a
   measurement and hit the theming/focus/clipboard walls for real, before committing.

---

## 13. Risks, dissents, and cheaper alternatives (self-critique)

This section red-teams the rest of the document. Read it as a counterweight, not a footnote.

**Methodological caveats.**
- This investigation was framed entirely as "how to port." No thread red-teamed the premise
  or costed the cheapest alternative, so the internal agreement across sections is partly an
  artifact of the framing, not independent corroboration.
- **Nothing was measured.** Every effort estimate is inferred from reading code. "Small-to-
  moderate to a first interactive prototype" is a guess; a prototype is not a shippable app,
  and the gap between "renders and edits in a tab" and "an app people trust with their files"
  (reliability, per-OS save correctness, focus/IME/clipboard edge cases) is where most of the
  calendar goes. The §12.8 probe exists to replace the guess with data.

**Where the assessment is soft.**
- **"The seam is clean" is oversold.** It's clean at the *type* level, but it is VS-Code-
  *shaped* — an accretion of whatever VS Code needed. Reifying today's protocol as the
  `HostAdapter` would ossify VS Code assumptions into every app. Hence §0.5's "the simplest
  app defines the contract, not VS Code."
- **Single-maintainer sustainability is the likely binding constraint**, not technical
  feasibility. Each host is a permanent tax (certs, store reviews, crash channels, per-host
  settings UI, QA). Edit-once + a shared conformance suite is the mitigation (§0.5), but the
  honest headline is "can one person sustain N apps without the shipping product rotting."
- **Fidelity does not "port for free."** It holds today partly because VS Code's
  `TextDocument` normalizes newlines/encoding/BOM/atomic-write. Each host reintroduces those
  as fresh round-trip hazards the corpus doesn't currently exercise. Re-prove per host.
- **Harper on web is a real problem**, not a footnote: ~300 MB resident WASM per tab,
  effectively unusable on mobile web. "Local proofreading everywhere" may not survive web
  honestly. (Moot while web is deprioritized; relevant when it returns.)
- **Focus/IME/clipboard/mount** behaviors currently depend on the VS Code webview iframe
  sandbox; a same-origin page changes all of them subtly, and a WYSIWYG editor is exactly
  where that bites. Unexamined — flagged for the §12.8 probe.

**Where recommendations deserve challenge.**
- **Tauri is riskier for *this* app than the generic case.** A ProseMirror WYSIWYG editor is
  the worst case for webview inconsistency (contenteditable, selection, IME, clipboard), and
  Linux WebKitGTK is the weak engine — for a *fidelity-first* product, "renders subtly wrong
  on Linux" is disproportionately damaging. Consider asymmetric support (Tauri on mac/Windows,
  PWA on Linux) rather than treating WebKitGTK parity as a mere QA item.
- **"Server backend = brand betrayal" was too binary.** A thin *optional* sync server may be
  the actual unlock for the web product and reuses the existing conflict-resolution
  philosophy; it deserves honest costing, not reflexive recoil. (The maintainer has now
  scoped this as the *point* of the web surface — §0.5(a).)
- **The positioning contradiction may be the crux, not a bullet.** BENEFITS says the author
  uses Birta *because* it sits in VS Code beside git/diff/an AI agent. A standalone app
  deletes the stated reason the product exists for its own creator — which implies the
  standalone apps serve a *different* user (a new ICP), i.e. new products, not ports. Name
  that ICP before building for it.

**Cheaper alternatives the main body under-weighted** (now promoted to Rung 0, §11):
VS-Code-family hosts via Open VSX, and a vscode.dev/github.dev **web-extension** build that
reuses VS Code's entire shell. Both deliver reach for a fraction of a standalone app's cost
and should be exhausted (or consciously rejected) first.

**On adopting the architecture speculatively, before multi-surface is ratified.**
Mostly **defer** — with a small, real exception. The extraction's justification is *two
real Writer surfaces* (extension + a desktop shell), not a fleet of imagined editors
(§0.5c); the engineering risk (over-fitting a contract extracted from one host) is unchanged,
so:
- *Do now (pays off with one host):* wrap the `asWebviewUri`/`_imageUriMaps` coupling behind
  `toDisplayUrl`/`toStoredPath`; keep `shared/` pure; keep the protocol typed and funneled;
  keep `_workspaceRootFor` the single root chokepoint. These improve the *extension's* clarity
  and testability today, independent of any second host.
- *Defer until a concrete second host exists:* the `packages/core`/`editor` split, the full
  `HostAdapter` interface, host stubs, the monorepo restructure, and "no-host-assumptions"
  boundary tests (which can only encode guesses while one host exists, manufacturing false
  confidence). Restructuring also risks perturbing the CI-gated eager-bytes/launch-perf
  budgets — a measured cost to the current product for hypothetical benefit.
- *Rule of thumb:* adopt a refactor only if it improves the extension on its own merits;
  **design toward the extraction, don't build it** until Writer's desktop surface is
  actually being made.

---

## 14. The capability taxonomy — the edit-once seam, precisely

The single most important architectural output of this investigation. It resolves the
"edit-once vs. behave-like-a-native-extension" tension that the naive "move it all into
core" framing got wrong. Every capability sorts into one of three buckets. The canonical
precedent is **Monaco**: it ships standalone `StandaloneKeybindingService` /
`StandaloneCommandService` / standalone configuration services, and the VS Code workbench
**overrides them via dependency injection and never constructs them** — "core ships a
default; a native host overrides it and the default goes dormant."

**Principle (one sentence):** *A command's identity and behavior are edit-once core; a
command's binding and surfacing are a host capability for which the core ships a default
engine that a native host (VS Code) overrides and puts to sleep; OS integration is
host-only.*

### Bucket 1 — Core-only (truly edit-once, no host variation)
The ProseMirror/Milkdown editing surface: composition root, plugins, NodeViews,
serialization/fidelity, and the **typing-level keys that must be handled synchronously
inside contenteditable** (bold/italic/code, undo/redo, Tab, block/selection chords — the
frozen `CLAIMED_SHORTCUTS` set in `keyboardShortcuts.ts`). These keys are the *one* place a
key lives in core rather than the host binding layer, and the reason is technical
(their default action must be suppressed at the event itself — an async command round-trip
is too late), not policy. They are intentionally un-rebindable on every host.

### Bucket 2 — Core-default-with-native-override (the resolution)
Split every such capability into **definition** (core, edit-once) and **binding/surfacing**
(a host service — native in VS Code, core-default engine in standalone hosts).

| Capability | Definition (core, edit-once) | Binding / surfacing (host service) |
|---|---|---|
| Commands | `shared/editorCommands.ts` (id, title, palette flag, menu section/group) | VS Code: `contributes.commands` + `registerCommand` loop. Standalone: core command registry |
| Keybindings | a *default* chord per command (a new `defaultKeybinding?` on the table) | VS Code: `contributes.keybindings` + native Keyboard Shortcuts UI. Standalone: core keymap resolver + rebinding UI |
| Palette | `palette: boolean` per entry | VS Code: `menus.commandPalette`. Standalone: core palette component |
| Menus | `sections` + `menuGroup` per entry | VS Code: `menus.webview/context`, `editor/title`. Standalone: core context menu from the same fields |
| when/context | the *predicate meaning* ("webview focused", "in a table") | VS Code: `when` strings + `setContext`. Standalone: a core context-key store evaluating the same predicates |
| Settings | `shared/config.ts` (key, type, default, scope) | VS Code: `contributes.configuration` + native Settings UI + scopes. Standalone: core settings store + generated settings UI |
| **Raw/source editor** | the parse/serialize pipeline + line anchoring (all core) | **VS Code: delegate to VS Code's text editor. Standalone: a core-shipped CM6 source editor** (see §15) |

**Why the extension still feels 100% native:** in VS Code the host services *are* VS Code's
own — keybindings resolve through and are rebindable in the real Shortcuts UI, commands
appear in the real palette, settings in the real Settings UI with real scopes. The core's
default engines are **never constructed** (Monaco's pattern exactly). Only command
*definitions and behaviors* are shared across hosts — which is all edit-once ever needed.

**The concrete edit-once win — turn drift-tests into generators.** Today `package.json`'s
`commands`/`keybindings`/`menus` and `configuration` are hand-authored projections of the
shared tables, kept honest by `editorCommandsContributions.test.ts` /
`configDefaultsContributions.test.ts`. Flip those tests into **generators**: emit the
VS Code manifest contributions *from* the tables, and feed the *same* tables to the
standalone engine. Hand-authoring 87 palette entries + 29 keybindings + 149 when-clauses +
90 settings becomes deriving them from one source. The seam that carries this is the one
Birta already has (`webview/messaging.ts` + the `editorCommand` protocol), generalized into
a small **`HostServices` override interface** (command dispatch, keybinding resolution,
context-key get/set, settings read/subscribe, menu presentation) — Monaco's
`IEditorOverrideServices` in Birta's vocabulary.

### Bucket 3 — Host-only (cannot be edit-once; authored per host)
File persistence + dirty state + save flush; windowing / tab model / editor swapping
(`switchToTextEditor`, `switchToPreview`, `gotoSymbol` are host *orchestration*, not editor
behavior); OS focus tracking (the *source* of focus truth, even though the predicate it
feeds is shared); clipboard flavors, image save/upload, native notifications.

### What genuinely cannot be edit-once (flag list)
1. The concrete keybinding/settings **store and UI** per host (only the schema is shared).
2. The `when`-clause **syntax** (VS Code-specific); share the predicate *intent*, compile per host.
3. **Default bindings may diverge per host/platform** (some already do — `joinLines` Ctrl+J
   is macOS-only; Cmd+K is reserved for `insertLink`). Model defaults as host-overridable
   per entry, not one global map.
4. Host-orchestration commands (editor swapping, symbol picker) — Bucket 3, not Bucket 2.
5. The typing-level claimed keys (Bucket 1) — edit-once but un-rebindable everywhere.

---

## 15. The raw / source Markdown editor (a Bucket-2 capability)

**The gap:** Birta has *no* source editor of its own. "Edit Raw Markdown" is pure
delegation — the extension closes the WYSIWYG tab and calls
`vscode.window.showTextDocument` / `openWith(uri, "default")`. Every non-IDE surface
(Tauri, web) inherits **zero** of this and must ship a source-editing mode. It is a large,
previously-unscoped piece and a first-class part of the writing experience (the "safety
net, not a wall" north star depends on a credible raw view existing off VS Code).

**It's a Bucket-2 capability.** VS Code delegates to its own text editor (and must keep
doing so — never ship a source editor *into* the VS Code webview and compete, worse, with
the IDE's own editor at a launch-bytes cost). Standalone hosts mount a **core-shipped
default source editor**, reached through the *same* `editRawMarkdown` / `switchToTextEditor`
intent, so the UI is identical across surfaces and the host decides delegate-vs-mount.

**Engine: CodeMirror 6, lazy-loaded as its own chunk** (gated out of the VS Code eager
graph to respect the `perf:bundle` budget). Rationale: CM6 is ~50–135 KB gz vs Monaco's
2–5 MB (~10–40× lighter — decisive for a low-footprint Tauri/web app that *already* ships a
heavy ProseMirror graph); it is mobile-/touch-first and IME-first (relevant given Birta's
CJK history); it is plain tree-shakeable ESM with **no web-worker requirement** and a
CSP-friendly build (Monaco's worker-loader + AMD baggage fights Tauri's CSP); and it has an
official Lezer `@codemirror/lang-markdown` (the same parser family Obsidian trusts). Monaco
*is* essentially VS Code's editor — shipping it standalone re-implements, worse, what VS
Code gives for free. (A `<textarea>` + Shiki overlay is a last-resort fallback only, losing
robust find/IME/folding.)

**Dual-mode architecture: Pattern 1 (serialize↔parse on toggle).** On a ProseMirror base
this is the natural fit and reuses Birta's mature stack. The alternatives are worse fits:
Pattern 2 (live split-pane, both editable) is a bidirectional-model problem, and Pattern 3
(Obsidian's CM6-with-decorations, one document, perfect cursor/undo) **requires *replacing*
ProseMirror** — the NodeViews, table/image editing, block drag-reorder — i.e. "the thing
Birta deliberately did not build." Birta's ProseMirror foundation buys richer structural
editing at the unavoidable price of a source↔rich duality that Obsidian/Typora sidestep by
construction; the right move is to *accept the duality and manage the seam*, not pretend it
away.

**Fidelity (the source view is canonical; WYSIWYG is the projection):**
1. Same pipeline both ways — reuse the existing serializer (WYSIWYG→raw) and the same
   `pureCommonmark`/`gfmFidelity` transformer (raw→WYSIWYG). No second markdown dialect.
2. Raw→raw is trivially byte-exact (editing canonical text, like Obsidian/iA). The only
   lossy risk is WYSIWYG→raw serialization, which the existing minimal-diff + round-trip
   protection (`webview/utils/minimalDiff.ts`) already governs — a mode switch is just an
   extra flush point on the save path Birta already has.
3. **Cursor across the switch is line-level only.** The line map (`shared/lineMap.ts`) is
   *block-granular* (block start lines, code fences as one unit) — it lands the caret on the
   right line/block but gives no character-column correspondence. Accept line-level; don't
   over-invest in character-exact mapping the line map can't provide.
4. **Undo across the boundary:** treat a mode toggle as a single coalesced, undoable
   restore-point ("undo reverses the toggle") rather than merging two histories.

**Reusable today (strong):** the transformer (parse/serialize), the `FormatModule` seam
(`webview/format/` — a source-editor language config is a natural sibling member), the
minimal-diff round-trip engine, `computeLineMap` for switch-in anchoring, the messaging/
sync-seq protocol, and the lazy-chunk discipline. **Missing:** the editor engine itself off
VS Code; precise cursor↔offset mapping (only block-level exists); find/replace, line
numbers, folding, multi-cursor as Birta-owned features; the host raw-edit capability
adapter.

**MVP vs. the parity trap.** MVP = CM6 + `lang-markdown` highlighting + `@codemirror/search`
find/replace + line numbers + line anchoring (matches iA Writer / StackEdit's source side —
genuinely shippable). But the power users most likely to try the desktop app will measure it
against VS Code's *full* text editor (multi-cursor, regex, folding, extensions, git gutter)
and it will fall short for a long time. **Mitigation is positioning, not building:** frame
Birta's raw mode as a *fidelity-preserving companion to the WYSIWYG view* (iA-Writer-style),
not a VS Code text-editor replacement — and on VS Code, keep delegating. Set the parity
expectation deliberately instead of letting users set it for you.

**Effort: Medium.** The hard parts (byte-safe round-trip, parse/serialize, format seam, sync
protocol) already exist and are mature. Net-new work is bounded: wire a lazy CM6 chunk,
build the host raw-edit capability adapter (needed for the multi-surface split anyway), map
the toggle to serialize/parse with a coalesced undo point. No ProseMirror rework. The
largest *ongoing* cost is the parity long-tail, which the plan manages by scope + framing.

---

## 16. Gaps register, inconsistencies, and the meta-risk (planning review)

A step-back review of the whole document. Kept explicit so nothing structural hides behind a
confident tone. **Assessed vs. guessed:** everything below is reasoning over code + research;
none of it is measured (see the meta-risk).

### The meta-risk (most important)
**We have breadth, not validation.** Every conclusion — clean seam, ~70%-there, Bucket-2,
CM6, Tauri — is inference from reading code, not from running anything. The single most
valuable next act is not more analysis but the **afternoon probe**: stand up `dist/webview.js`
in a bare page and implement `HostServices` for *one hard capability — save* — end to end. If
the seam survives contact with real persistence, the thesis largely holds; if not, much
downstream changes. Guard against over-planning a beautiful architecture on an unmeasured base.

### Gaps that are thin or unexamined (ranked)
1. **Persistence / save / external-change per host — highest stakes, thinnest.** This is *why
   Birta exists* (fidelity + never-lose-an-edit), it is Bucket-3 (unshareable), and it's only
   gestured at. `onWillSave`+`waitUntil` has no host-neutral replacement; each host needs its
   own atomic-write + crash-safety + dirty-model + external-change strategy (desktop
   file-watcher vs. the current VS Code document-event model). **Design this before any
   extraction** — it's where the seam most likely leaks and the one property the product
   cannot lose. *(Guessed; needs a dedicated design pass — the natural next deep-dive.)*
2. **Undo ownership + accessibility — editor-quality gaps that could sink a standalone app.**
   Undo is hand-built today (the CustomEditor API gives nothing); off VS Code the core must
   own the whole undo stack and its interaction with save, external changes, and the
   source-toggle. a11y is currently *inherited* through VS Code (`--vscode-*`, focus, screen
   reader); a standalone contenteditable WYSIWYG surface must own it, which is notoriously
   hard. Both only name-checked so far.
3. **Non-document app state + incremental-migration mechanics.** (a) Standalone apps *need*
   state that doesn't exist today — recent files, window layout, session restore, snapshots;
   "no `globalState` usage" actually means "no app-state layer to build on," not pure upside.
   (b) *How* to extract `packages/core` incrementally (strangler-fig) while the extension
   keeps shipping — never described; the risk is a months-long feature freeze.
4. **Cross-surface version & release coordination.** "Edit once, deploy everywhere" assumes
   lockstep, but Writer's surfaces ship as separate artifacts (VSIX / Tauri installer / web
   deploy) and *will* drift. No semver contract for the core package, no release
   orchestration, no answer for "a core change that needs a coordinated host change." A real
   ongoing tax for a solo maintainer.
5. **Lesser but real:** the cloud image/asset model (object storage); Tauri capability/IPC as
   a new trust boundary + auto-update key management; where Harper/proofreading sits
   (core vs. per-app feature module — it's heavy and Node/WASM-coupled); concrete per-surface
   perf budgets once CM6 + a theming layer + a shell are added; RTL/complex-script editing
   (untouched).

### Inconsistencies to reconcile (now flagged inline where they live)
1. **Two web framings coexist.** §0.5(a) says web is cloud-backed and last; §4/§8/§10 still
   carry the extensive *local*-web (FSA/OPFS/two-tier) analysis. **Reconciliation:** the
   local-web analysis is now the *PWA/fallback tier*, not the main web product — the main web
   surface is the cloud service. The §4/§8/§10 findings stay valid but demoted; read them as
   "if we ever did local-web," not "the web plan."
2. **"No workspace" (§4) vs. "build a file browser / open folder" (§6).** Both are true only
   as *"the host defines the root"* — the opened folder becomes the root. Treat that as the
   canonical phrasing; standalone does have a root, just not VS Code's multi-root model.
3. **Difficulty ratings vs. "nothing was measured" (§13).** The Low/Medium/Large ratings
   throughout are directional priors, not estimates. Read as priors; let the probe (and the
   first desktop build) replace them with data before committing calendar.

### High-level takeaways
- The architecture is real and well-positioned; one pattern (**Bucket-2**, §14) unifies
  raw-editing, keybindings, palette, menus, settings. That's the spine.
- **Cost is front-loaded onto Writer's *first* non-VS-Code surface** (desktop), which pays
  the full shell tax (raw editor, file browser, keybinding/settings engines, save model).
  There is no fleet of editors to amortize it against (§0.5c) — so the desktop app must be
  justified on its own merits (a real audience of "Birta without VS Code"), not as factory seed.
- **The two hardest things are the two least designed:** the persistence/data-integrity
  contract, and — now settled — *not* the "what varies across apps" question (answer: the
  portfolio shares brand + tooling, not an editor; Writer's core is shared only across
  Writer's own surfaces).

### Go-forward (revised after the factory deflation)
1. **Design the persistence / save / external-change contract** — the riskiest seam and the
   reason the product exists. This is the next deep-dive.
2. **Run the save-capability probe** — validate the seam against the hardest capability, turn
   priors into measurements.
3. **In parallel, Rung 0 free reach** (Open VSX + a vscode.dev web-extension scope) — reach +
   demand-validation, independent of the extraction.
4. **Only then** extract `packages/core` incrementally (strangler-fig), keeping the extension
   shipping, justified by the two real surfaces (extension + desktop).
5. **Harvest — don't design — the portfolio playbook** (brand/release/CI templates) from what
   actually recurs across Writer and retire-early.
