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
   line sync). This directly affects the "safety net, not a wall" north star.
3. **Multi-document + file browser + local-link navigation** — Birta edits exactly one file
   and asks VS Code to open any other. Needs a tab model, a file-explorer tree,
   "open folder," and in-app link-follow.
4. **Command palette + keybindings + `when`-context system** — 99 commands, 29 keybindings,
   87 palette entries, 149 `when` clauses, 88 generated editor-actions
   (`shared/editorCommands.ts`). Needs a command registry, palette UI, a rebindable-keymap
   engine with context evaluation, and a shortcuts-editor UI. (ProseMirror typing chords
   port for free; the *command surface* invoking them does not.)

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

## 11. Recommended sequence (MVP-first)

Framing decision up front: **"the editor, everywhere"** (the WYSIWYG core is the product;
VS Code was just the first shell; each surface re-provides only the host minimum) — *not*
"a full standalone app with file browser/sync/accounts" (that risks becoming Obsidian,
which Birta explicitly isn't). Pick the former as MVP.

1. **Extract `packages/core` + `packages/editor` behind the existing message seam.** Keep
   the VS Code extension green throughout — it's the regression oracle. Add the host-boundary
   test. Wrap `asWebviewUri`/`_imageUriMaps` as `toDisplayUrl`/`toStoredPath` and inject the
   root via `_workspaceRootFor` first — those are the two invasive seams.
2. **Desktop on Tauri v2, second host.** It preserves privacy/offline/local-file with the
   *least new invention* (no accounts, no CSP-as-security-boundary, no FSA gymnastics; native
   fs + watcher covers external-change detection). This validates the core extraction against
   a real second host. Do the theming token set + settings store/UI here (both reused later).
3. **Web local-only, third.** Reuse the desktop core; add FSA (Chromium) + OPFS + PWA +
   served-page-privacy work + Harper-in-browser + the two-tier fallback. Accept the Safari/
   Firefox degradation explicitly.
4. **Sync / accounts / monetization, last, only if demanded** — this is where brand risk and
   ongoing cost concentrate.

Throughout, apply Birta's existing investment ordering as the surface tie-breaker:
**fidelity must hold identically on all three before any surface adds a surface-specific
feature.** A web-only feature that can't preserve byte-fidelity is off-thesis on its face.

---

## 12. Open decisions for the maintainer

1. **Product framing:** "the editor, everywhere" vs "a standalone app"? (Recommend the former.)
2. **Surface order:** desktop-first (recommended, cheapest brand-preservation) or web-first
   (bigger reach, harder promises)?
3. **Desktop runtime:** commit to Tauri v2 (accept Linux WebKitGTK QA) or play safe on Electron?
4. **Web sync:** local-only forever, or optional sync backend (and if so, the privacy contract)?
5. **Accounts:** never / sync-only / required? (Recommend never-or-sync-only.)
6. **Monetization** in light of the FSL 2-year Apache conversion.
7. **Server-or-not for web:** accept the two-tier sandbox reality, or run a backend (which
   restores fs/watch/workspace but changes what Birta *is*)?
8. **Identity sequencing:** does the drawn wordmark / glyph land before or after the first
   standalone surface ships?
```
