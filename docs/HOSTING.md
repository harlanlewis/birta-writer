# Hosting the editor

What a page has to be for `dist/webview.js` to run in it, and what that page has to answer. This is the contract every surface already meets: the extension's webview page (`src/webviewHtml.ts`), Birta Writer for Mac's page (`mac/Resources/index.html`), and every harness page under `e2e/`. It is written down here because a fourth shape needs it, an application that is not an editor putting the editor in a frame of its own. `e2e/frameHost/` is that shape, built and run: `index.html` there is the application, `editor.html` is the frame page, and `checks.mjs` holds every claim below that a browser can check.

The editor ships one bundle and one composition root. What differs per host is declared, never forked, and `shared/hostProfile.ts` is where a host declares it; AGENTS.md ("Hosts other than VS Code") has the rules. This document is the mechanics.

## The two shapes

In a frame, the editor gets a page of its own, and the page is the editor's. The host application talks to it over `postMessage` and never reaches into it. Everything the editor assumes about owning a page (body classes as a state channel, custom properties on the root, document-level listeners, one global `[hidden]` rule) holds inside the frame and touches nothing outside it. This is the supported shape, and the rest of this document describes it.

Mounted inline, in a page the host also draws in, none of that holds. The editor would share a body, a root and a document with chrome it knows nothing about, and the count of places where that matters has not been classified (MAR-450). Nothing here should be read as support for it.

## The frame page

Everything the frame page has to carry, in the order it has to be there. `e2e/frameHost/editor.html` is the whole of it and is short.

1. The palette. Link `dist/hostPalette.css` before `dist/webview.css`. The bundle's stylesheets use `--vscode-*` variables throughout, and inside VS Code the workbench injects them; any other host links this file instead. The theme is chosen by a class on `body`, `vscode-light` or `vscode-dark`.
2. The bundle's stylesheet, `dist/webview.css`.
3. The boot blob, `window.__i18n`, set by an inline script that runs before the module does. The `host` field is the profile, below, and is the one field a page that is not VS Code should always set. Everything else is the settings snapshot, one field per `birta.*` setting, and every field has a default: `translations` absent is English, `isMac` absent prints Ctrl chords, `toolbar` absent is the default layout. `e2e/frameHost/editor.html` boots on the profile alone. The type is the `Window.__i18n` declaration in `webview/i18n/index.ts`.
4. `acquireVsCodeApi`, a global function defined before the module runs, returning an object with `postMessage`, `getState` and `setState`. The bundle calls it once. In a frame, `postMessage` hands the message to the parent window, and `getState` and `setState` hold the view-state bag (folds, scroll, table widths, the formatting row's expanded flag) for as long as the host wants them kept.
5. Two elements: `<div class="editor-topbar"></div>` for the bar, and `<div id="editor"></div>` for the document. The bar's element is optional and the document's is not.
6. The bundle, as `<script type="module" src=".../dist/webview.js">`, at a URL that ends in `dist/webview.js`. Sibling assets (the KaTeX stylesheet, the lazy chunks) are located from that script element's URL rather than from `import.meta.url`, because chunk splitting moves modules between `dist/` and `dist/chunks/`; `katexCssHref` in `webview/utils/katexLoader.ts` has the argument.

A content-security-policy is the host's choice, and the frame page in `e2e/frameHost` carries the smallest one the bundle runs under: scripts from its own origin, `style-src 'unsafe-inline'` (highlight rules are injected on first use), `worker-src blob:` (the save pipeline's verify worker starts from a Blob URL, `webview/utils/verifyOracle.ts`), and `data:` for images and fonts, which are inlined. The extension's policy in `src/webviewHtml.ts` is the reference for what a feature adds: `'wasm-unsafe-eval'` for the PlantUML engine, and the provider hosts in `shared/embedProviders.ts` for embed cards.

What to serve: `dist/webview.js`, `dist/webview.css`, `dist/hostPalette.css`, `dist/katex.css` and `dist/chunks/`. `pnpm build` produces them; `node esbuild.mjs --production` produces the minified set the extension ships. Nothing under `dist/` is published anywhere on its own yet; the VSIX and the Mac app each carry a copy.

## The profile

`window.__i18n.host` is one object with three lists: `capabilities`, `arrangements` and `shortcuts`. A capability names something the host provides that chrome can offer: a text editor to switch to, an image store, a sidebar, a spelling engine. An arrangement is a layout choice where both answers offer the same controls. A shortcut is a key the host binds itself, for the cheatsheet to print. `shared/hostProfile.ts` lists all three vocabularies with the reasoning for each member.

Absent means the VS Code profile. A page that sets no `host` field gets every capability VS Code has, and the editor then asks the host for all of them: it posts the document out to be linted, offers Insert Image and posts the bytes, builds the sidebar, offers Edit Raw Markdown. An embedder that declares nothing is therefore asked questions it cannot answer. Declare an explicit empty profile, `{ capabilities: [], arrangements: [], shortcuts: [] }`, and add a capability only when the host answers its messages. Under the empty profile the editor builds every control of its own and none that names the host; `e2e/frameHost` holds that in both directions.

## The protocol

Every message crosses as `postMessage`, typed in `shared/messages.ts`: `ToExtensionMessage` is what the editor posts, `ToWebviewMessage` is what it receives. The names say extension because that was the first host; nothing in them is specific to it. A host answers a few of them, consumes a few more, and can leave the rest alone.

The two request-and-reply pairs a host takes part in, one in each direction:

| Request | Reply | What it is |
| --- | --- | --- |
| `ready`, from the editor | `init { content, syncVersion }`, from the host | The document, once. `syncVersion` is the host's version number for these bytes; start at 1 |
| `flushSave { id }`, from the host | `flushResult { id, content, seq, baseSyncVersion }`, from the editor | The freshest bytes, serialized now, ahead of any pending `update`. Send the request before persisting on the user's command and persist what comes back |

What a host consumes:

| The editor posts | When | What to do with it |
| --- | --- | --- |
| `update { content, seq, baseSyncVersion }` | On a typing pause, and at a bounded wait during continuous typing (`webview/syncScheduler.ts`) | Hold it as the document's current bytes. In VS Code this is what hot exit backs up, so it is the crash-safety window, and a host that persists on its own cadence persists these |
| `focusState { focused }` | Focus enters or leaves the frame | Optional. VS Code gates document-mutating keybindings on it |
| `wordCount { doc, selection }` | After an edit, debounced | Optional. A status line, if the host has one |
| `viewState { state }` | The view-state bag changed | Optional. VS Code keeps the last bag per document in memory and hands it back in `init` as `viewState` |

What a host sends, when it wants to:

| The host sends | Effect |
| --- | --- |
| `externalUpdate { content, syncVersion }` | Replaces the document with the host's bytes, keeping the caret where a diff can keep it. `syncVersion` must be higher than the last; the editor echoes it as `baseSyncVersion` on every later `update`, so the host can drop an update serialized against bytes it has since replaced |
| `setReadOnly { readOnly }` | Locks or unlocks every way the document can change (`webview/readOnly.ts`, three layers). `__i18n.readOnly` seeds the same mode at boot |
| `scrollToLine { line, column? }` | Places the caret at a source line |
| `editorCommand { command }` | Runs an editor command by id (`shared/editorCommands.ts`), which is how a host's own menu or key reaches the editor |
| `setFontSize`, `setFontFamily`, `setContentWidth`, `setTocVisibility`, `toolbarConfig`, and the other `set*` and `*Changed` messages | A setting changed under the editor while it is open. Each corresponds to one field of the boot blob, and a host that never changes a setting never sends one |

Ordering holds across all of it. Every content message the editor posts carries a monotonic `seq`, and a host must drop an `update` whose `seq` is below the last `flushResult` it applied, or a slow sync can revert a fresher save. `shared/saveFlushController.ts` is the host-agnostic implementation of that guard, with the stale check and an injectable timeout, and is what the extension runs; a second host is meant to reuse it rather than rewrite it.

Everything else the editor posts is a request for something the host provides, and each carries an `id` to correlate the reply. A host that has the thing declares the capability and answers; a host that does not declare it is never asked, with two exceptions today. `getLinkTargetSuggestions` and `resolveLinkTarget` are posted when a link target is typed that looks like a path or a `[[wiki link]]`, because no capability names a workspace to resolve against; unanswered, the suggestion menu shows nothing and the caller drops its callback after a short wait (`webview/components/pathLink/linkTargetComplete.ts`). Every other sender bounds its own wait the same way and degrades to the answer it would give for a miss: a link is kept as typed, a card is not drawn, a picker is treated as cancelled. `uploadImage` is the one whose degradation was wrong for a host with no store, and it is now refused in place before anything is posted (`handleImageFile` in `webview/imageUpload.ts`).

## What the frame boundary takes

Keystrokes inside the frame stay inside it. The editor handles what it binds, ProseMirror handles the rest of the text, and a chord neither of them claims goes to the browser's own defaults. Cmd+S is the one that matters: inside VS Code the workbench sees it, inside the Mac app the menu does, and inside a frame in a browser it opens the browser's Save Page dialog. The `shortcuts` list in the profile prints a host's keys in the cheatsheet and does nothing else; a host that wants a key inside the frame to reach it has no message for that yet, and this is the first thing an embedder will meet.

Focus stays where the host put it. Boot does not move focus into the frame when a field of the host's own already has it (`e2e/frameHost` holds this), so a page can put the editor below a form without the form losing its cursor.

Inbound messages are trusted. The editor listens on its own window for `message` events and applies whatever arrives, from any source, because inside VS Code only the extension can post to it. A frame in a web page can be posted to by any script on that page or in any other frame with a reference to it; treat the frame page as part of the host's own trust boundary rather than as a sandbox.

## What is not covered

- Persisting across a reload. The view-state bag lives in the stub's `getState` and `setState`, and a stub that forgets loses folds, scroll and table widths on every load. The document itself is the host's from the first `update` on. What a host that owns a file rather than a variable has to do about saving, external edits and conflicts is the contract MAR-226 is meant to write, and neither shipped host's answer is portable.
- A lighter build for reading. The bundle is sized for an application that opens a document; a read-only render on a page that mostly does something else pays for an editor it never uses. There is no separate entry point for that today.
- A host-side library. The frame page and the message handling in `e2e/frameHost/index.html` are the reference, copied rather than imported. Whether that becomes a shipped script is a decision for the first consumer outside this repository (MAR-447).
