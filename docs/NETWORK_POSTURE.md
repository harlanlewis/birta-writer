# Network posture: what Birta sends, on whose consent, and under what invariants

Status: a record of live behavior and directed work, not exploration.

This document owns the network and consent story: what ships today (`birta.network.enabled`, paste-unfurl, embeds, the GitHub connector), and the directed design ahead of it (the rest of MAR-198's connector roster).

All of it is checkable. Where it describes shipped behavior it is a fact about the tree. Where it describes work MAR-198 has not reached, it is directed but unbuilt, and says so.

---

## 1. The escalation ladder

Every network capability sits on one rung. The rungs are ordered by what leaves the machine, which is the only ordering that matters to the privacy claim. Conflating them is how "we already do network things" becomes an argument for something categorically heavier.

| Rung | What leaves | Status | Examples |
|---|---|---|---|
| 0. Nothing | No outbound request at all | Shipped, and the default. `birta.network.enabled` ships `false`; with it off the editor makes no outbound request | Everything, out of the box |
| 0b. A URL you send yourself | Nothing, from Birta. It composes text and hands a URL to the host. The request is the user's browser or mail client, under their identity, against a draft they can still edit | Shipped | Send Feedback (`birta.sendFeedback`); following a link in a document; What's New (`birta.editor.openWhatsNew`) |
| 1. A URL you typed | The URL, to its own host | Shipped | Paste-unfurl; URL embed cards |
| 2. A URL and your credential | The URL and a per-provider token, to that provider's pinned hosts | Shipped for GitHub (MAR-198); every other provider directed, not built | GitHub repository, issue and pull-request cards; Jira, Asana and Figma still to come |
| 3. Your document content | The document itself | Not decided, not designed, and gated on an open scope question | The publish loop (MAR-232), any cloud or sync surface |

### Rung 1 today: two features, and only one of them writes to the file

Paste-unfurl contacts the host of the bare URL you pasted, and no other host, to read that page's title. It writes. The fetched title arrives as an offer at the link, and nothing changes in the file until the user accepts it; `birta.pasteUnfurl.autoApply` ships `false`, so acceptance is explicit.

URL embed cards contact the recognized provider's own pinned hosts, and ask that provider's own oEmbed endpoint for the title shown on the card's caption. They never write: a card is a rendering of the plain link already in the file. The metadata request is made extension-side, cached in memory for the session, and its URL is rebuilt from validated parts rather than taken from the document (invariant 6). One card contacts nothing at all: the GitHub card is derived from the URL text.

`shared/embedProviders.ts` enumerates the hosts an embed card can reach, and the same table generates the webview's content-security-policy grants.

### Rung 0 includes diagram rendering, and that is not free by default

Mermaid, KaTeX and PlantUML all render on this machine, with no request of any kind. For PlantUML that is a property worth stating explicitly, because the ordinary way to render it is the opposite: upstream PlantUML resolves `!theme <name>` and `!include <url>` over HTTP, and most editor integrations post the diagram source to a PlantUML server. Either would put *document content* on the wire, which is rung 3 (the rung that is not decided and not designed) rather than rung 1, no matter how routine it looks.

We took neither. The engine is a WebAssembly build compiled without its remote-fetch feature, bundled into the extension. A document containing `!theme spacelab` therefore fails closed with the engine's own "remote fetch disabled" and the user sees that as the diagram's error text. This is the useful invariant: a document cannot make the editor fetch anything by containing a diagram, whatever it contains, and whatever `birta.network.enabled` is set to. Pinned by `e2e/plantUmlRender`, which renders four diagrams, one of them explicitly asking for a remote theme, and asserts the page issued no request beyond its own bundle.

One CSP directive pays for this. The webview's `script-src` carries `'wasm-unsafe-eval'`, without which Blink refuses to compile the engine. It is not `'unsafe-eval'`: it permits WebAssembly compilation and nothing else, adds no script source (a nonce is still required to run anything), and grants no network reach: `default-src 'none'` still covers `connect-src`, so the webview cannot fetch. The engine is inlined into its own lazy chunk rather than fetched from `dist/` specifically so that stays true.

### Rungs 1 and 2 never upload document content

That is what makes rung 3 a category change rather than one more checkbox: publishing would need its own consent architecture, not one more toggle on this one. Rung 2 existing strengthens that rather than weakening it.

### Rung 2 is where identity enters

Not a Birta account, a third-party one. The distinction is real and worth defending, but "Birta has no auth" stopped being true the moment MAR-198 was directed.

#### Rung 2 today: one connector, and four gates in front of it

GitHub is the only connected service. It authenticates through VS Code's own GitHub provider (`vscode.authentication.getSession`), which is the reason it could ship first: no application to register, no client secret to hide inside a distributed extension, and no token for the user to paste or for us to refresh. Connected, a GitHub repository, issue or pull-request link shows what its URL cannot know: the pull request's title and whether it merged, the issue's state, the repository's description and whether it is private.

Four gates sit in front of a single credentialed request, and all four must be open: `birta.network.enabled`, then `birta.embeds.enabled`, then `birta.embeds.providers.github`, then the connection itself. The innermost one deserves its own sentence, because it is the one a reader would not guess. A VS Code GitHub session signed in for some other extension's sake is not consent for Birta to make requests with it: the connection is a record Birta writes when the user runs "Birta: Connect Service…" or clicks a locked card's connect affordance, and without that record a card answers `locked` and no request is made. Deleting it is what "Birta: Disconnect Service…" does.

A card that cannot be built says which of the three reasons applies, because only two of them are worth acting on: never connected, a grant the provider no longer honours, or a request that failed. It never degrades to a blank card. `src/__tests__/connectorService.test.ts` pins the gates, the states, and the rule that no reply crossing to the webview may contain the credential; `src/__tests__/fetchCard.test.ts` pins the pinned-host and redirect behavior at the one site that attaches a token.

The other two rungs of the auth ergonomics ladder, OAuth with PKCE through a URI handler and pasted personal access tokens, are shaped for in `shared/connectors.ts` and have no provider behind them yet. Neither is written, because a strategy nothing has run is not a strategy.

### Rung 0b is a rung, not a footnote

It looks like network activity to a user watching their browser open, and it is not network activity by Birta. Keeping it separate is what lets the claim stay literally true: with `birta.network.enabled` off, the extension makes no outbound request, and a feedback report or a followed link does not falsify that.

It also names the line that must not be crossed. The moment Birta itself `fetch`es the report instead of composing a URL, it is a different product with a different promise.

### Telemetry, and why the feedback command is not it

The distinction is not consent. It is who makes the request, and who can see what it says.

| | Telemetry | Rung 0b (Send Feedback) |
|---|---|---|
| Initiates | The software, continuously | The user, once, deliberately |
| Payload | Whatever the vendor chose | Exactly what they typed, and they read all of it |
| Visible before sending | No | It is the form they are looking at |
| Identity | Install or device ID | None, or their own GitHub account or mail address, by their choice |
| Default | On, with an opt-out | Absent until invoked |
| Network actor | The software | The user's browser |

Four invariants keep it on that side of the line. All four are enforced in `src/feedback/sendFeedback.ts` and pinned by `src/__tests__/sendFeedback.test.ts`.

10. It never solicits. No prompt, no nag, no after-N-days toast, no rating request. The command is reachable from the palette and nowhere else. Solicitation is what turns opt-in back into telemetry, and a "quick survey?" popup would breach this rung as surely as a `fetch` would.
11. Document content, file paths, and workspace names never enter the payload, by construction, because the composer is never given them. Settings are reported by key. A value is included only when its shape proves it cannot carry a path or a sentence (`isReportableValue` in `compose.ts`), and anything else reads "customized".
12. The clipboard is always offered, so the whole feature works with no browser, no account, and no network of any kind. It is also the fallback for the other two destinations: if a draft cannot be opened, or the report was too long to fit in a URL, the full text is copied there and Birta says so. It is not written when a destination the user chose worked, because copying every time would silently destroy whatever they had on their clipboard.
13. Nothing opens unannounced, and no destination costs more than it says. The last step names each destination and what it asks of the user: a GitHub issue needs a GitHub account, mail needs none, the clipboard needs nothing at all. Someone without a GitHub account learns that here, rather than at a login wall holding the report they just wrote.

---

## 2. The invariants

These come from shipped work (MAR-179, MAR-199) and from MAR-198's directed design. They are stated here once so that no future capability re-derives them, and so a new surface knows what it must re-provide.

### Consent

1. Layered, and the outermost layer ships off: master network switch, then capability toggle (embeds, unfurl), then per-provider, then per-service connect. Only the master ships off. `birta.pasteUnfurl.enabled` and `birta.embeds.enabled` both ship on, beneath it, so turning the master on makes both live at once and each is then turned off individually. The default-quiet guarantee rests on the master alone. A master gates its children and never overwrites them, so re-enabling restores prior child choices. That is the proofreading-switch contract.
2. Consent belongs to the user, not the repo. Every consent key is `"scope": "application"`, so a workspace `settings.json` cannot flip it. Shipped and enforced (MAR-199), and pinned by `shared/__tests__/settingsScope.test.ts`.
3. Disabled costs nothing: no scan, no lazy chunk loaded, no resolver call. A feature the user turned off is not merely inert, it is absent.

### Data

4. Render-only. Fetched data is decoration, and is never written into the markdown file. The one deliberate exception is paste-unfurl, which writes a title by explicit user action and ships `autoApply: false`.
5. No aggregators, no third-party middlemen. Each provider is contacted directly at its own pinned hosts, never iframely or microlink or embed.ly. This is what keeps the enumeration of who Birta talks to short and legible.
6. No confused-deputy fetches. A URL in a document must never cause a credential-bearing request to an arbitrary host. Provider recognition is pure and unit-tested, unrecognized URLs get nothing, and credentials are not carried across redirects. The embed-metadata fetch goes further. The document's URL string only selects a provider: the outgoing request is rebuilt entirely from validated parts (`shared/embedProviders.ts`, taking kind plus extracted id to a canonical URL to a pinned oEmbed endpoint). Redirects are never followed (`redirect: "manual"`, and any 3xx fails). The same shared table generates the webview CSP's host grants, so the allowlist cannot drift from the recognizer.

### Credentials (rung 2)

7. In the OS keychain, never in settings. `SecretStorage`, never `settings.json`, never settings sync, never the webview. The webview is the least-trusted surface, because it renders third-party content. Enforced in `src/connectors/`, whose only value crossing the messaging boundary is a card payload with no field a token could occupy.
8. No hosted auth broker. A relay holding client secrets or proxying tokens would contradict "nothing leaves your machine". If a provider cannot be done with a public client (PKCE) or a user-supplied token, it waits.
9. Minimal read-only scopes. Where a provider's tokens cannot be narrowed, the connect UI says so before the user proceeds. GitHub is such a case: its `repo` scope is the narrowest classic grant that reads a private repository's issues and pull requests, and it also permits writes, which the connect picker states.
14. Per-provider connect is a record Birta writes, not a session it finds. A credential the host already holds for another purpose is not consent, so a connector answers `locked` until the user connects it here. (Numbered from 14 because the numbering is one shared space across this document, and the telemetry invariants took 10 through 13.)
15. Cards are cached in memory for the session and never written to disk. Persisting private card data to workspace or global state is a real privacy decision, and it is deferred rather than made by accident.

---

## 3. The open question: none of this ports

Every mechanism above that handles a credential is VS Code's:

- `SecretStorage`, which is Electron `safeStorage`, OS-keychain-backed, and which holds every connection record
- `registerUriHandler`, which would serve the `vscode://BirtaLabs.birta-writer/auth/{provider}` OAuth callback (not built: no provider needs it yet)
- `vscode.authentication.getSession`, the built-in GitHub provider, which is why GitHub's rung 2 shipped first and cost nothing
- `"scope": "application"`, the guarantee that a shared workspace config cannot flip a consent key

None of these has an analog on Tauri, Capacitor, iPadOS, or the web, so any surface beyond VS Code inherits three pieces of work that no host-adapter design has costed: a keychain, a callback-URL scheme, and a consent-scope guarantee. Invariant 2 in particular has no obvious reimplementation off VS Code, because application scope is a VS Code settings concept.

That is the live question, and it is a reason to treat this document as an input to the persistence and host-contract design (MAR-226) rather than as a separate concern.

---

## Tracking

MAR-198 (connector foundation: the seam and GitHub shipped, the rest of the roster open), MAR-186 (provider roadmap), MAR-179 and MAR-199 (the shipped consent ladder and its application scope, both Done), MAR-232 (rung 3, gated). The open portability question feeds MAR-226.
