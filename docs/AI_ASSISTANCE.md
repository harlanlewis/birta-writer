# AI & agent assistance — a posture, not a feature list

**Status:** strategic thinking / posture record. No implementation, nothing measured. Written 2026-07-26.

**Tracking:** **MAR-236** — the §8 "do now, betrays nothing" work (structural-rhythm tell,
per-writer protect-list, voice-preservation framing). *(This document shipped without a tracking
line — the only strategy doc that did — and its recommendations went untracked for two days as a
direct result. Filed 2026-07-26.)* The still-open generative-vs-analytical question (§7, §8) is
open decision **D7** in [`STRATEGY.md`](STRATEGY.md) §3.

**Where this sits:** [`STRATEGY.md`](STRATEGY.md) indexes all six strategy documents. This one is
**surface-independent by design** — everything in §3 and §6 is available on the VS Code extension
today, and none of it waits on the surface question ([`SURFACE_STRATEGY.md`](SURFACE_STRATEGY.md)).

> This document answers one question: *what should Birta's relationship to AI be, in 2026, in a way
> that fits its principles rather than betraying them?* It is a **posture**, deliberately upstream of
> any feature. It extends — does not restate — `docs/DESIGN_PRINCIPLES.md` §"Annotation is advisory,
> reversible, and quiet" and §"Maintained dependencies" into the AI era, and it is surface-agnostic
> (it applies to the VS Code extension as much as to any future mobile/web app). The competitive
> evidence lives in [`docs/research/writing-app-landscape.md`](research/writing-app-landscape.md);
> the surface/product reading lives in [`docs/SURFACE_STRATEGY.md`](SURFACE_STRATEGY.md).

> **On confidence.** The 2026 market claims below come from a July-2026 web research pass; on-device
> feasibility figures are cited but move fast. Treat model sizes, API-stability dates, and pricing as
> "true when written, verify before betting on."

---

## 1. The one-paragraph landscape

Every incumbent is sprinting in the direction Birta's principles forbid: **cloud-based, generative,
agent-writes-your-document.** Grammarly — the company that *invented* the advisory-underline pattern
Birta already ships for proofreading — [rebranded to Superhuman in Oct 2025](https://www.grammarly.com/blog/company/announcing-company-rebrand-to-superhuman/)
and repositioned from proofreader to AI-agent productivity suite, **vacating the quiet-advisory lane.**
Word/Docs both draft whole sections from a prompt; ChatGPT Canvas and Claude Artifacts made the model a
co-author *inside* the document; Notion shipped autonomous multi-step Agents (and [leaked data through
them once](https://simonwillison.net/2025/Sep/19/notion-lethal-trifecta/)). Simultaneously, three
counter-currents are gaining real 2025–2026 momentum and all three point at Birta's exact posture: a
measurable **consumer AI backlash** (multiple surveys put "AI fatigue" above 50%); a **"keep your voice /
anti-slop"** movement with genuine open-source traction; and — decisively — **private on-device inference
became shippable** on both mobile (Apple Foundation Models framework) and web (Chrome's Prompt API went
stable; WebLLM/WebGPU at ~80% native). For the first time you can do useful rewrite/proofread with **no
network call at all.**

**The whitespace, stated once:** *an AI writing assistant that never sends your words anywhere, never
writes for you, and exists to keep your prose sounding like you — not like everything else.* Birta
already ships two-thirds of it (the advisory proofreader ethos and the fidelity/consent architecture);
the 2026 unlock is that the tasks small local models do *well* are exactly the advisory ones Birta's
principles *permit*, and the tasks they do *badly* are the ones its principles *forbid*.

---

## 2. The principle this extends

`DESIGN_PRINCIPLES.md` already states the rule, for proofreading: **advisory, reversible, quiet;
nothing changes the file without consent; the user can always go quiet; a master gates its children.**
And the **maintained-dependency consent ladder**: *auto-maintain only what the user created through the
editor; when a premise vanishes, withdraw or cue — never silently rewrite the user's own prose.*

**AI assistance is not a new principle — it is the same principle applied to a more powerful engine.**
The stakes are simply higher: a proofreading underline that misfires is noise; an AI edit that misfires
is *someone else's words in your document*, and (because Birta is byte-faithful) *wrong bytes in your
file*. Every AI capability must therefore inherit, not renegotiate, the existing contract.

Two structural advantages Birta gets for free, that incumbents cannot easily copy:
- **Fidelity-scoped by construction.** Birta already guarantees editing one region never rewrites
  another. Its AI can inherit that guarantee: a suggestion touches only the selection, never the
  document globally — the opposite of the canvas/agent model where the model rewrites everything.
- **Consent-laddered by construction.** The "suggest → user commits → one undo restores everything"
  machinery already exists (proofreading fixes, accepted calc results, anchor renames). AI suggestions
  slot into that ladder rather than inventing a new consent model.

---

## 3. Patterns that FIT Birta

1. **Advisory inline flags + hover-to-fix, nothing auto-applied.** Birta's existing proofreading
   pattern, validated by Lex ("an editor, not a ghostwriter") and *old* Grammarly. The liked,
   now-abandoned-by-the-leader lane.
2. **On-device / in-browser inference for *bounded* tasks** — rewrite-a-selection, tone shift,
   summarize, "AI-tells" detection — via Gemini Nano / Chrome Prompt API (web) or Apple Foundation
   Models / MLX (mobile/desktop). The small-model quality envelope (see §5) matches advisory scope
   exactly. Gate any model download behind explicit opt-in.
3. **Agent-as-suggester, human-as-committer.** Every suggestion states *why* and *what to do*; one undo
   restores everything; the model never touches unselected regions. This is what the 2026 HCI literature
   *independently prescribes* to preserve voice and control ([arXiv 2601.10236](https://arxiv.org/abs/2601.10236),
   [arXiv 2504.05008](https://arxiv.org/pdf/2504.05008): constrain the model so it doesn't generate central
   elements, keep the human making the creative decisions). Birta's consent ladder is the correct pattern,
   not merely the safe one.
4. **The protect-list / "surface the collision" pattern.** A per-writer list of signature phrases,
   deliberate fragments, and uneven cadences the tool must never flatten; on conflict it *shows* the
   tension rather than resolving it. This is a near-exact external analogue (see the open-source
   `anti-slop` tool) of Birta's own maintained-dependency ladder — arrived at independently, which is
   corroboration that the pattern is right.
5. **Anti-slop as a voice-preservation *lens*, not a verdict.** Birta already flags AI-writing tells
   offline (vocabulary, em-dash habits, non-ASCII punctuation, boilerplate). The anti-slop consensus adds
   one concrete, shippable enhancement: **structural rhythm uniformity is the #1 tell, above vocabulary**
   — Birta's detector currently scans the *second*-most-important signal. A "does this read like *you* or
   like the machine?" lens — deterministic, explained, accept-first — rides the cultural wave without
   touching the toxic detector arms race (see §4).
6. **BYO-key as the pragmatic bridge.** Where a task genuinely needs a frontier model, Craft's
   "bring your own OpenAI/Anthropic key" model keeps Birta out of the data path and the billing path.
   Egress is then the user's explicit, per-key choice — consistent with `birta.network.enabled` shipping
   off. (This is a bridge, not the destination; the destination is on-device.)

---

## 4. Patterns that BETRAY Birta (name them so they're not drifted into)

1. **Cloud generation / whole-document drafting** ("draft this section"). Violates local-first *and*
   advisory-not-authoring. Non-starter.
2. **The agent-edits-your-file model** (Canvas/Artifacts/Cursor-for-prose). Acting on the file unprompted,
   global rewrites, multi-step autonomy — breaks "advisory, reversible, quiet" *and* "editing one region
   never rewrites another" in one move.
3. **Context-vacuuming** (pulling in mail/drive/calendar; live-data MCP artifacts). Antithetical to
   "content never leaves the device."
4. **Ghost-text autocomplete that drifts into authoring.** The homogenized-voice failure mode; produces
   the documented "ownership without voice" split. If any completion ever ships, strictly opt-in *per
   invocation* and short.
5. **An "AI detector" / "humanizer" / AI-score.** A trap, and worth stating plainly: detection is a
   losing arms race (2026 accuracy 65–90% with false-positive rates to ~29%; [61% of genuine non-native-English
   essays wrongly flagged in one Stanford study](https://proofreaderpro.ai/blog/ai-detection-accuracy-2026);
   OpenAI killed its own detector). It is also an ethical minefield (probabilistic accusation, biased
   against non-native speakers) and would make Birta a *policing* tool. **Birta's angle is never "is this
   AI?" — it is "here are specific habits that make *your* prose read as generic; here's why; fix if you
   agree."** Deterministic, voice-serving, immune to the arms race because it never renders a verdict.
6. **Telemetry-backed "learns your style in the cloud."** Voice-matching (Lex, Sudowrite) depends on it.
   Birta may do voice-learning *only* if it stays 100% on-device — otherwise it silently becomes the
   surveillance pattern it exists to reject.
7. **Auto-applying "fixes" to the user's own prose.** The consent ladder forbids auto-rewriting anything
   the user didn't create *through* the editor. Suggestions to the user's own sentences are always
   accept-first.
8. **AI-first branding.** The backlash data says foregrounding "AI-powered!" now *reduces* engagement for
   a privacy/craft audience. Lead with "yours, private, human," never with the model.

---

## 5. The on-device feasibility envelope (honest limits)

This is what decides whether "private AI" is a real feature or vapor. **Verdict: real in 2026, with
hard ceilings to design around.**

- **Mobile (native):** Apple's **Foundation Models framework** (iOS 26+, expanded WWDC 2026) exposes an
  on-device model in a few lines of Swift; Apple explicitly frames it as *not* a general chatbot but for
  "language understanding, structured output, tool calling" — which *is* Birta's use case. MLX/llama.cpp
  run 1–8B models well. **A webview/Capacitor app reaches these only through a native bridge**, not from JS.
- **Web (browser):** the **Chrome Prompt API + Gemini Nano** went stable (Chrome 148); any origin can run
  local inference offline after a one-time per-origin model download (~min 4GB RAM). **WebLLM/WebGPU** runs
  Llama-3.2-1B / Phi-3-mini / Gemma-2B fully in-tab at ~80% native once cached.
- **The ceilings (do not gloss):** comfortable band is **1–3B params** in a browser tab, ~8B max quantized;
  **≤8GB devices struggle**; first-run is a multi-hundred-MB download (gate behind opt-in); **iOS webviews
  get ~300–450MB before the tab is killed.**
- **The direct consequence for Harper:** Birta's offline proofreading engine is ~300MB resident WASM —
  **at or above the iOS webview kill threshold *before the editor even loads*.** Offline Harper in a mobile
  webview is effectively **Red**; mobile proofreading must be a smaller model, a native-side service, or
  degrade to the existing eval-free heuristics. (Cross-referenced in `SURFACE_STRATEGY.md`.)
- **The asymmetry that makes this work:** a 1–3B model is genuinely good at *bounded* tasks — grammar,
  local rewrite of a selection, tone, summarize, pattern-detection — and genuinely bad at long-form
  reasoning, factual recall, and whole-document authoring. **The tasks it does well are precisely the
  advisory ones Birta permits; the tasks it does badly are the ones Birta forbids anyway.** Disciplined
  smallness is a feature, not a limitation.
- **Precedent:** Obsidian's local-GPT / Ollama plugins already ship "ChatGPT-quality, nothing leaves the
  device, works offline" to a privacy-minded audience — proof of both demand and feasibility.
- **Surface implication (feeds `SURFACE_STRATEGY.md`):** private on-device AI is *easiest on a native
  mobile shell*, where Apple's Foundation Models framework hands you a resident model through a native
  bridge — no browser download, no Harper-in-a-webview OOM. It is *hardest on cloud-web*, where "on-device"
  either means a big WebLLM download or isn't on-device at all. So the AI posture and a **native mobile**
  surface reinforce each other, while AI on cloud-web would undercut the privacy claim — a genuine (if not
  decisive) argument that *if* Birta adds a surface and *if* AI is part of its identity, native mobile fits
  the AI story better than cloud-web.

---

## 6. The uniquely ownable posture

- **Private-by-construction, not private-by-policy.** Not "we don't train on your data" (a promise) but
  "there is no network call" (a fact) — the claim no cloud incumbent can match, landing hardest against
  Birta's stated security/health-tech bar. It's the same posture as `birta.network.enabled` shipping off.
- **Voice-preservation as the thesis, not a feature.** Turn the tells-detector into a positive "sounds
  like *you* vs. like the machine" lens: deterministic flags, structural-rhythm awareness, a per-writer
  protect-list, every finding explained, nothing auto-applied.
- **On-request local rewrite, never ambient generation.** Selection + explicit invocation + accept/decline
  diff (Lex's UX, but local and byte-faithful). The consent ladder and one-undo-restores-everything are
  guarantees the global-rewrite incumbents structurally cannot offer.
- **Honest scoping reads as trustworthy.** "We only do what a small model does *well* and *privately* —
  proofread, tone, summarize, keep-your-voice — and we hand every decision back to you." In a market
  drowning in over-promising, hallucination-prone agents, disciplined smallness is the differentiator.

---

## 7. Red-team / open questions

- **Is the audience big enough?** The anti-slop movement is real but small; the privacy-minded-writer
  audience exists (Obsidian local-AI plugins prove it) but is a niche. Treat the AI posture as
  *reinforcing Birta's identity*, not as a standalone go-to-market.
- **First-run download UX** (hundreds of MB per origin/app) is a real web-app cost — opt-in gates it, but
  it's friction. On mobile, the native bridge sidesteps it (system model already resident).
- **Small-model quality is good-not-great.** Never let it near long-form or facts; degrade gracefully on
  weak hardware rather than shipping a bad rewrite.
- **"Voice-learning" is a slippery slope to telemetry.** If it ever ships, on-device-only is a hard
  constraint, not a default.
- **Does *any* generative feature belong in "a document editor"?** The most conservative reading of the
  canon is that Birta's AI should stay *analytical* (proofread, tells, structure) and stop short of
  *generative* (rewrite/summarize) — matching iA Writer's provenance-only restraint. The less
  conservative reading is that on-request, local, accept-first rewrite is still advisory. **This is a
  genuine open decision, not a settled one** — flagged for the maintainer.
- **Sequencing vs. surfaces.** None of this requires a new surface. The cheapest first step is extending
  the *existing* offline proofreader (structural-rhythm tell, protect-list) in the VS Code extension —
  pure upside, no platform bet, and it sharpens the identity a mobile/web app would later lead with.

---

## 8. Where this nets out

- **On values** (local-first, private, advisory, keep-your-voice): a natural, arguably inevitable
  extension — Birta already ships the ethos and the architecture.
- **On the generative/analytical line**: undecided, and should stay so until the maintainer chooses.
  The safe, high-ROI, surface-independent moves (structural-rhythm tell; protect-list; framing the
  tells-detector as voice-preservation) are available *now* and betray nothing.
- **The one-line recommendation:** *lead with private-by-construction and keep-your-voice; ship only
  what a small local model does well and hand every decision back to the user; extend the existing
  offline proofreader first, and treat on-request local rewrite as an opt-in bridge — never ambient
  generation, never an agent that edits the file, never an AI detector.*
