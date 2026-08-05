# Network posture: what Birta sends, on whose consent, and under what invariants

Status: a record of live behavior and directed work, not exploration.

This document owns the network and consent story: what ships today (`birta.network.enabled`, paste-unfurl, embeds), and the directed design ahead of it (MAR-198's connector foundation). It is tracked as decision D10 in the private strategy corpus. The strategy documents cited by name below live in that corpus rather than in this repository; they are named so the reasoning stays traceable.

Most of this is checkable, unlike those documents. Where it describes shipped behavior it is a fact about the tree. Where it describes MAR-198 it is directed but unbuilt, and says so.

---

## 1. The escalation ladder

Every network capability sits on one rung. The rungs are ordered by what leaves the machine, which is the only ordering that matters to the privacy claim. Conflating them is how "we already do network things" becomes an argument for something categorically heavier.

| Rung | What leaves | Status | Examples |
|---|---|---|---|
| 0. Nothing | No outbound request at all | Shipped, and the default. `birta.network.enabled` ships `false`; with it off the editor makes no outbound request | Everything, out of the box |
| 0b. A URL you send yourself | Nothing, from Birta. It composes text and hands a URL to the host. The request is the user's browser or mail client, under their identity, against a draft they can still edit | Shipped | Send Feedback (`birta.sendFeedback`); following a link in a document |
| 1. A URL you typed | The URL, to its own host | Shipped | Paste-unfurl; URL embed cards |
| 2. A URL and your credential | The URL and a per-provider token, to that provider's pinned hosts | Directed, not built (MAR-198) | Jira, Asana, Figma, private-GitHub cards |
| 3. Your document content | The document itself | Not decided, not designed, and gated on an open scope question | The publish loop (MAR-232), any cloud or sync surface |

### Rung 1 today: two features, and only one of them writes to the file

Paste-unfurl contacts the host of the bare URL you pasted, and no other host, to read that page's title. It writes. The fetched title arrives as an offer at the link, and nothing changes in the file until the user accepts it; `birta.pasteUnfurl.autoApply` ships `false`, so acceptance is explicit.

URL embed cards contact the recognized provider's own pinned hosts, and ask that provider's own oEmbed endpoint for the title shown on the card's caption. They never write: a card is a rendering of the plain link already in the file. The metadata request is made extension-side, cached in memory for the session, and its URL is rebuilt from validated parts rather than taken from the document (invariant 6). One card contacts nothing at all: the GitHub card is derived from the URL text.

`shared/embedProviders.ts` enumerates the hosts an embed card can reach, and the same table generates the webview's content-security-policy grants.

### Rungs 1 and 2 never upload document content

That is what makes rung 3 a category change rather than one more checkbox, and it is why `PUBLISH_LOOP.md` argues publishing needs its own consent architecture. That argument survives rung 2 existing. It is strengthened by it.

### Rung 2 is where identity enters

Not a Birta account, a third-party one. The distinction is real and worth defending, but "Birta has no auth" stopped being true the moment MAR-198 was directed.

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

7. In the OS keychain, never in settings. `SecretStorage`, never `settings.json`, never settings sync, never the webview. The webview is the least-trusted surface, because it renders third-party content.
8. No hosted auth broker. A relay holding client secrets or proxying tokens would contradict "nothing leaves your machine". If a provider cannot be done with a public client (PKCE) or a user-supplied token, it waits.
9. Minimal read-only scopes. Where a provider's tokens cannot be narrowed, the connect UI says so before the user proceeds.

---

## 3. The open question: none of this ports

Every mechanism above that handles a credential is VS Code's:

- `SecretStorage`, which is Electron `safeStorage`, OS-keychain-backed
- `registerUriHandler`, which serves the `vscode://BirtaLabs.birta-writer/auth/{provider}` OAuth callback
- `vscode.authentication.getSession`, the built-in GitHub provider, which makes GitHub's rung 2 nearly free
- `"scope": "application"`, the guarantee that a shared workspace config cannot flip a consent key

None of these has an analog on Tauri, Capacitor, iPadOS, or the web. `MULTI_SURFACE_INVESTIGATION.md` §2's `HostAdapter` sketch lists "a single network fetch (unfurl)" and nothing else, and its §14 capability taxonomy has no bucket for credential storage or a callback route. So any surface bet inherits three uncosted pieces of work: a keychain, a callback-URL scheme, and a consent-scope guarantee. Invariant 2 in particular has no obvious reimplementation off VS Code, because application scope is a VS Code settings concept.

That is the live question, and it is a reason to treat this document as an input to the persistence and host-contract design (MAR-226) rather than as a separate concern.

---

## 4. Where this bites the other documents

- `PUBLISH_LOOP.md` §8. The publish loop is rung 3. Its argument that publishing is a categorical change holds; what it gains from this document is that the layered consent architecture it says publishing would need is already designed at rung 2. Extend that ladder, do not invent one.
- `AI_ASSISTANCE.md` §3.6. "BYO-key" is rung 2 with a different provider. Reuse invariants 7 to 9 rather than standing up a second key store. On-device inference is rung 0, which is exactly why the AI posture and the privacy claim reinforce each other.
- `MULTI_SURFACE_INVESTIGATION.md` §9. Its identity and auth section reasoned from "today: zero", and is corrected in place. Section 3 above is the portability gap that correction implies.
- `SURFACE_STRATEGY.md`. A cloud-backed surface is rung 3 by construction, which is most of why that document rates it the worst brand fit despite the best feasibility.

---

## Tracking

MAR-198 (connector foundation, the rung-2 design), MAR-186 (provider roadmap), MAR-179 and MAR-199 (the shipped consent ladder and its application scope, both Done), MAR-232 (rung 3, gated). The open portability question is D10 in the private strategy corpus, feeding MAR-226.
