# What the extension half needs from Node

The editor's two halves have different relationships with their host. `webview/` is a browser page under every host it has ever had, and its bundle already builds `platform: browser` with no Node import in it: the only external reference a metafile build records for it is a `data:` URI for an inlined icon. `src/` has never run anywhere but Node, because a VS Code extension with a `main` entry always has one.

This document is the audit of what that second half costs if the host stops being Node, which is the case of a `browser` entry point: the VS Code web extension host, a WebWorker with no Node in it, running the extension on `vscode.dev` and `github.dev`.

It is analysis, not a plan and not a promise. Nothing here is support for a web build, no `browser` entry point exists, and no product code changed to produce it. [`HOSTING.md`](HOSTING.md) is the shipped contract for a host that is not VS Code, and it is about the page rather than the extension; [`PAGE_OWNERSHIP.md`](PAGE_OWNERSHIP.md) is the same kind of audit one layer down, over what the editor's page assumes. This one sits beside them and covers the half neither reaches.

## Where the numbers are

`node scripts/audit-node-couplings.mjs` is the enumeration, and it is the only place a count of any of this is written down. Nothing in this document prints one, for the reason AGENTS.md gives: a measured count starts going stale the moment it is typed.

| Mode | What it prints |
| --- | --- |
| no flag | the totals by verdict and by capability |
| `--by-capability` | the same, with every coupling grouped under the feature it belongs to |
| `--by-kind` | the same, grouped by the shape that found it |
| `--list` | every coupling with its file, line, verdict and capability |
| `--json` | the whole enumeration as data |
| `--check` | nothing, unless the audit has stopped being true |

The argument for each verdict lives in the rule table inside that script, next to the rule. This document carries the shape of the answer and the decisions it turns on; it does not restate the rules.

### Why it is a script and not a list

The script is two halves kept apart on purpose, the same construction `audit-page-ownership.mjs` uses. The scan finds candidate sites by shape alone and knows nothing about the verdicts: an import of a Node builtin, a Node global, a `.fsPath`, a `file:` URL or scheme test, and the two `fetch` shapes a browser treats differently from Node's. A rule table then has to recognise each one, and whatever no rule recognises is residue, printed by name and failing `--check`.

That separation is what keeps "every coupling has a verdict" from being true by construction. It earned its keep on the first run, which raised `process.kill` in the agent bridge as unclassified: a Node global that no import names and that a scan for `node:` specifiers would never have found.

Two things in `--check` are worth knowing about, because both exist for failures that are silent rather than loud.

The first is the cross-check against the built bundle. A scan of this repository cannot see a coupling inside a dependency, and there is one: `harper.js` reaches for `fs` from its own wasm loader, guarded by a runtime test that is false in a worker but present in the module either way. So when a metafile build has left a `dist/extension.meta.json`, `--check` reads the builtins the emitted bundle actually requires and holds every one against what the source scan found. Anything left over has to be named in `DEPENDENCY_COUPLINGS` with a reason, and an entry there whose module has left the bundle fails too, so the list cannot go on claiming a coupling that is gone. With no metafile present it says so by name rather than passing in silence, because a check that skips quietly reads exactly like a clean bill.

The second is a pin on one line of product code, described in the next section. It is held by its subject rather than by its line number, and `shared/__tests__/nodeCouplingsAudit.test.ts` feeds it a source that has lost the gate and demands a complaint, because a guard that cannot fail is decoration.

## The three verdicts

A verdict is a claim about what a coupling does under a `browser` entry point. It is not a judgement of the code, which is right for the host it has.

| Verdict | What it means |
| --- | --- |
| `survives` | A web build keeps the behaviour at the cost of at most a mechanical substitution: Web Crypto for Node crypto, `TextDecoder` for `Buffer`, posix string arithmetic over `uri.path` for `path` |
| `degrades` | The capability is still there and something is gone: a guarantee, a case, a form of input that stops resolving. This is the bucket that matters, because every one of these is a place the editor would go on looking like it worked |
| `drops` | A web build cannot have this. The capability is absent and has to be gated off rather than degraded |

The shape of the answer, in magnitudes rather than figures. The `drops` bucket is small enough to list in full and is listed in full. The `degrades` bucket is the large one, and most of it is a single tax paid in many places rather than many separate problems: `fsPath` and the path arithmetic downstream of it. What `survives` is smaller than the import list suggests, and smaller than it looks, because the audit counts a coupling at its site and a site that survives may sit in a feature that does not.

## The gate in front of all of it

One line decides more than every import in this document put together. The custom editor's own entry point refuses any document whose scheme is not `file` and answers it with an empty page:

```ts
// src/MarkdownEditorProvider.ts, resolveCustomTextEditor
if (document.uri.scheme !== 'file') {
    webviewPanel.webview.html = '<!DOCTYPE html><html><body></body></html>';
    return;
}
```

On a web host every document has some other scheme, so a `browser` entry point that shipped without changing this would ship a blank editor, activate cleanly, and report nothing. The gate is deliberate and its comment says what it is for: a git diff or another virtual URI gets a blank page rather than a disposed panel, because disposing crashes the diff engine's `claimWebview`. So the change a web build needs is not a deletion but a narrowing, from "not `file`" to the schemes that genuinely have no editor to offer, and that narrowing is a decision about which virtual schemes the editor claims rather than a mechanical edit.

`checkProviderGate` in the audit script pins it, by finding the entry point and reading its opening rather than by citing a line number, so the pin survives the file moving under it and fails if the gate changes.

## What a `browser` entry point is, and what the types will not tell you

The manifest half is small and is readable here rather than guessed at. `package.json` gains a `browser` field beside `main`; `vsce` requires `activationEvents` alongside it exactly as it does for `main`, which this manifest already has. `vsce`'s own `deduceExtensionKinds` returns `['workspace', 'web']` for a manifest carrying both, and its `getExtensionKind` adds `web` to an explicitly declared `extensionKind` rather than replacing it, so the declaration in this manifest would gain a kind and lose none. The build half is a second esbuild config beside the extension's, `platform: 'browser'`, with the same `external: ['vscode']`; the webview's config is already that shape, so the pattern is in the file.

What cannot be read here is the part that decides the answer. `@types/vscode` draws no distinction at any of the APIs this extension uses between what a desktop extension host offers and what a web one does: `createTerminal`, `SecretStorage`, `registerUriHandler`, `authentication` and `createFileSystemWatcher` all typecheck identically in both, and a sweep of the declaration file for a note saying otherwise finds none. The only API that names the difference at all is `env.appHost`, documented as `'desktop'` against `'github.dev'`, `'codespaces'` or `'web'`, and `env.uiKind`. So a web build of this extension would typecheck, bundle, and then fail at runtime, and the compiler would have had nothing to say at any point. Every platform claim in this document about what a web extension host does or does not provide is read from the platform's documented behaviour and from the Fetch standard, not measured, because there is nothing here to measure it with.

## The verdict per capability

| Capability | Verdict | What decides it |
| --- | --- | --- |
| Proofreading | `degrades` | Harper is loaded extension-side from a `file:` URL built out of `__dirname`, which a worker does not have. `harper.js` takes a URL and nothing else, so the web forms are an `https` URL under `extensionUri` or the package's own inlined `data:` export, and the inlined one is a very large module. The failure today is quiet by design: a lint request that throws is answered with empty results per block and one console line, so an engine that never loaded looks exactly like a document with nothing wrong in it |
| Paste unfurl and link cards | `drops` | Two independent reasons, and the second is the one that settles it. The SSRF guard's DNS lookup is the only thing between a publicly registered hostname that resolves into private space and a request from inside the reader's network, and a browser exposes no DNS and no hook below `fetch` that could see a resolved address. Before that matters, the feature is already gone: the fetch reads an arbitrary page the reader pasted, and a cross-origin response without CORS headers is unreadable, so there is no title to extract from almost any URL. The per-hop guard goes too, because a browser's manual-redirect response is opaque and carries no readable `Location` |
| Embed cards | `degrades`, with one unknown | The oEmbed fetch is pinned to a provider's own host and refuses any 3xx, and a browser's opaque redirect fails the same branch, so the redirect rule holds by a different mechanism. What is not known here is whether each pinned oEmbed host sends CORS headers at all, and that is what decides whether the caption resolves or the card renders without one |
| Connector cards | `degrades`, with two unknowns | Same fetch shape and same opaque-redirect equivalence, and the credential still never crosses a redirect. `SecretStorage` and `authentication` exist in the web API surface. Two things do not port as written: the OAuth callback is a hardcoded `vscode://` URI where a web host needs `env.asExternalUri` over `env.uriScheme`, and a provider requires its redirect URIs to be pre-registered, which a per-host redirect and a self-hosted origin make a registration problem rather than a code one. `timingSafeEqual` has no Web Crypto counterpart, so the constant-time `state` comparison stops being something the platform vouches for and becomes something the code has to argue for |
| Image save | `degrades` | The writes already go through `vscode.workspace.fs` and are URI-based. Three things are not: the absolute-path branch of the location setting, the home-directory fallback taken for any document that is not on disk (which on the web is every document), and the MD5 dedup, for which `crypto.subtle` offers no MD5. The dedup digest is compared in memory and written nowhere, so changing the algorithm preserves the behaviour. The sharpest site is the relative link the saved image is written into the file as, which is computed from two `fsPath` strings: everywhere else a wrong `fsPath` costs a failed lookup, and here it would cost a link in the user's document |
| External change detection | `survives` | The audit's one genuinely good news item, and it contradicts the expectation this work started from. Nothing in `src/` reads `mtime` or `size` from a `stat`, anywhere: `stat` is used only as an existence and type probe. Mechanism A is a pure `onDidChangeTextDocument` pipeline whose echo test is a whole-string comparison against a cached baseline, with no filesystem in it at all |
| Disk drift | `survives` as code, quiet as a feature | One `path.basename(uri.fsPath)` inside a watcher pattern is the whole coupling, and the tree already spells the portable form elsewhere. What changes is not the code but the premise: a workspace with no external writers gives the watcher nothing to fire on, so the advisory badge is correct and silent. The comparison is a full byte read against the buffer, so a provider that did not round-trip bytes identically would show a permanent badge on every dirty document; the controller never writes, so the cost of that would be a wrong badge rather than a lost byte |
| Agent bridge | `drops` in half, `survives` in half | The split runs along a seam the code already has. The background and terminal routes need a spawned process and a shell the host does not have, and the harness probe that reads a binary's `--help` has no binary to ask. The chat and clipboard routes are `executeCommand` and `env.clipboard` and need nothing. The language-model tool needs nothing either, and is already guarded on the API's presence. The probe's own doctrine is that an unanswered probe reports no capabilities and the user's template runs unchanged, so that half has a documented floor rather than a failure |
| HTML export | `survives` | Already the closest thing in the extension to web-clean: the write is `workspace.fs.writeFile` with a `TextEncoder`, the save dialog's `defaultUri` is already scheme-guarded, and the only `path` use is `basename` over a name, at two of three sites already spelled against `target.path` |
| Link resolution and suggestions | `degrades` | The resolver and the Logseq detector are already `vscode`-free with injected IO, which is most of the work. Two hazards are specific rather than general: the resolver reads `path.sep`, and a virtual path is slash-separated whatever the host OS is, so on a Windows host `path.sep` is right for a local workspace and wrong for a remote one; and it leans on `path.resolve` discarding its base for an absolute argument, which `Uri.joinPath` does not do. The suggestion provider rebuilds a `file:` URI from string math to list a directory and swallows the failure into an empty list, which is the silent shape: the completions stop appearing with nothing logged |
| Keyboard chords in the page | `drops` | The only `node:fs` in the tree, reading the user's `keybindings.json` and profile manifest out of the user-data directory, which no provider serves and no VS Code API exposes. It is also the cheapest thing here to give up: the module is built around the failure already, an unanswerable lookup returns nothing rather than a guess, and the page prints a label with no chord beside it |
| Custom CSS and JS | `degrades` | The `~` and absolute forms of the setting have no meaning without a local disk, and the function already returns `undefined` for a base it cannot find, so the workspace-relative and `${workspaceFolder}` forms are what would be left |
| Feedback report | `degrades` | One line of the environment block reads `process.platform` and `process.arch`. The report is worth sending with that line absent or approximate |

Two capabilities are absent from that table because the audit found no coupling in them at all, which is worth stating rather than leaving to inference: the settings seam, whose keys are all `window` or `application` scope with no `machine` scope anywhere, and the webview protocol, whose extension half is `postMessage` and `asWebviewUri`.

## Three things that are not Node and behave differently anyway

The audit deliberately collects two `fetch` shapes alongside the Node imports, because they are Node couplings that are not import-shaped, and both fail quietly rather than loudly.

A forbidden header. `user-agent` is a forbidden header name in the Fetch standard: Node's `fetch` sends it and a browser's drops it. All three outbound fetch sites set one, and the comment beside the unfurl's says some hosts serve a leaner page or refuse without it, which makes the drop a change to what comes back rather than a cosmetic one.

An opaque redirect. In Node a `redirect: "manual"` response carries a readable `Location`; in a browser it is an opaque filtered response with status 0 and no readable headers. For the two sites that treat any 3xx as a refusal this is equivalence by another mechanism and the outcome is identical. For the unfurl loop, whose whole design is to re-run the guard on each hop, there is no expressible form: following with `redirect: "follow"` would check the first URL and let the browser visit hops nothing vetted, which is a weaker guard rather than the same one.

And CORS, which is not in the audit because it is a property of the endpoint rather than of this tree. It is the fact that decides three of the rows above, and it is the reason the unfurl verdict is `drops` rather than `degrades`: the guard's loss would be the interesting problem if the feature still worked, and it does not get that far.

## What a build would change

Four things, and only the last is open-ended. `package.json` gains `browser` beside `main`, with `activationEvents` already present. `esbuild.mjs` gains a second extension config at `platform: 'browser'`, alongside the Node one, which stays. `harper.js`'s dynamic `import("fs")` needs stubbing or aliasing at the bundler, because it is statically present in the module even though its runtime guard is false in a worker, and the elkjs and PlantUML plugins in that file are the worked examples of how this repository does that. And every `drops` and `degrades` row above needs a decision, which is the part that is not a build change.

## Residue

What the audit could not reach, stated so it is not mistaken for absence.

A scheme test's real verdict is decided by what its branch does, and the scan reads one line at a time. It takes the coupling at the test, the way the page-ownership audit takes a listener's verdict at its registration rather than from its handler body. Most of those branches are ordinary fallbacks and one of them is the provider's own blank page, which is why that one is pinned separately rather than left to the family.

`fsPath` is judged uniformly and its consequences are not uniform. Several sites use it only as a map key, where `uri.toString()` would be a strict improvement and nothing is at risk; one writes its output into the user's document. The audit cannot tell those apart from a line, so it counts the coupling and this paragraph carries the difference.

No claim here about the web extension host is measured. There is no web build to run and no harness that launches one, so every platform statement is read from documented behaviour and from the Fetch standard. The three that would most change the answer if they are wrong: whether a worker can fetch its own extension resources from `extensionUri`, whether each pinned provider host sends CORS headers, and whether a `vscode.dev` filesystem provider emits watcher events for a change made outside the session.

The scan stops at `src/`, `shared/` and `packages/`. `webview/` is out by construction, since it is a browser page under every host it has, and the measurement that says so is `dist/webview.meta.json` after a metafile build rather than anything in this document.

Third-party code is out of the scan, and the cross-check against the built bundle is the only instrument that reaches it. It sees what the bundle requires, not what a dependency would do given a different input, so a package that grows a Node coupling on a code path this build never takes would not appear.

That cross-check is also half-blind in one direction, and the blindness is on the entry it was written for. It can raise a builtin that nothing accounts for, and it can raise a recorded dependency coupling that has left the bundle, but only where the source does not import that module too. `fs` is both `harper.js`'s coupling and `keybindings.ts`'s import, so a bundle requiring `fs` proves nothing about `harper.js`, and the staleness arm has to stand down for it. A test asserts that it stands down, so the exemption is stated rather than mistaken for coverage.
