# Strategy map — what is decided, what is open, and which document owns it

**Status:** reconciliation index. Written 2026-07-26, after five independent strategy documents
landed in two days from separate branches. **This file decides nothing new.** It exists because the
thinking is sound but arrived unreconciled: the same crux is argued in four places, two documents
prescribe different next steps without either naming the conflict, and several recommendations have
no ticket. This is the map that makes them one body of work.

**Read this before any of the strategy documents below.** Read `README.md` ("Why this fork") and
`docs/BENEFITS.md` before this — where they and any strategy document disagree about what Birta *is
today*, the canon wins.

---

## 1. The documents, and what each one owns

Six strategy documents landed between 2026-07-24 and 2026-07-26. Each has exactly one question it is
the authority on; where they overlap, the owner column is who wins. **The seventh row is the hole** —
an axis with tickets but no document.

| Document | Owns | Status | Tracking |
|---|---|---|---|
| [`MULTI_SURFACE_INVESTIGATION.md`](MULTI_SURFACE_INVESTIGATION.md) | **The host-adapter engineering**: the capability taxonomy (§14), the `HostServices` seam, the shell inventory, the raw-editor design (§15) | Investigation; nothing measured. Its *engineering* stands; its *prioritization* is **re-opened, not superseded** — the disagreement is live (§4) | MAR-225 |
| [`SURFACE_STRATEGY.md`](SURFACE_STRATEGY.md) | **Which surface, for whom, and whether at all**: the market read, the ICPs, the probe-first recommendation | Pre-commitment exploration; self-red-teamed | MAR-233, MAR-234 |
| [`PUBLISH_LOOP.md`](PUBLISH_LOOP.md) | **The document-lifecycle axis** — local↔cloud publishing. Orthogonal to surface | Gated design record. Presumes an undecided scope gate | MAR-232 |
| [`AI_ASSISTANCE.md`](AI_ASSISTANCE.md) | **The AI posture** — surface-independent | Posture record | MAR-236 |
| [`ENGINE_AND_DIALECT_STRATEGY.md`](ENGINE_AND_DIALECT_STRATEGY.md) | **Own vs. rent across the editing stack**, and dialect mapping | Decision framework | MAR-235, MAR-237, MAR-238 |
| [`research/writing-app-landscape.md`](research/writing-app-landscape.md) | **The evidence base** for the standalone-app market (companion to [`research/markdown-editor-landscape.md`](research/markdown-editor-landscape.md), which covers Markdown *inside VS Code*) | Research; verification gaps flagged inline | — |
| **— none —** | **Third-party integrations / connectors**: the render ladder, per-provider auth, credential storage, and what any of it means for the privacy contract or a second surface | **Unwritten.** The thinking lives in a *ticket*, not a document — and it is better specified than most of the documents | MAR-198, MAR-186 |

**Two things none of them owned, and this file now does:** the *union* — the deduplicated decision
register (§3) and the reconciled sequence (§4) — and the observation that the **integrations axis has
no document at all** (§3 D10), despite carrying maintainer direction and colliding with claims three
of the documents make.

*(Precision note, since this file's job is precision: more than six documents landed in that window —
`BRAND.md`, `brand-brief.md`, `PROVENANCE.md`, and `research/birta-name-meaning.md` did too, and
`POSITIONING.md` was edited. They are brand and provenance records, not strategy, and are indexed
from `POSITIONING.md`; the table above is the strategy set only.)*

---

## 2. What is settled — and by whom

**These are two different grades of "decided," and collapsing them is how a strategy document
manufactures a commitment nobody made.** `PUBLISH_LOOP.md`'s own banner names the mechanism: *"a
confident design creates gravity even when filed as gated."* An index that stamps
**decided — do not re-litigate** on an argument the owner never ratified does exactly that, at
greater range, because a summary is what later readers actually read.

### 2a. Ratified — a maintainer decision exists, with a record

- **Stay on ProseMirror.** A custom core, Rust/WASM, Lexical, and CodeMirror 6 *as the rich-text
  engine* are ruled out — **MAR-102**, a dated decision record over ~45 adversarially verified
  claims, with a stated re-check trigger. Wordgard is the only sanctioned watch item.
  `ENGINE_AND_DIALECT_STRATEGY.md` §4 reaches the same conclusion independently; treat MAR-102 as
  the citable record and §4 as corroboration, not a second answer.
- **The three directional calls in `MULTI_SURFACE_INVESTIGATION` §0.5** (maintainer, 2026-07-25):
  web is a *cloud product*, not a port; "edit once, deploy everywhere" applies to the writing
  experience but **not** by moving keybindings/commands/settings into core; and the extraction is
  **Writer-scoped, not a portfolio-wide editor factory** (§0.5c — the portfolio shares brand and
  tooling, not an editor).
- **Offline by default, and consent belongs to the user, not the repo.** Shipped and enforced:
  `birta.network.enabled` ships off, and the consent keys are `application`-scoped so a workspace
  cannot flip them (MAR-179, MAR-199 — both Done).
- **The connector posture** (maintainer direction, 2026-07-23, **MAR-198**): third-party
  integrations are API-backed *native cards* with the most ergonomic auth each provider allows;
  credentials live in `SecretStorage`, never in settings and never in the webview; **no hosted auth
  broker**; fetched data is render-only and never written to the file. See §3 D10 — this is the
  axis no strategy document covers.

### 2b. Converged across the documents — but never ratified

Every document that reaches a recommendation says these. That is agreement between *arguments*, not
a decision. They are the strongest candidates for ratification, and they should be *labelled* as
candidates until someone says yes.

- **Never roll a CommonMark parser or a rich-text view.** Rent remark and ProseMirror; own merge
  semantics and our custom nodes (`ENGINE` §1). Follows from 2a's MAR-102 but is broader than it.
- **CM6 as a *raw-source companion* is a separate question and is not ruled out** —
  `MULTI_SURFACE_INVESTIGATION` §15, orthogonal to MAR-102. Be precise about which "CM6" is meant;
  the two have already been conflated once.
- **Local-files-in-a-browser is a dead end outside Chromium desktop** (File System Access API is
  Chromium-desktop-only; Safari and Firefox ship only OPFS). `MULTI_SURFACE` §8's extensive
  FSA/OPFS analysis is therefore the **PWA/fallback tier**, already self-demoted in its §16.1;
  `SURFACE_STRATEGY` §3(c) re-derives the same verdict. They agree — and two documents agreeing is
  not two pieces of evidence, since the second read the first.
- **Rung 0 reach is free and gated on nothing.** Open VSX (MAR-228) and a vscode.dev web-extension
  scope (MAR-229). Unanimous across every document; still not a decision — nobody has said "do it."
- **The AI posture's floor:** no cloud generation, no agent that edits the file, no AI detector, no
  telemetry-backed style learning, no AI-first branding (`AI_ASSISTANCE` §4). Consistent with
  everything shipped, and the doc's own §7 flags the line *above* the floor as open (D7) — but the
  floor itself is a document's assertion, not a ratified boundary.

---

## 3. The open-decision register

Every genuinely open question, once. Four documents each ended with an "open decisions" list; those
lists overlap heavily and the same crux appears in four of them. The per-document lists remain for
context, but **this table is the one that should be worked** — a decision resolved here should be
struck from the source document, not maintained in two places.

| # | Decision | Argued in | Gates | Cheapest thing that would settle it |
|---|---|---|---|---|
| **D1** | **Who is the user?** *The* crux — raised independently in four documents. The maintainer uses Birta *because* it sits in VS Code beside git and agents; any standalone surface serves someone else, i.e. a new product, not a port. Which ICP — A (Obsidian/Logseq mobile refugee), B (privacy-first writer), C (escape-Notion), D (the maintainer's own phone)? And **companion or new home?** | `SURFACE` §2, §9.3 · `MULTI_SURFACE` §13 · `PUBLISH_LOOP` §8 | Everything below | **MAR-234** (demand probe, ~1 week, no code) |
| **D2** | **Is expansion wanted at all now**, given the solo-maintainer tax and that phase-0/1 still have runway? "Rung 0 + the proofreader extension, stay VS Code-only" is a complete, defensible answer | `SURFACE` §9.2, §7 · `MULTI_SURFACE` §13 | D3–D6 | D1's outcome |
| **D3** | **Which second surface** — desktop-Tauri (the extraction-validation vehicle) or Capacitor-mobile (the market-relevant one, which `SURFACE` §6 argues can *be* the validation host, making desktop-first optional)? **This is the live disagreement between the two surface documents** (§4) | `MULTI_SURFACE` §11 Rung 2, §12.1 · `SURFACE` §5, §6, §9.6, §9.10 | The whole extraction plan | D1 + **MAR-233** (mobile-typing go/no-go) |
| **D4** | **If mobile: local-files (on-brand, Yellow) or own-cloud (easier, off-brand)?** | `SURFACE` §4, §9.5 | Mobile scope | MAR-233 + D1 |
| **D5** | **Is a cloud/sync product wanted for its own sake?** If no, web stays Chromium-desktop-or-nothing and is deprioritized — for the *measured* reason, not by assumption. This is also the gate `PUBLISH_LOOP` presumes and must not close | `MULTI_SURFACE` §12.5 · `SURFACE` §9.7 · `PUBLISH_LOOP` §3, §8 | The web surface; the whole publish loop | Decide before any web code — it is a one-way door on the privacy claim |
| **D6** | **Pricing, accounts, and per-surface licensing.** FSL-1.1-ALv2 auto-converts each release to Apache-2.0 after two years, so a hosted service can't rely on code secrecy. One-time vs BYO-sync-free vs subscription — and it constrains which surface even makes sense | `SURFACE` §8 · `MULTI_SURFACE` §9, §12.6 · landscape #10 | Any paid surface; D3/D5 | Fold the price question into MAR-234, don't run a separate probe |
| **D7** | **Generative or analytical-only AI?** The conservative reading keeps Birta's AI analytical (proofread, tells, structure); the less conservative allows on-request, local, accept-first rewrite. Genuinely open — the §2b floor holds either way | `AI_ASSISTANCE` §7, §8 | What a new surface's headline feature is | Nothing external; a maintainer call. The floor-level work (MAR-236) is safe under both readings |
| **D8** | **Where does `phase-5-surfaces` rank?** Linear carries the label; `AGENTS.md`'s spine stops at phase-4 and has never been updated, so the rank is *undefined* and the "first High down the spine" rule cannot be evaluated. Four `High` phase-5 items now sit unranked while the ranked spine has no High at all | MAR-141 (board guide) · `AGENTS.md` §"Sequencing signal" | Every future session's pick | A one-line maintainer call, then update `AGENTS.md` — this is the cheapest open item on the board |
| **D9** | **Identity sequencing** — the drawn wordmark/glyph (MAR-209, `BRAND.md` is still a discovery plan) before or after any non-extension surface? Standalone surfaces front-run it | `MULTI_SURFACE` §9, §12.7 | Any public surface launch | Maintainer call; already owner-blocked with MAR-134 |
| **D10** | **Where do third-party integrations sit in the network posture, and do they port?** MAR-198 is *maintainer-directed* and well-specified — but **no strategy document covers it**, and three of them make claims it complicates (see below) | **MAR-198**, MAR-186 · nothing in `docs/` | The privacy contract; the `HostServices` surface; AI BYO-key | Nothing external — but it needs a *home in the docs*, which it does not have |

**On D10 — the axis the strategy pass missed.** Integrations were named as a review axis and none of
the five documents addresses them, even though MAR-198 carries maintainer direction (2026-07-23) and
harder invariants than most of the strategy work. Three specific collisions, none of them fatal, all
of them unrecorded until now:

1. **`MULTI_SURFACE` §9 says identity/auth is "today: zero, and that's a *stated value*," and biases
   to "no account, or account for sync only."** True of shipped code; **false of directed work.**
   MAR-198 specifies OAuth 2.0 + PKCE, `vscode.authentication.getSession`, and per-service token
   storage. That is not an *account with Birta* — the distinction holds and the value survives — but
   "zero auth" is no longer an accurate premise to reason from.
2. **Every mechanism MAR-198 names is VS-Code-only and appears in no capability bucket.**
   `SecretStorage` (Electron safeStorage), `registerUriHandler` for the
   `vscode://birtalabs.birta-writer/auth/…` OAuth callback, and VS Code's built-in GitHub auth
   provider have no analog on Tauri, Capacitor, or the web. **`MULTI_SURFACE` §2's `HostAdapter`
   list contains "a single network fetch (unfurl)" and nothing about credential storage or an OAuth
   callback route** — so §14's taxonomy is missing a Bucket-3 capability that is already directed
   work. Any surface bet inherits it.
3. **`PUBLISH_LOOP` §8's posture ladder is missing a rung.** It argues the two current network
   exceptions are "deliberately tiny — unfurl *reads* a title, embeds *render* a card; neither
   uploads your content," so publishing is a new *class*. Still true — but MAR-198 introduces a
   third class in between: **outbound requests carrying the user's credentials to third-party
   APIs.** That strengthens the publish-loop caution rather than weakening it, *and* it means the
   layered per-capability consent architecture publishing would need is already being designed.

   The same collision has an easy win attached: **`AI_ASSISTANCE` §3.6's "BYO-key" bridge is
   MAR-198's credential problem again**, and MAR-198 already answers it (keychain-backed, never
   `settings.json`, never the webview, `application` scope, disconnect deletes the secret). If
   BYO-key ever ships it should reuse that machinery, not invent a second key store.

---

## 4. The sequence conflict, stated plainly

The two surface documents prescribe **different next steps and neither names the other's ordering.**
This is the single most important thing to reconcile, because four `High` tickets now encode both
orderings at once:

| | `MULTI_SURFACE_INVESTIGATION` §16 go-forward (07-25) | `SURFACE_STRATEGY` §6 (07-26) |
|---|---|---|
| 1 | Design the persistence/save/external-change contract (**MAR-226**) | Demand probe (**MAR-234**) — the null-hypothesis test |
| 2 | Standalone save probe (**MAR-227**) | Mobile-typing go/no-go (**MAR-233**) |
| 3 | Rung 0 reach in parallel (MAR-228/229) | Rung 0 reach in parallel (MAR-228/229) |
| 4 | Extract `packages/core`; **desktop-Tauri is the second surface** | Let the probes choose; **Capacitor-mobile may replace desktop as the extraction host** |

**Where they genuinely agree** — and this is more than it looks:

- Rung 0 (MAR-228/229) runs in parallel and is gated on nothing. **Do it regardless.**
- The next act is *buying information*, not building. Both are probe-first documents.
- Nothing is measured anywhere. Every rating in both documents is a prior.
- Persistence is the highest-stakes, thinnest-designed seam whichever surface wins — MAR-226 is not
  desktop-specific, and `SURFACE_STRATEGY` never argues against it.

**Where they actually conflict:** only on *which* probe comes first, and that resolves cleanly once
stated — MAR-234 (demand) is the cheapest and most decisive, costs no engineering, and can kill or
confirm the thesis before MAR-226/227/233 are worth starting. `SURFACE_STRATEGY` §6 makes this
argument; `MULTI_SURFACE` predates it and had no demand evidence to weigh.

**The unresolved part is D3**, and no probe settles it alone: whether the second surface is desktop
(cheapest extraction validation, aimed largely at the maintainer) or mobile (aimed at the
hypothesized market gap). That is a maintainer decision informed by MAR-234 + MAR-233 — not
something either document should be read as having settled.

**A suggested reading that costs nothing to adopt — flagged as *this file's own* recommendation, not
a reconciliation of what the documents said:** run MAR-234 first; run MAR-228 in parallel because it
is free; treat MAR-226 as surface-agnostic design that pays off under every branch; hold MAR-227 and
MAR-233 until MAR-234 returns. It commits to nothing on D3, and it belongs in §2b's category —
an argument, not a decision.

---

## 5. Corrections applied in this pass

Recorded so the errors are not re-inherited from the un-corrected text:

1. **`ENGINE_AND_DIALECT_STRATEGY` §3 and §7.5 rested on a false premise.** They prescribed
   "defaulting very large documents to source mode" as "the cheapest large-doc lever" and described
   the escape hatch as "Source mode (CodeMirror) … already exists." **Birta has no source editor and
   no CodeMirror dependency**; "Edit Raw Markdown" delegates to VS Code's own text editor
   (`vscode.openWith(uri, "default")`), exactly as `MULTI_SURFACE` §6 and §15 state. The lever
   survives in corrected form — `birta.defaultMode` can open large documents in VS Code's raw editor
   — but **only on VS Code**, and it is not a lever any standalone surface inherits. Corrected in
   place.
2. **`ENGINE` §4 never cited MAR-102**, the existing decision record answering the same question.
   Cross-reference added.
3. **`SURFACE_STRATEGY` §6 said the mobile-typing probe "should exist as a Linear issue … it does not
   yet."** It does: MAR-233 (and the demand probe, MAR-234). Corrected.
4. **Recommendations without tracking, now filed:** the AI posture's "do now, betrays nothing"
   proofreader work (MAR-236), growing the fidelity corpus (MAR-237 — which `ENGINE` §2 calls *the*
   moat and says should out-rank the parser question), and dialect-provenance fields (MAR-238).
   MAR-101 sharpened to its real scope ("own the remark↔PM bridge", not "roll a parser").
5. **Deliberately still unfiled**, per MAR-225's own policy of not queuing speculative work: the CM6
   raw/source editor (`MULTI_SURFACE` §15), the core extraction, the Tauri desktop shell, and the
   cloud web product. They are designed, not queued. This is a choice, not an oversight.
6. **`PUBLISH_LOOP` §3 over-counted its own citation.** It says BENEFITS states "twice" that "the
   editor never writes or reverts your document on its own." BENEFITS states it **once**
   (`BENEFITS.md:201`); README repeats the idea in different words ("never silently overwrites or
   merges"). The claim is real and the argument built on it is unaffected — but the count was
   checkable and wrong, in a document arguing about the reliability of a shipped guarantee.
   Corrected in both the doc and MAR-232.
7. **Corrections to *this* file, second pass (2026-07-26).** §2 originally presented one flat list of
   things "decided — do not re-litigate," mixing a dated maintainer decision record (MAR-102) with
   unanimous-but-unratified document recommendations (Rung 0, the AI floor). That is the exact
   gravity-manufacturing failure `PUBLISH_LOOP` warns about, committed by the file whose job is to
   prevent it. Split into §2a/§2b. Separately, §6's "index, not a container" rule was violated by
   §3 D10 on arrival — now stated as a known, named exception with a fix, rather than a rule the
   file quietly breaks.

---

## 6. Keeping this honest

- **A decision resolved goes in §2a and is struck from §3** — and from the source document's own
  list. Two copies of an open question is how the same crux ended up argued in four places. And
  **put it in §2a only if someone actually decided it**; §2b is where "all the documents agree" goes,
  and the two must not merge quietly.
- **This file is an index, not a container.** A register entry states enough to be *recognizable
  without opening the source* — one or two sentences of *what* — and then points at the document
  that owns the *why*. It is not a summary of the argument.

  **There is currently one deliberate exception, and it is a bug, not a pattern:** D10
  (integrations) carries several paragraphs of actual argument, because **no document owns that
  axis** — the index is standing in as the container. The fix is to write the missing document (or
  fold the axis into an existing one) and cut D10 back to a register entry, not to keep growing it
  here. Any *other* paragraph in this file that starts explaining *why* has drifted and should move.
- **Every strategy document carries a `Tracking:` line.** `AI_ASSISTANCE.md` shipped without one and
  its recommendations went untracked for two days as a direct result.
- **Nothing in any of these documents is measured.** Every rating, effort estimate, and market read
  is a prior. The probes exist to replace them with data; until they return, quote these documents as
  *arguments*, never as findings.
