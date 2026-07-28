# Network posture — what Birta sends, on whose consent, and under what invariants

**Status:** a record of **live behavior and directed work** — not exploration. Written 2026-07-26 to
give an axis a home it did not have.

This document exists because the network/consent story was **the one axis with no owner**: it ships
today (`birta.network.enabled`, unfurl, embeds), it has directed design ahead of it (MAR-198's
connector foundation), and three separate strategy documents each reasoned about a fragment of it
without any of them owning the whole. That produced a wrong premise in one
(`MULTI_SURFACE_INVESTIGATION.md` §9 reasoned from "identity/auth: today zero"), a missing rung in
another (`PUBLISH_LOOP.md` §8's escalation ladder), and a duplicated design question in a third
(`AI_ASSISTANCE.md` §3.6's BYO-key). Tracked as **D10** in [`STRATEGY.md`](STRATEGY.md).

**Unlike the strategy documents, most of this is checkable.** Where it describes shipped behavior it
is a fact about the tree; where it describes MAR-198 it is directed-but-unbuilt and says so.

---

## 1. The escalation ladder

Every network capability sits on one rung. The rungs are ordered by **what leaves the machine**, which
is the only ordering that matters to the privacy claim. Conflating them is how "we already do network
things" becomes an argument for something categorically heavier.

| Rung | What leaves | Status | Examples |
|---|---|---|---|
| **0 — nothing** | No outbound request at all | **Shipped, and the default.** `birta.network.enabled` ships `false`; with it off the editor makes no outbound request | Everything, out of the box |
| **1 — a URL you typed** | The URL, to its own host | **Shipped** | Paste-unfurl (fetches a page title, *offers* it); URL embeds (renders a card, and — 2026-07-27 — asks the provider's **own oEmbed endpoint** for the title shown on the card's caption: extension-side, request URL rebuilt from validated parts, session-cached, render-only) |
| **2 — a URL + your credential** | The URL and a per-provider token, to that provider's pinned hosts | **Directed, not built** (MAR-198) | Jira/Asana/Figma/private-GitHub cards |
| **3 — your document content** | The document itself | **Not decided, not designed** — gated on an open scope question | The publish loop (MAR-232), any cloud/sync surface |

Two things this ladder makes visible that the per-document treatments did not:

- **Rungs 1 and 2 never upload document content.** That is what makes rung 3 a *category* change
  rather than one more checkbox, and it is why `PUBLISH_LOOP.md` argues publishing needs its own
  consent architecture. That argument survives rung 2 existing — it is strengthened by it.
- **Rung 2 is where identity enters.** Not a Birta account — a *third-party* one. The distinction is
  real and worth defending, but "Birta has no auth" stopped being true the moment MAR-198 was
  directed.

---

## 2. The invariants

These come from shipped work (MAR-179, MAR-199) and MAR-198's directed design. They are stated here
once so no future capability re-derives them, and so a new surface knows what it must re-provide.

**Consent**

1. **Layered, each layer off by default:** master network switch → capability toggle (embeds,
   unfurl) → per-provider → per-service connect. A master gates its children and **never overwrites
   them** — re-enabling restores prior child choices (the proofreading-switch contract).
2. **Consent belongs to the user, not the repo.** Every consent key is `"scope": "application"` so a
   workspace `settings.json` cannot flip it. Shipped and enforced (MAR-199).
3. **Disabled costs nothing** — no scan, no lazy chunk loaded, no resolver call. A feature the user
   turned off is not merely inert, it is absent.

**Data**

4. **Render-only.** Fetched data is decoration; it is never written into the markdown file. The one
   deliberate exception is paste-unfurl, which writes a title *by explicit user action* and is
   `autoApply: false` by default.
5. **No aggregators, no third-party middlemen.** Each provider is contacted directly at its own
   pinned hosts — never iframely/microlink/embed.ly. This is what keeps the enumeration of "who
   Birta talks to" short and legible.
6. **No confused-deputy fetches.** A URL in a document must never cause a credential-bearing request
   to an arbitrary host. Provider recognition is pure and unit-tested; unrecognized URLs get nothing;
   credentials are not carried across redirects. The embed-metadata fetch goes further: the
   document's URL string only *selects* a provider — the outgoing request is rebuilt entirely from
   validated parts (`shared/embedProviders.ts`: kind + extracted id → canonical URL → pinned oEmbed
   endpoint), redirects are never followed (`redirect: "manual"`, any 3xx fails), and the same
   shared table generates the webview CSP's host grants, so the allowlist cannot drift from the
   recognizer.

**Credentials** (rung 2)

7. **In the OS keychain, never in settings** — `SecretStorage`, never `settings.json`, never settings
   sync, never the webview. The webview is the least-trusted surface: it renders third-party content.
8. **No hosted auth broker.** A relay holding client secrets or proxying tokens would contradict
   "nothing leaves your machine." If a provider cannot be done with a public client (PKCE) or a
   user-supplied token, **it waits.**
9. **Minimal read-only scopes**, and where a provider's tokens cannot be narrowed, the connect UI
   says so before the user proceeds.

---

## 3. The open question: none of this ports

**This is the part no document had.** Every mechanism above that handles a credential is VS
Code's:

- `SecretStorage` — Electron `safeStorage`, OS-keychain-backed
- `registerUriHandler` — the `vscode://birtalabs.birta-writer/auth/{provider}` OAuth callback
- `vscode.authentication.getSession` — the built-in GitHub provider, which makes GitHub's rung-2
  nearly free
- `"scope": "application"` — the guarantee a shared workspace config cannot flip a consent key

**None of these has an analog on Tauri, Capacitor, iPadOS, or the web**, and
`MULTI_SURFACE_INVESTIGATION.md` §2's `HostAdapter` sketch lists "a single network fetch (unfurl)"
and nothing else. Its §14 capability taxonomy has no bucket for credential storage or a callback
route. So any surface bet inherits three uncosted pieces of work — a keychain, a callback-URL
scheme, and a consent-scope guarantee — and invariant 2 in particular has **no obvious
reimplementation** off VS Code, because "application scope" is a VS Code settings concept.

That is the live question, and it is a reason to treat this document as an input to the
persistence/host-contract design (MAR-226) rather than a separate concern.

---

## 4. Where this bites the other documents

- [`PUBLISH_LOOP.md`](PUBLISH_LOOP.md) §8 — the publish loop is **rung 3**. Its argument that
  publishing is a categorical change holds; what it gains from this document is that the layered
  consent architecture it says publishing would need is **already designed at rung 2**. Extend that
  ladder; do not invent one.
- [`AI_ASSISTANCE.md`](AI_ASSISTANCE.md) §3.6 — "BYO-key" is rung 2 with a different provider. Reuse
  invariants 7–9 rather than standing up a second key store. Note also that on-device inference is
  **rung 0**, which is exactly why the AI posture and the privacy claim reinforce each other.
- [`MULTI_SURFACE_INVESTIGATION.md`](MULTI_SURFACE_INVESTIGATION.md) §9 — its identity/auth section
  reasoned from "today: zero." Corrected in place; §3 above is the portability gap it implies.
- [`SURFACE_STRATEGY.md`](SURFACE_STRATEGY.md) — a cloud-backed surface is rung 3 by construction,
  which is most of why that document rates it the worst brand fit despite the best feasibility.

---

## Tracking

**MAR-198** (connector foundation — the rung-2 design), **MAR-186** (provider roadmap),
**MAR-179** / **MAR-199** (the shipped consent ladder and its application scope, both Done),
**MAR-232** (rung 3, gated). Open portability question: **D10** in [`STRATEGY.md`](STRATEGY.md),
feeding **MAR-226**.
