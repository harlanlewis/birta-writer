# Strategy map — what's checkable, what's believed, what's open, and who owns it

**Status:** reconciliation index for an **active discovery phase**. Written 2026-07-26, after five
independent strategy documents landed in two days from separate branches.

> **Nothing in this body of work is ratified, and nothing here ratifies anything.** The project is in
> open strategy discovery, exploration and pressure-testing — **every document, ticket and position
> from the last few days is deliberately re-openable, including the ones that read most confidently
> and including the ones a maintainer voiced while thinking out loud.** Re-litigating is the point
> right now, not a failure mode.
>
> This file's job is therefore **not** to lock anything down. It is to make pressure-testing cheaper:
> show where the arguments actually collide, separate claims that are *checkable against the tree*
> from claims that are *asserted*, and stop the same question being re-derived in a fourth document
> by someone who could not see the first three.

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

## 2. Checkable facts vs. working positions

**Nothing below is a decision.** The useful distinction in a discovery phase is not
decided-vs-open — it is **what can be checked against the tree** versus **what is currently
believed**. The first constrains every option; the second is what you are pressure-testing, and all
of it is fair game.

An earlier draft of this section split these into "ratified" and "converged," and filed a
maintainer's mid-exploration directional calls under *ratified*. That was wrong twice over: it
hardened thinking-out-loud into commitment, and it is the exact gravity `PUBLISH_LOOP.md`'s banner
warns about — *"a confident design creates gravity even when filed as gated"* — with an index's
extra reach, because a summary is what later readers actually read.

### 2a. Facts about the product as it stands

Not positions. Checkable in the tree, most of them enforced by tests. An exploration that assumes
otherwise is starting from a false premise — which has already happened twice this week (§5.1, §5.6).

- **`birta.network.enabled` ships off, and the consent keys are `application`-scoped** so a
  workspace cannot flip them (MAR-179, MAR-199 — shipped, guarded).
- **There is no Birta account and no Birta server.** Zero identity infrastructure exists today.
- **There is no source editor and no CodeMirror dependency.** "Edit Raw Markdown" delegates to VS
  Code's own text editor. Any "source mode" lever is the host's, not ours.
- **Byte-fidelity is enforced, not asserted** — round-trip corpus, move-fuzz, `toolFidelity`,
  destructive-save guard, CI perf gates on launch and typing.
- **Every network capability that ships today is read-or-render only.** Nothing uploads document
  content.

### 2b. Working positions currently held — all re-openable

These are where the thinking sits *right now*. Listed with **how much is behind each one**, because
that is what tells you where pressure is worth applying — not because weight confers authority.

| Position | What's behind it | Where to push |
|---|---|---|
| **Stay on ProseMirror** — custom core, Rust/WASM, Lexical, and CM6 *as the rich-text engine* are out; Wordgard is the watch item | The heaviest thing here: **MAR-102**, dated, ~45 adversarially verified claims, with its own re-check trigger (the MAR-41 seam). `ENGINE` §4 agrees independently | Its own trigger. Wordgard reaching 1.0 with a markdown story would genuinely reopen it |
| **Never roll a CommonMark parser or a rich-text view** | `ENGINE` §1's own-vs-rent argument; broader than MAR-102 | Weakest if the remark↔PM *bridge* cost (MAR-101) turns out higher than assumed |
| **CM6 as a *raw-source companion* is a different question and is not ruled out** | `MULTI_SURFACE` §15; orthogonal to MAR-102 | Not a position so much as a distinction — but it has already been conflated once, so keep it explicit |
| **Web = a cloud product, not a port** — local-files-in-a-browser is dead outside Chromium desktop | An external platform fact (FSA is Chromium-desktop-only) plus a maintainer directional call made mid-exploration (`MULTI_SURFACE` §0.5a) | The platform fact is solid; **"therefore cloud" is the inference, and that's the soft part** |
| **The extraction is Writer-scoped, not a portfolio-wide editor factory** | `MULTI_SURFACE` §0.5c — a mid-exploration correction, explicitly recorded as reversing an earlier draft | Reversed once already; treat it as live |
| **Rung 0 reach is free and gated on nothing** (MAR-228/229) | Unanimous across every document — but unanimity among documents that read each other is one opinion, not four | Nobody has actually said "do it." The cheapest thing here, and still not chosen |
| **The connector posture** — native cards, per-provider auth, `SecretStorage`, **no hosted auth broker**, render-only (MAR-198) | Maintainer direction 2026-07-23 + a hardened invariant list. Better specified than most of the docs — and **still exploration** | No document owns it at all (D10). Its VS-Code-only mechanisms are the unexamined part |
| **The AI posture's floor** — no cloud generation, no file-editing agent, no AI detector, no telemetry style-learning, no AI-first branding | `AI_ASSISTANCE` §4's argument, consistent with everything shipped | The floor is a document's assertion. The line *above* it is flagged open (D7); the floor itself is no more settled |

---

## 3. The open-decision register

Every genuinely open question, once. Four documents each ended with an "open decisions" list; those
lists overlap heavily and the same crux appears in four of them. The per-document lists remain for
context, but **this table is the one to work from** — one question, one place.

**"Decision" here means a question that will eventually need answering, not one that is being asked
for an answer now.** In a discovery phase most of these should stay open on purpose; the value of
the register is seeing which are *load-bearing for others* (D1 gates nearly everything) and which are
cheap to close (D8 is one line and is currently blocking board sequencing). Closing a row early is
worse than leaving it open.

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
7. **Corrections to *this* file, twice over (2026-07-26).** First pass, §2 presented one flat list of
   things "decided — do not re-litigate," mixing a dated decision record (MAR-102) with unanimous
   document recommendations (Rung 0, the AI floor) — the exact gravity-manufacturing failure
   `PUBLISH_LOOP` warns about, committed by the file whose job is to prevent it. Second pass split
   that into "ratified vs. converged" — **also wrong**, because it filed a maintainer's
   mid-exploration directional calls (`MULTI_SURFACE` §0.5, MAR-198) under *ratified*, hardening
   thinking-out-loud into commitment during an explicitly non-ratifying phase. Now split by
   **evidence type** instead: §2a is checkable against the tree, §2b is currently believed and fully
   re-openable. *Two passes to stop turning arguments into decisions is itself the finding:* a
   summary document's default gravity is toward premature settlement, and it has to be pushed back
   deliberately, more than once.
8. **`AGENTS.md`, `README.md` and `POSITIONING.md`** now say plainly that none of this is measured or
   committed scope, so the framing survives outside this file.
9. Separately, §6's "index, not a container" rule was violated by §3 D10 on arrival — now a known,
   named exception with a fix, rather than a rule the file quietly breaks.

---

## 6. Keeping this honest

- **§2a is for things you can check; §2b is for things people currently believe.** The line between
  them is *evidence type*, not confidence. A position does not graduate into §2a by being argued
  well or repeated often — only by becoming true of the tree. Nothing graduates by being asserted
  loudly in a document, and nothing graduates because a maintainer said it while thinking aloud.
- **When something genuinely is decided, it will need a third home** — a dated record with a
  re-check trigger, the way MAR-102 is written. Do not add that section speculatively, and do not
  quietly promote §2b entries into it. Until then, a question resolved gets struck from §3 *and*
  from the source document's own list; two copies of an open question is how one crux ended up
  argued in four places.
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
