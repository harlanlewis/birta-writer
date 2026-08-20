# Network posture: what Birta sends, on whose consent, and under what invariants

Status: a record of live behavior and directed work, not exploration.

This document owns the network and consent story: what ships today (`birta.network.enabled`, paste-unfurl, embeds, link cards, the GitHub connector), and the directed design ahead of it (the rest of MAR-198's connector roster).

All of it is checkable. Where it describes shipped behavior it is a fact about the tree. Where it describes work MAR-198 has not reached, it is directed but unbuilt, and says so.

---

## 1. The escalation ladder

Every network capability sits on one rung. The rungs are ordered by what leaves the machine, which is the only ordering that matters to the privacy claim. Conflating them is how "we already do network things" becomes an argument for something categorically heavier.

| Rung | What leaves | Status | Examples |
|---|---|---|---|
| 0. Nothing | No outbound request at all | Shipped, and the default. `birta.network.enabled` ships `false`, and Jot's `networkEnabled` ships `false`; with it off neither makes an outbound request, and nothing but a person switches either on | Everything, out of the box |
| 0b. A URL you send yourself | Nothing, from Birta. It composes text and hands a URL to the host. The request is the user's browser or mail client, under their identity, against a draft they can still edit | Shipped | Send Feedback (`birta.sendFeedback`); following a link in a document; What's New (`birta.editor.openWhatsNew`); Ask Agent (`/ai`, `birta.editor.askAgent`), which hands one composed line to a shell command run as a child process or in a terminal, to the Chat view, or to the clipboard per `birta.agent.command`, and never to a model of its own |
| 0c. The app asking about itself | Nothing about you or your documents. A GET to the project's own release host, and then the archive | Shipped, Jot only, on by default | Birta Writer Jot's update check (`autoUpdate`) |
| 1. A URL you typed | The URL, to its own host | Shipped | Paste-unfurl; URL embed cards; link cards |
| 2. A URL and your credential | The URL and a per-provider token, to that provider's pinned hosts | Shipped for GitHub (MAR-198); every other provider directed, not built | GitHub repository, issue and pull-request cards; Jira, Asana and Figma still to come |
| 3. Your document content | The document itself, uploaded by Birta, to a destination Birta chose | Not decided, not designed, and gated on an open scope question | The publish loop (MAR-232). Jot's note in iCloud Drive is NOT this, and §1's own subsection argues why |

### Rung 1 today: three features, and only one of them writes to the file

Paste-unfurl contacts the host of the bare URL you pasted, and no other host, to read that page's title. It writes. The fetched title arrives as an offer at the link, and nothing changes in the file until the user accepts it; `birta.pasteUnfurl.autoApply` ships `false`, so acceptance is explicit.

URL embed cards contact the recognized provider's own pinned hosts, and ask that provider's own oEmbed endpoint for the title shown on the card's caption. They never write: a card is a rendering of the plain link already in the file. The metadata request is made extension-side, cached in memory for the session, and its URL is rebuilt from validated parts rather than taken from the document (invariant 6). The GitHub card asks `api.github.com` about the repository, issue or pull request its URL names; that read is anonymous unless the user has connected the service, and carries only the id the recognizer extracted.

Link cards contact the host of a web link that sits alone on its own line, and where it redirects the host it sends them to, each hop under the same guards, to read that page's Open Graph title and description, and show them as a quiet card in place of the link. They never write, and they fetch no image. The request goes through the same extension-side fetch as paste-unfurl, with the same guards (http(s) only on every hop, no private or link-local host, bounded in time and bytes), and is cached in memory for the session. This is the one rung-1 feature that ships off beneath the master switch (`birta.linkCards.enabled`), because unlike an embed card there is no provider recognizer bounding which hosts it can reach: any page a document links can be asked. A reader can also choose it per link from the block menu, in either direction, and that choice is presentation state beside the document, never bytes in it. That per-link choice is why the extension re-checks only the master switch for a link-card request where it re-checks both keys for paste-unfurl: the choice lives in the webview's own state, and a mirror of it posted by the same webview would prove nothing, so the master switch is the whole extension-side gate. A link a provider card recognizes but whose provider is switched off is left plain by the default and cards only on the reader's own choice.

### The same rung, on a second surface

Birta Writer Jot makes rung-1 requests too, and the rung is what matters rather than the process making them: a URL the user typed goes to its own host and to where that host redirects, and nowhere else. Jot has no connectors, so nothing about rung 2 exists there at all. Rung 3 needs the paragraph below rather than a clause, because Jot can now keep its note in iCloud Drive.

Four differences from the extension. Three narrow what the extension does; the fourth is where Jot asks rather than defaults.

- **One switch, not four.** Jot has a single network preference, and with it off the app makes no outbound request of any kind. Embeds, link cards and paste-unfurl all ride it. There is no per-provider table because there are no provider cards to gate.

- **One switch, off, and nothing turns it on but a person.** The stored default is `false`, exactly as `birta.network.enabled` is, and no code path anywhere sets it to true: the first-run screen does not ask about the network at all, so there is no default-on to argue about and no install, new or old, reaches rung 1 without somebody moving that switch themselves. `Prefs.applyOnboardingDefaults` is where such a write would go, and its doc says why it must never grow one; `jot/scripts/measure.sh`'s onboarding arm asserts the absence on both a first launch and an existing install.
- **The guards are a second implementation, and are held to the first.** `jot/Sources/BirtaJotCore/UrlGuard.swift` mirrors `src/utils/urlGuard.ts`, and `PageMetadataFetcher` mirrors the redirect, byte and time bounds around it. Neither language can import the other, so the cases live in `shared/__fixtures__/urlGuardCases.json` and both test suites read them: a rule enforced on one surface and not the other fails a test rather than becoming an exposure nobody compared. Add a case there, never in one suite.
- **The embed caption is not fetched.** `resolveEmbedMeta` is answered with nothing, because it needs the provider recognizer and that table is not worth a second copy in Swift. The card renders without a fetched caption.

### Jot updating itself: a rung of its own, and on by default

Birta Writer Jot is on no app store and cannot be, so the only way to get a fix has been to notice a release happened and run a shell script, which is a thing nobody does. `Prefs.autoUpdate` ships on: once a launch the app asks `api.github.com` what the newest release of this project is, and if it is newer than the running build, says so. Downloading and replacing are a click, never automatic, because swapping the app somebody is typing into is not a thing to do behind them.

It is 0c rather than rung 1, and the distinction is what leaves the machine. A rung-1 request carries a URL the user typed, which is content: it says what they are reading. This carries nothing of theirs. The request names the project, not the person; the response is a version number; no identifier is invented for it, and the app's own version reaches the host only as the ordinary shape of an HTTP request. The nearest existing neighbour is 0b, where Birta composes something and the user's own client sends it, and the difference from that is only that here Birta makes the request itself.

It deliberately does NOT ride `networkEnabled`, and that is the part worth arguing rather than assuming, because it is the first shipped behaviour where Jot makes a request with that switch off. The two are different consents. `networkEnabled` is about what happens to what you type: whether a link you pasted is fetched, whether an embed resolves. Updating is about the program. Riding one on the other would mean a person who wants no link previews also gets no fixes, which is not a trade anybody asked for and not one the switch's own wording offers.

Two limits keep it honest. It is the RELEASE build only (`AppFlavor.updatesItself`): a development build replacing itself would delete the change somebody installed it to look at. And the published checksum is checked before anything is written, with a release that published none refused rather than installed unverified. It proves the archive arrived intact and proves nothing about who built it, since both files come from the same place. Jot is ad-hoc signed and has no signature to check, which is the same reason it is not offered to anybody who does not already own the source.

### Jot's note in iCloud Drive: where it sits on the ladder, and why

Jot's `storeInICloud` setting, on by default where iCloud Drive is available, puts the default note at `iCloud Drive/Birta Writer Jot/Birta Writer Jot.md` instead of `~/Documents/Birta Writer/`. macOS then syncs that file, so the note's bytes leave the machine. This is the first shipped Birta behavior of which that is true by default, and it deserves to be argued rather than assumed, because rung 3's own examples name "any cloud or sync surface".

It is not rung 3, and the reason is the same one that puts Send Feedback on rung 0b rather than rung 1. Nothing leaves the machine *from Birta*. Jot opens a file in a folder in the user's own filesystem and writes to it with `write`, `fsync` and `rename`; it holds no credential, names no endpoint, and constructs no request. What syncs the folder is macOS, under the user's own iCloud account, exactly as it would if they had dragged any other file there.

Jot does make one explicit ask of iCloud, and it is worth naming rather than rounding to zero: on finding the note evicted, `Coordinator.readActiveNote` calls `FileManager.startDownloadingUbiquitousItem`. That is a request for a file the OS is already managing on the user's behalf, in the inbound direction, carrying no content and choosing no host. It sends nothing. Deliberately not a ubiquity container either (`ScratchpadLocation.iCloudDriveRoot`), which would need an entitlement and would hide the note under a container name. It is the ordinary iCloud Drive folder, visible in Finder, and the user can move the note out of it from Settings or from the title popover.

Rung 3 is a different thing wearing similar words. The publish loop (MAR-232) would have Birta choose the destination, hold the credential, decide who can read the result, and put document content on the wire under its own identity. None of those is true here, and the open scope question rung 3 is gated on is *who can see it*, which for a file in the user's own iCloud Drive has the same answer as every other file in it.

What is genuinely new, and is the reason this section exists rather than a table row, is the default. Every other network capability in this document ships off, and this one ships on where the service is available. The argument for it is that this is a file location rather than a request, and that a scratchpad which is the same note on every Mac is what most people want a scratchpad to be. The argument against is that "off by default" has been the whole shape of the posture. It is a switch in Settings, it says which location is in force underneath it, and turning it off moves the next write to `~/Documents/Birta Writer/`. Nothing is copied in either direction, so the choice never silently duplicates a note. A machine with iCloud Drive switched off never reaches any of this.

Paste-unfurl in Jot writes on the same terms as in the extension: the fetched title arrives as an offer, and auto-apply is left at its default of false, so nothing reaches the file until the user accepts it.

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

Three gates sit in front of any GitHub request and all three must be open: `birta.network.enabled`, then `birta.embeds.enabled`, then `birta.embeds.providers.github`. A fourth, the connection itself, governs only whether a CREDENTIAL is attached. Without it the card is still built, from an anonymous read of public data, exactly as every other provider's card is; connecting is an upgrade rather than an entry fee, because a public repository's title is world-readable and asking for a grant to display it would be asking for more than the card spends.

The connection deserves its own sentence, because it is the part a reader would not guess. A VS Code GitHub session signed in for some other extension's sake is not consent for Birta to spend it: the connection is a record Birta writes when the user runs "Birta: Connect Service…" or clicks a card's connect affordance, and without that record no `authorization` header is built. Deleting it is what "Birta: Disconnect Service…" does.

Connecting has two tiers, and the default is the narrow one. The ordinary connect requests NO scopes at all, which GitHub documents as read-only access to public information; it reads exactly what an anonymous request reads, and buys only a rate limit (5,000 requests an hour against the anonymous 60, which is keyed on your IP address and shared with everything else on it). The second tier is opt-in and exists for private repositories, where GitHub offers no read-only grant of any kind: `repo` necessarily permits writes, the picker says so in the row before the user chooses it, and Birta only ever reads. A card that is not visible to whoever asked shows the connect offer rather than an error, because a wider grant is the one thing that might change the answer.

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

1. Layered, and the outermost layer ships off: master network switch, then capability toggle (embeds, unfurl, link cards), then per-provider, then per-service connect. Only the master ships off, with one capability that also does: `birta.pasteUnfurl.enabled` and `birta.embeds.enabled` both ship on, beneath it, so turning the master on makes both live at once and each is then turned off individually, while `birta.linkCards.enabled` ships off because its fetch is not bounded to a provider's hosts. The default-quiet guarantee rests on the master alone. A master gates its children and never overwrites them, so re-enabling restores prior child choices. That is the proofreading-switch contract.
2. Consent belongs to the user, not the repo. Every consent key is `"scope": "application"`, so a workspace `settings.json` cannot flip it. Shipped and enforced (MAR-199), and pinned by `shared/__tests__/settingsScope.test.ts`.
3. Disabled costs nothing: no scan, no lazy chunk loaded, no resolver call. A feature the user turned off is not merely inert, it is absent.

### Data

4. Render-only. Fetched data is decoration, and is never written into the markdown file. The one deliberate exception is paste-unfurl, which writes a title by explicit user action and ships `autoApply: false`.
5. No aggregators, no third-party middlemen. Each provider is contacted directly at its own pinned hosts, never iframely or microlink or embed.ly. This is what keeps the enumeration of who Birta talks to short and legible.
6. No confused-deputy fetches. A URL in a document must never cause a credential-bearing request to an arbitrary host. Provider recognition is pure and unit-tested, unrecognized URLs get nothing, and credentials are not carried across redirects. The embed-metadata fetch goes further. The document's URL string only selects a provider: the outgoing request is rebuilt entirely from validated parts (`shared/embedProviders.ts`, taking kind plus extracted id to a canonical URL to a pinned oEmbed endpoint). Redirects are never followed (`redirect: "manual"`, and any 3xx fails). The same shared table generates the webview CSP's host grants, so the allowlist cannot drift from the recognizer.

### Credentials (rung 2)

7. In the OS keychain, never in settings. `SecretStorage`, never `settings.json`, never settings sync, never the webview. The webview is the least-trusted surface, because it renders third-party content. Enforced in `src/connectors/`, whose only value crossing the messaging boundary is a card payload with no field a token could occupy.
8. No hosted auth broker. A relay holding client secrets or proxying tokens would contradict "nothing leaves your machine". If a provider cannot be done with a public client (PKCE) or a user-supplied token, it waits.
9. Minimal read-only scopes, and no credential at all where none is needed. A public resource is read anonymously; the default connect asks for an empty scope set. A broader grant is requested only when the user picks the tier that needs it, and where a provider offers no read-only form of that grant the picker says so in the row before they choose. GitHub is such a case: no OAuth scope reads a private repository without also permitting writes.
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
