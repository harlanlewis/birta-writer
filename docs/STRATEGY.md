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

Six documents landed between 2026-07-24 and 2026-07-26. Each has exactly one question it is the
authority on; where they overlap, the owner column is who wins.

| Document | Owns | Status | Tracking |
|---|---|---|---|
| [`MULTI_SURFACE_INVESTIGATION.md`](MULTI_SURFACE_INVESTIGATION.md) | **The host-adapter engineering**: the capability taxonomy (§14), the `HostServices` seam, the shell inventory, the raw-editor design (§15) | Investigation; nothing measured. Its *prioritization* is superseded (§2 below); its *engineering* stands | MAR-225 |
| [`SURFACE_STRATEGY.md`](SURFACE_STRATEGY.md) | **Which surface, for whom, and whether at all**: the market read, the ICPs, the probe-first recommendation | Pre-commitment exploration; self-red-teamed | MAR-233, MAR-234 |
| [`PUBLISH_LOOP.md`](PUBLISH_LOOP.md) | **The document-lifecycle axis** — local↔cloud publishing. Orthogonal to surface | Gated design record. Presumes an undecided scope gate | MAR-232 |
| [`AI_ASSISTANCE.md`](AI_ASSISTANCE.md) | **The AI posture** — surface-independent | Posture record | MAR-236 |
| [`ENGINE_AND_DIALECT_STRATEGY.md`](ENGINE_AND_DIALECT_STRATEGY.md) | **Own vs. rent across the editing stack**, and dialect mapping | Decision framework | MAR-235, MAR-237, MAR-238 |
| [`research/writing-app-landscape.md`](research/writing-app-landscape.md) | **The evidence base** for the standalone-app market (companion to [`research/markdown-editor-landscape.md`](research/markdown-editor-landscape.md), which covers Markdown *inside VS Code*) | Research; verification gaps flagged inline | — |

**The one thing none of them owned, and this file now does:** the *union* — the deduplicated decision
register (§3) and the reconciled sequence (§4).

---

## 2. What is actually decided (do not re-litigate)

These are settled. Three of them were re-argued from scratch in a later document that did not know
the earlier answer existed; that is the failure this section exists to stop.

- **Stay on ProseMirror.** A custom core, Rust/WASM, Lexical, and CodeMirror 6 *as the rich-text
  engine* are ruled out (**MAR-102**, ~45 adversarially verified claims). Wordgard is the only
  sanctioned watch item. `ENGINE_AND_DIALECT_STRATEGY.md` §4 reaches the same conclusion
  independently — treat MAR-102 as the citable record and §4 as its own-vs-rent framing, not a
  second answer.
- **Never roll a CommonMark parser or a rich-text view.** Rent remark and ProseMirror forever; own
  merge semantics and our custom nodes (`ENGINE` §1).
- **CM6 as a *raw-source companion* is a separate question and is not ruled out** — that is
  `MULTI_SURFACE_INVESTIGATION` §15, and it is orthogonal to MAR-102. Be precise about which "CM6"
  is meant; the two have already been conflated once.
- **Web is not "the port, but harder."** Local-files-in-a-browser is a dead end outside Chromium
  desktop (File System Access API is Chromium-desktop-only; Safari and Firefox ship only OPFS). A
  web surface is therefore a *cloud* product with server problems, not a port. `MULTI_SURFACE` §8's
  extensive FSA/OPFS analysis is the **PWA/fallback tier**, already self-demoted in its §16.1 —
  `SURFACE_STRATEGY` §3(c) re-derives the same verdict; they agree, and neither is new evidence
  against the other.
- **The editor core extraction is Writer-scoped**, justified by two real surfaces — not a
  portfolio-wide editor factory (`MULTI_SURFACE` §0.5c). The Birta Labs portfolio shares brand and
  tooling, not an editor.
- **Rung 0 reach is free and uncontested.** Open VSX (MAR-228) and a vscode.dev web-extension scope
  (MAR-229) deliver reach at near-zero marginal cost. **Every** document that reaches a
  recommendation includes them; nothing gates them.
- **The AI posture's floor.** No cloud generation, no agent that edits the file, no AI detector, no
  telemetry-backed style learning, no AI-first branding (`AI_ASSISTANCE` §4). The
  generative-vs-analytical line above that floor is *open* (§3).

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
| **D7** | **Generative or analytical-only AI?** The conservative reading keeps Birta's AI analytical (proofread, tells, structure); the less conservative allows on-request, local, accept-first rewrite. Genuinely open — the §2 floor holds either way | `AI_ASSISTANCE` §7, §8 | What a new surface's headline feature is | Nothing external; a maintainer call. The §2-floor work (MAR-236) is safe under both readings |
| **D8** | **Where does `phase-5-surfaces` rank?** Linear carries the label; `AGENTS.md`'s spine stops at phase-4 and has never been updated, so the rank is *undefined* and the "first High down the spine" rule cannot be evaluated. Four `High` phase-5 items now sit unranked while the ranked spine has no High at all | MAR-141 (board guide) · `AGENTS.md` §"Sequencing signal" | Every future session's pick | A one-line maintainer call, then update `AGENTS.md` — this is the cheapest open item on the board |
| **D9** | **Identity sequencing** — the drawn wordmark/glyph (MAR-209, `BRAND.md` is still a discovery plan) before or after any non-extension surface? Standalone surfaces front-run it | `MULTI_SURFACE` §9, §12.7 | Any public surface launch | Maintainer call; already owner-blocked with MAR-134 |

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

**A suggested reading that costs nothing to adopt:** run MAR-234 first; run MAR-228 in parallel
because it is free; treat MAR-226 as surface-agnostic design that pays off under every branch; hold
MAR-227 and MAR-233 until MAR-234 returns. Nothing here commits to D3.

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

---

## 6. Keeping this honest

- **A decision resolved goes in §2 and is struck from §3** — and from the source document's own list.
  Two copies of an open question is how the same crux ended up argued in four places.
- **This file is an index, not a container.** It must not restate the arguments; link to the document
  that owns them. If a paragraph here starts explaining *why*, it belongs in the owning document.
- **Every strategy document carries a `Tracking:` line.** `AI_ASSISTANCE.md` shipped without one and
  its recommendations went untracked for two days as a direct result.
- **Nothing in any of these documents is measured.** Every rating, effort estimate, and market read
  is a prior. The probes exist to replace them with data; until they return, quote these documents as
  *arguments*, never as findings.
