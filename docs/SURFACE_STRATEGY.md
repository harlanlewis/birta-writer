# Surface strategy — should Birta be a mobile and/or web app, and for whom?

**Status:** strategic thinking / exploration. No implementation, nothing measured. Written 2026-07-26.

> **This is broad, pre-commitment exploration.** The maintainer asked to think through a Birta mobile
> app (or a web app to start) "in a very broad exploratory mode while we plan the future." Nothing here
> is decided or queued. Its job is to *re-open* a question the earlier surface work had closed, with
> evidence that work didn't have.

> **Relationship to the existing surface docs (read this first).**
> [`docs/MULTI_SURFACE_INVESTIGATION.md`](MULTI_SURFACE_INVESTIGATION.md) (MAR-225) is the deep
> **host-adapter / code-sharing** investigation. It reached three conclusions this document
> deliberately re-examines: **desktop (Tauri) first, web last, and mobile essentially not
> considered.** Those conclusions were sound *on the evidence it had* — but it was framed entirely as
> "how to port the editor to new hosts," and by its own admission (§13) "no thread red-teamed the
> premise," nothing was measured, and it never surveyed the *market* the new surfaces would enter.
> This document adds the three evidence streams it lacked:
> 1. the **competitive landscape** ([`research/writing-app-landscape.md`](research/writing-app-landscape.md)) — where the market gap actually is;
> 2. the **mobile/web technical reality** (a fresh feasibility pass, §3) — the axis the prior doc skipped;
> 3. the **2026 AI opening** ([`AI_ASSISTANCE.md`](AI_ASSISTANCE.md)) — a differentiator orthogonal to surface.
>
> It does **not** supersede MULTI_SURFACE_INVESTIGATION's engineering (the capability taxonomy, the
> `HostServices` seam, the save-contract work in MAR-226/227 all stand). It challenges its
> *prioritization*. The orthogonal *document-lifecycle* axis lives in
> [`PUBLISH_LOOP.md`](PUBLISH_LOOP.md) (MAR-232).

---

## 0. Method, and how to distrust this document

This document is the synthesis of a four-stream research fan-out (competitive landscape, AI landscape,
mobile/web feasibility) plus Birta's canon. Before its conclusions, its **biases**, stated plainly so a
reader discounts them correctly — this is the red-team the first draft owed itself and the same failure
MULTI_SURFACE_INVESTIGATION §13 admitted ("no thread red-teamed the premise"):

1. **Framing bias — the biggest one.** Every research stream was briefed to *find where competitors
   violate Birta's principles, because that's the opening.* That framing manufactures its own
   conclusion: point four agents at "find the gap" and they find a gap. The "five-legged intersection is
   empty" finding is real, but it is **evidence of a gap, not evidence the gap is worth filling.** No
   stream was tasked with the null hypothesis ("Birta should *not* build a new surface," or "the
   intersection is empty because it isn't valuable").
2. **Empty-gap ≠ opportunity.** A market gap can be empty for three very different reasons: nobody has
   built it yet (opportunity), it's technically too hard (§3 says this is partly true), or **nobody wants
   it** (unexamined). Specifically: *do the users in ICP A actually want to compose long-form Markdown on
   a phone, or only quick-edit/capture?* This document assumes the former and never tests it. If mobile
   Markdown is mostly a *reading and light-editing* surface, the whole "WYSIWYG-on-mobile gap" is far
   less valuable than §1 implies.
3. **No demand evidence exists — and I should say so.** A backlog scan (2026-07-26) found **zero tickets
   requesting a mobile or web app**, no user filings, no demand signal. The multi-surface epic (MAR-225)
   is **maintainer-vision-driven, not pull-driven.** That is legitimate for a founder-led product, but it
   means every ICP in §2 is *hypothesized*, not observed. The honest state is "plausible audiences,"
   not "identified demand."
4. **No market sizing.** I name ICPs but never estimate their size or willingness to pay. "Obsidian mobile
   refugee" could be 50 people or 500,000; nothing here distinguishes those, and the recommendation would
   differ enormously between them.
5. **Thin spots in the evidence base.** Some competitive sub-agents did not return before synthesis
   (parts of the iA/Ulysses/Typora and Logseq/Anytype detail are single-pass), and a few load-bearing
   facts were single-sourced. Two of the most decision-critical have since been **independently verified**:
   the File System Access API is confirmed [Chromium-desktop-only — Firefox and Safari ship only OPFS,
   no `showDirectoryPicker`](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) (so §3(c)
   "web is Red" holds), and the ProseMirror-mobile-typing risk is corroborated by Birta's own MAR-102
   (below). The rest should be re-verified before any spend.

**How to read the rest:** treat §1 as "the gap is real *if* the demand is real," and treat the whole
document as an argument for **buying the two cheap pieces of information that would confirm or kill the
thesis** (a mobile-typing probe and a demand probe, §6) — not as a case that the surface should be built.

---

## 1. The finding that reframes everything

The competitive survey produces one clean result: **the market gap is mobile/web-shaped, not
desktop-shaped.**

Sort every serious writing app by Birta's five defining legs — true WYSIWYG · byte-faithful plain
`.md` · cross-platform mobile/web · local-first privacy · not-a-PKM — and **the intersection of all
five is empty** (full table in the landscape doc). The closest competitors fail on *exactly the axes a
new surface would address*:

- **Typora** — the closest match on *feel* (WYSIWYG over real `.md`) — has **no mobile and no web, by
  explicit policy.**
- **iA Writer** — plain-file, great mobile — **isn't WYSIWYG** and has **no Android/web.**
- **Obsidian** — plain-file, cross-platform — **isn't true WYSIWYG, has no web app, and is PKM-shaped**;
  its own users' loudest unmet want is a *better mobile WYSIWYG editor for the files they already have.*
- The beautiful WYSIWYG apps (**Craft, Bear, Ulysses, Notion**) are all **proprietary-store and/or
  Apple-locked and/or cloud** — they surrender fidelity or privacy or reach.

So the thing Birta uniquely is — *a true-WYSIWYG editor over the user's own byte-faithful plain
Markdown* — is missing **precisely where a phone and a browser would put it.** The desktop-first plan
was optimizing code-sharing; it was not aiming at where the market is thin. **The negative space and
the surface question point at the same place: mobile and web.**

This does not automatically mean "build mobile first." It means the prior "web-last, mobile-never"
ordering was answering a different question (cheapest extraction) than the one the market poses
(largest unserved gap). Both matter; they now have to be weighed together, which §4–§6 do.

---

## 2. The crux nobody has answered: who is the user?

Both prior surface docs flag this as *the* unresolved question, and it is decisive here. From
MULTI_SURFACE_INVESTIGATION §13 and PUBLISH_LOOP §8: **the maintainer uses Birta *because* it sits in
VS Code beside git, diffs, and coding agents.** A standalone mobile/web app **deletes the stated reason
the product exists for its own creator.** That is not a fatal objection — but it means a mobile/web
Birta serves a *different* person, and **a different ICP is a new product, not a port.** Name them
before building for them. Candidates:

| ICP | Who they are | Why Birta wins for them | Risk |
|---|---|---|---|
| **A. The Obsidian/Logseq mobile refugee** | Owns a vault of plain `.md`, syncs it (iCloud/Dropbox/git), edits on desktop, *dreads* editing on their phone because mobile WYSIWYG is weak and they fear corruption. | Byte-fidelity is *the* fear-killer; opens their existing vault; true WYSIWYG on a phone is uncontested. **This is the sharpest, most defensible ICP** — a wedge into an installed base, not a cold market. | Depends on the mobile editor being genuinely good (§3's hard part). |
| **B. The privacy-first prose writer** | Journalist, clinician, lawyer, security-minded professional who wants iA-Writer calm + a real editor, and needs "nothing leaves my device" to be *true*. | Local-first + no-telemetry + on-device AI (`AI_ASSISTANCE.md`) is a checkable claim almost no one else makes; matches the maintainer's own health/security-tech bar. | Niche; may not pay; overlaps A. |
| **C. The "escape Notion" team/individual** | Tired of lock-in, lossy export, cloud dependence, subscription/agent-credit fatigue. | "Your file *is* the document; nothing to export" + fair pricing. | Bleeds toward wanting collaboration/PKM features that are off-thesis. |
| **D. The maintainer, mobile** | Wants to touch the *same* files Birta edits in VS Code, from a phone, occasionally. | Continuity of one fidelity model across surfaces. | A market of one; justifies a *companion*, not a product. |

**The honest read:** ICP **A** (and its overlap with **B**) is the real opening — and it is
*intrinsically mobile*, because that's where those users are underserved. ICP **D** alone justifies
only a thin companion. This is the first concrete argument that, *if* Birta expands, the pull is toward
mobile-for-A/B, not desktop-for-the-maintainer. It is not yet an argument that the expansion is worth
its cost (§6).

**Two honest qualifiers on this section (added in self-critique):**

- **Every ICP here is hypothesized, not observed.** There is no demand ticket, no user request, no
  waitlist (§0.3). Naming ICP A "sharpest" is an *argument*, not a *finding*. Before building for A, the
  cheapest possible test is to ask them: a demand probe (§6, and now tracked) — talk to a dozen
  Obsidian/Logseq mobile users, or post the concept, and see whether "I'd trust a WYSIWYG editor on my
  vault on my phone" produces real pull. This costs a week and can kill or confirm the whole thesis
  before a line of app code.
- **"Companion," not "replacement," is the reframe that de-risks the ICP shift.** §7 worries that serving
  ICP A/B means building for someone the maintainer isn't. But the sharpest version of A/B doesn't want a
  *new home* — they want **a better mobile editor for the vault they already keep** (in Obsidian, in git,
  in iCloud). So the on-target product is explicitly a **companion**: "open your existing folder of `.md`
  and edit it beautifully and safely on your phone," not "move into Birta." That reframing (a) shrinks
  scope enormously (no PKM features to chase, no migration, no accounts), (b) plays directly to Birta's
  one superpower (byte-fidelity on *someone else's* files — which it already does on desktop), and (c)
  keeps the maintainer's own file-first workflow intact rather than replacing it. It reduces the
  "different ICP = different product" risk from a rewrite to an *extension of the same promise onto a new
  screen.*

---

## 3. Technical reality — the editor, not the shell, is the project

A fresh feasibility pass (the axis MULTI_SURFACE_INVESTIGATION skipped) lands four verdicts.
**Confidence: measured/documented facts are cited; the ratings are priors, not estimates — a spike
replaces them with data.**

| Surface | Verdict | The binding constraint |
|---|---|---|
| **(a) Mobile app editing local `.md`** | 🟡 **Yellow** | Packaging + file access are *solved* (Capacitor + iOS document picker / Android SAF + git-as-sync — **Obsidian is the existence proof**). The real cost is the **ProseMirror-contenteditable mobile typing experience**, and Harper not fitting in the webview. Buildable and shippable; *great* requires heroics. |
| **(b) Mobile app backed by own cloud** | 🟡 Yellow | Clears file-access friction and App Store review easily, but **inherits the same editor risk** *and abandons local-first* — a step away from the brand for no editor-quality gain. |
| **(c) Cross-browser web app, local files** | 🔴 **Red** | **File System Access API is Chromium-desktop-only** — unsupported in Safari, Firefox, and *all* mobile browsers. "Edit a folder of `.md` in place" is not cross-browser in 2026. OPFS is sandboxed, not the user's files. Byte-fidelity in-place editing is impossible on the fallback path. |
| **(d) Cloud-backed web app** | 🟢 **Green** | Fully viable everywhere including mobile browsers; reuses the existing browser bundle nearly verbatim (swap the VS Code postMessage host for a server-backed host on the *same typed protocol*). Cost: **not local-first for the web surface.** |

Five hard truths carried from the feasibility pass, because they should govern the decision:

1. **The editor is the mobile project, not the shell.** Packaging, file access, git sync, and App Store
   approval are solved playbooks. A trustworthy **ProseMirror-contenteditable WYSIWYG typing experience
   on iOS *and* Android is an actively-maintained minefield in 2026** (IME/autocorrect, virtual
   keyboard, selection handles, per-keyboard composition quirks). And Birta's byte-fidelity guarantee
   *raises* the stakes: a dropped or duplicated IME character isn't a cosmetic glitch, it's **wrong
   bytes written to the user's file.**
2. **A cross-browser local-files web app does not exist in 2026.** Local-first on the web means
   "Chrome/Edge on a laptop," full stop. Everywhere else you are cloud-backed or doing upload/download —
   which breaks in-place byte-fidelity.
3. **Offline Harper on mobile web is effectively dead** (~300MB resident vs. ~300–450MB iOS webview kill
   threshold, before the editor loads). Mobile proofreading must be a smaller model, native-side, or
   cloud (see `AI_ASSISTANCE.md` §5).
4. **Tauri v2 is the desktop answer, not the mobile one** — its mobile tier is, per its own maintainers,
   "a foundation, not the finished story." For a webview-heavy editor needing mature file pickers today,
   **Capacitor** is the pragmatic mobile choice.
5. **The most successful local-first mobile markdown apps avoided this exact architecture** — Obsidian
   mobile uses CodeMirror, not a ProseMirror WYSIWYG; iA and Bear are native; Typora never shipped
   mobile. Birta *can* be the one that does WYSIWYG-in-a-webview well on a phone — but it would be
   **pioneering, not following a paved road.** That is simultaneously the whole opportunity (§1) and the
   whole risk (this §).

**Corollary — one artifact is needed on every path and should come first:** a **standalone raw-source
editor** (CodeMirror 6, lazy-loaded), already eyed in MULTI_SURFACE_INVESTIGATION §15. CM6 is the one
editor with a genuinely good mobile story; it is the mobile fallback when the WYSIWYG surface
misbehaves, *and* the source view VS Code used to provide for free. It is a no-regret build regardless
of which surface (if any) wins.

**A correction the first draft got wrong — the engine question is already decided, and it matters
here.** An earlier version of this doc floated "if mobile ProseMirror typing fails, use a different
editor engine (CM6-first, like Obsidian)." That collides with **MAR-102**, a deliberate, ~45-claim
decision record: *stay on ProseMirror; a framework switch to CodeMirror 6 or Lexical is ruled out; the
only sanctioned off-ramp is **Wordgard** (Marijn Haverbeke's PM successor, v0.1, a watch item — never a
self-built or CM6 core).* Crucially, MAR-102's reasoning names **IME/composition near an active
composition** as a top reimplementation hazard — i.e. Birta already concluded the mobile-typing problem
is real *and* that switching engines makes it worse, not better. So the honest picture is:

- **CM6 as the *main* WYSIWYG editor is ruled out** (MAR-102). Don't propose it.
- **CM6 as a *raw-source companion* is not ruled out** — that's exactly MULTI_SURFACE_INVESTIGATION §15's
  proposal and is orthogonal to MAR-102 (which is about the rich-text core). The two coexist; be precise
  about which "CM6" is meant.
- **The realistic fallback if PM-WYSIWYG-typing proves untrustworthy on mobile is not an engine swap —
  it is to make the mobile surface *source-first*:** lead with the CM6 source view (plus the per-block
  "source-peek" already tracked as MAR-20, the ProseMirror-appropriate cursor-reveal) as the *primary*
  mobile editing mode, with WYSIWYG as a render/review mode. That is a real, uncomfortable strategic fork
  — **mobile-Birta might be a different *primary mode* than desktop-Birta** even though both keep the same
  engine and the same byte-fidelity pipeline. It partially breaks "one editing experience everywhere,"
  and it's exactly what Probe 1 (§6) exists to force a decision on.
- **A *native* mobile editor** (leaving the webview to dodge PM's mobile quirks) is the Zed path MAR-102
  rules out for a solo maintainer: years of work, and it forfeits the shared bundle that makes any of
  this affordable.

---

## 4. The central strategic tension

Put §1–§3 together and the tension is sharp:

> **The surface the market wants most (mobile, local-files — ICP A/B) is the on-brand one but is
> Yellow, gated on an unproven editor-quality spike. The only Green surface (cloud-backed web) is the
> one that trades away local-first — the exact differentiator that makes Birta worth building.**

Two temptations to resist:
- **"Ship the Green one because it's Green."** A cloud-backed web app is the easiest to build and the
  easiest to *fund* — and it quietly converts Birta into a smaller Notion/Lex, competing on the axes
  (cloud, sync, accounts) where incumbents are strong and Birta is nothing special, while discarding the
  axes where it's unique. Green-to-build is not the same as green-to-*win*.
- **"Mobile is just the desktop port, harder."** No — the mobile *editor* is a distinct, unsolved
  engineering problem (§3.1) that dwarfs the host/shell work the prior investigation costed. Do not let
  the clean host-adapter seam create false confidence about the part the seam doesn't touch.

The way through the tension is **sequencing by information, not by ease**: spend cheaply to learn
whether the on-brand surface is achievable *before* choosing, so the decision is made on data rather
than on which option was easiest to start.

---

## 5. The option space

Five coherent paths, each judged against: negative-space fit · feasibility · brand fidelity ·
solo-maintainer sustainability.

- **Option 0 — Stay VS Code-only; harvest cheap reach.** Do MAR-228 (Open VSX → Cursor/Windsurf/
  VSCodium reach) and MAR-229 (vscode.dev web-extension → "Birta in a browser" reusing VS Code's whole
  shell). *Fit:* low (doesn't hit the mobile gap). *Feasibility:* Green. *Brand:* perfect. *Cost:*
  lowest. **The correct floor regardless of what else is chosen** — reach with near-zero marginal work.
- **Option 1 — Desktop (Tauri) first** (the existing MAR-225 plan). *Fit:* low — desktop is *not* where
  the market gap is (§1). *Feasibility:* Green-ish. *Brand:* perfect. *Cost:* full shell tax (raw editor,
  file browser, settings/keybinding engines, save model) for a surface aimed at the maintainer more than
  at an underserved market. Its best justification is as the *validation vehicle* for the core extraction
  — real, but that's an engineering benefit, not a market one.
- **Option 2 — Mobile companion, local-files (Capacitor), targeting ICP A/B.** *Fit:* highest — hits the
  uncontested gap. *Feasibility:* Yellow, gated entirely on the §3 typing spike. *Brand:* perfect
  (local-first, plain-file). *Cost:* the mobile-editor heroics are the risk; everything else is a known
  playbook. **The highest-upside, highest-uncertainty path.**
- **Option 3 — Cloud-backed web app.** *Fit:* medium (reaches everyone, but as a weaker-differentiated
  product). *Feasibility:* Green. *Brand:* the worst fit (surrenders local-first on the web surface).
  *Cost:* server + sync + accounts + a *new privacy contract* — a categorically heavier ongoing tax for
  a solo maintainer, and the PUBLISH_LOOP §3 "passive→active network actor" posture change. Only
  compelling if the cloud/sync *is* the point (a different product).
- **Option 4 — Hybrid, information-first (recommended shape).** Treat the next step as *de-risking*, not
  *building*: run the two cheap probes that collapse the biggest unknowns, do Option 0 in parallel, and
  let the probe results choose between Options 1/2/3. Details in §6.

---

## 6. Recommendation — buy information before committing

The single most valuable next act is **not** picking a surface; it's converting the load-bearing
guesses into measurements. All three probes below are cheap, throwaway, and reversible — exactly the
discipline the prior docs preached (MULTI_SURFACE_INVESTIGATION §16 "afternoon probe"; PUBLISH_LOOP §8
"validating probe") but for the axes they under-weighted. **Two are technical; the third — the one the
first draft missed — is about demand, and it is the cheapest and most decisive of all (§0.2–0.4).**

**Probe 1 — the mobile-typing go/no-go (new; the highest-information act).** Load the existing
`dist/webview.js` in a bare WKWebView (iOS) and Android WebView and *do nothing but type*: Gboard,
Samsung keyboard, iOS autocorrect, a CJK IME, selection-drag — and verify the **bytes written back
through the minimal-diff engine are correct.** This is the go/no-go gate for Option 2 (and for the whole
"mobile is where the gap is" thesis). Everything else about mobile is known-solvable; *this* is the only
part that can sink it. It should exist as a Linear issue under MAR-225 — it does not yet.

**Probe 2 — the standalone save probe (already tracked: MAR-227).** Mount `dist/webview.js` in a bare
page with a stub `HostServices` implementing *one* hard capability — save — end to end. Validates the
seam against real persistence for *any* non-VS-Code surface.

**Probe 3 — the demand probe (new; do this *first*, it's the cheapest).** Before either technical probe,
spend a week testing whether ICP A/B is real: talk to a dozen Obsidian/Logseq mobile users, or post the
one-line concept ("a WYSIWYG editor that opens your existing `.md` vault on your phone and never
corrupts a byte"), and watch for genuine pull — *and ask what they'd pay* (§8). If the desire isn't
there, no technical probe matters. This is the null-hypothesis test §0 says the research never ran.

**In parallel, Option 0** (MAR-228/229) — reach with near-zero marginal cost, and MAR-229 doubles as a
real-world "Birta in a browser" datapoint that informs the web question honestly.

**Then let the data choose:**
- **Probe 3 flat (no demand)** → stop here. Do Option 0 + the proofreader extension and keep the VS Code
  product as the whole product. This is a *completely defensible* outcome, not a failure.
- **Probe 3 positive + Probe 1 green** → Option 2 (mobile companion for ICP A/B) becomes the lead bet —
  the on-brand surface aimed at the real gap — with the CM6 source editor (§3 corollary) as its safety
  net, git/iCloud-provider as sync (not a custom cloud), and one-time/BYO-sync pricing (§8).
  **Architectural bonus: Capacitor-mobile can *be* the core-extraction validation host** — the second
  real consumer MULTI_SURFACE_INVESTIGATION §0.5c says the `HostServices` extraction needs — which means
  **desktop-Tauri-first is not a prerequisite.** The market-relevant surface and the extraction-validation
  surface can be the *same* build, instead of paying for a desktop app aimed mostly at the maintainer to
  validate an abstraction. This is the sharpest single revision to the prior plan.
- **Probe 3 positive + Probe 1 red/expensive** → the on-brand *WYSIWYG* mobile surface isn't cheaply
  winnable; fall back to the **source-first mobile** fork (§3: CM6 source view + MAR-20 source-peek as the
  primary mobile mode) rather than an engine swap (MAR-102), or to Option 1 (desktop as the extraction
  vehicle). Reconsider Option 3 only *if* a genuine cloud/sync product is wanted for its own sake, with
  the privacy contract and recurring-revenue model decided first (§8, PUBLISH_LOOP).
- **Either way**, extend the offline proofreader now (`AI_ASSISTANCE.md` §7: structural-rhythm tell,
  protect-list) — surface-independent, pure upside, and it sharpens the "keep-your-voice, private"
  identity any new surface would lead with.

**A synergy worth naming: mobile-native is where private AI is *easiest*, not hardest.** The
`AI_ASSISTANCE.md` opening (private, on-device, advisory) is *most* deliverable on a native mobile shell,
where Apple's Foundation Models framework hands you a resident on-device model for free through a native
bridge — no multi-hundred-MB browser download, no Harper-in-a-webview OOM (§3.3). So the on-brand AI
story and the on-brand mobile surface *reinforce* each other, whereas AI on cloud-web would undercut the
privacy claim. If the AI posture is a real part of Birta's future identity, that is an additional (not
decisive) thumb on the scale toward **native mobile over cloud-web.**

**Ordering principle (carried from the canon):** *fidelity must hold identically on every surface before
any surface adds a surface-specific feature.* On mobile that principle has teeth — it is exactly what
Probe 1 tests.

---

## 7. Red-team (the honest cost sheet)

- **Solo-maintainer sustainability is the binding constraint, not feasibility.** Each surface is a
  permanent tax (App Store review, certs, crash channels, per-OS QA, a settings UI VS Code gave free).
  The edit-once seam and a shared conformance suite (MULTI_SURFACE_INVESTIGATION §14) mitigate but don't
  erase it. The honest headline remains: *can one person sustain N surfaces without the shipping product
  rotting?* A mobile app with a bad-but-shipped editor is worse for the brand than no mobile app.
- **"The gap is mobile-shaped" ≠ "the gap is fillable by Birta cheaply."** §1 says the market gap is
  real; §3 says the one thing standing in it (mobile ProseMirror WYSIWYG) is the hard part. The
  opportunity and the risk are the *same fact*. Probe 1 is non-negotiable before believing §1's
  optimism.
- **The ICP shift is a product shift.** Building for ICP A/B means building for someone the maintainer
  isn't. That's legitimate, but it changes the feedback loop (the maintainer stops being the target
  user) and the roadmap (mobile users want share-sheets, offline reliability, and touch polish the VS
  Code product never needed).
- **Cloud-web is a one-way door on the brand.** "Nothing leaves your machine" is the deepest value; a
  cloud surface forces a *subtler* claim ("the app is served over the network, your bytes aren't" — and
  in sync mode, not even that). Decide the privacy contract *before* any web code, not after.
- **Fidelity does not port for free.** It holds today partly because VS Code's `TextDocument` normalizes
  newlines/encoding/BOM/atomic-write. Each surface reintroduces those as fresh round-trip hazards the
  corpus doesn't currently exercise (MULTI_SURFACE_INVESTIGATION §13). Re-prove per surface.
- **Everything here is inference from research + code, not from a running mobile build.** The ratings are
  priors. The probes exist to make them facts.

---

## 8. Money and the FSL — the axis the first draft omitted entirely

The first version of this document costed *engineering* effort and said nothing about *how a mobile/web
Birta would sustain itself* — a real omission, because the business model interacts with the brand, the
license, and the surface choice.

- **The VS Code extension is free and source-available; a paid app is a discontinuity, not a gradient.**
  Today there is no price, no account, no billing path. Introducing one on mobile/web is a new muscle
  (store billing, receipts, refunds, tax) and a positioning shift the *anti-rent-seeking* stance in the
  landscape doc (§10 there) has to be squared with. "Fair pricing against subscription fatigue" is a
  differentiator *only if Birta actually charges something* — a free forever app has no subscription to
  be fairer than, and a solo maintainer can't run cloud infra on nothing.
- **The FSL license shapes what's monetizable.** Birta is FSL-1.1-ALv2: source-available, non-compete,
  **auto-converting to Apache-2.0 two years after each release.** Consequences: (a) a *hosted* web
  service is protected from third-party re-hosting *for two years per release* — after that, any version
  is freely re-hostable, so a cloud business can't rely on code secrecy, only on operating the service;
  (b) a *local* app (desktop/mobile) monetizes as a product (one-time or subscription) where the FSL
  deters a competitor from shipping a rebranded build — adequate for a small product. **Decide
  per-surface licensing before pricing.**
- **The pricing archetypes the landscape validates:** one-time (Typora $14.99, iA per-platform) is
  beloved and fits a *local* app with no ongoing server cost; subscription (Ulysses, Bear Pro) is
  resented but is the only model that funds *sync/cloud* infra. This maps onto the surface choice: **a
  local-files mobile companion (Option 2) can be one-time or free-with-paid-sync and needs no cloud
  business; a cloud-backed web app (Option 3) *requires* recurring revenue and an accounts system** —
  another reason Option 3 is a heavier, different commitment, not just a harder build.
- **The cheapest honest model for the recommended path:** if the mobile companion (Option 2) proceeds,
  price it as a **one-time purchase or a small "bring-your-own-sync" free tier** (the user's own
  iCloud/Dropbox/git carries the files — no Birta server, no recurring cost, on-brand), with a paid tier
  reserved *only* if/when a genuine sync service is ever offered. This keeps the privacy/no-lock-in story
  intact and avoids standing up cloud infrastructure a solo maintainer would have to run forever.
- **Unknown, and it should be named:** willingness to pay for *this* is unmeasured (§0.4). The demand
  probe (§6) should ask the price question too, not just the desire question.

---

## 9. Open decisions for the maintainer

1. **Run the demand probe (Probe 3) first?** The null-hypothesis test the research skipped: is there real
   pull from ICP A/B, and would they pay? Cheapest and most decisive step; gates everything. (Strongly
   recommended.)
2. **Is expansion even wanted now**, given the solo-maintainer tax and that the VS Code product still has
   phase-0/1 runway? (Doing only Option 0 + the proofreader extension is a completely defensible answer.)
3. **Which ICP** — A (Obsidian/Logseq mobile refugee), B (privacy-first writer), C (escape-Notion), or D
   (maintainer's own mobile companion)? This choice, more than any technical one, determines the product.
   And is the product a **companion** to their existing workflow (§2, lower-risk) or a standalone home?
4. **Run Probe 1** (mobile-typing go/no-go) before committing to any mobile bet? (Strongly recommended —
   it's cheap and it gates the technical thesis.)
5. **If mobile: local-files (on-brand, Yellow) or own-cloud (easier, off-brand)?** — the §4 tension,
   stated as a choice.
6. **Could Capacitor-mobile be the core-extraction validation host, making desktop-Tauri-first
   optional?** (§6 — the sharpest revision to the prior plan; lets one build serve both the market and
   the abstraction.)
7. **Is a cloud/sync product wanted for its own sake** (Option 3 / the PUBLISH_LOOP)? If not, web stays a
   Chromium-desktop-or-nothing local surface, i.e. deprioritized — as the prior doc concluded, but now
   for the *measured* reason (§3c Red), not by assumption.
8. **Pricing & per-surface licensing** (§8): free / one-time / BYO-sync-free-tier / subscription — and
   decided *before* building, because it constrains which surface even makes sense.
9. **Generative AI or analytical-only?** (The open decision from `AI_ASSISTANCE.md` §7 — it shapes what a
   mobile app's headline feature even is, and note the native-mobile/on-device-AI synergy in §6.)
10. **Does desktop-first still hold as the *extraction* vehicle** even though it isn't where the market gap
   is — or does Capacitor-mobile (decision 6) replace it as the second host?

**Where this nets out (revised after self-critique):** the competitive gap, the (hypothesized) ICP pull,
and the AI opening *all point the same way* — **native mobile, local-first, as a companion for the
Obsidian/Logseq refugee and the privacy-first writer** — and the on-device-AI synergy and the
Capacitor-as-extraction-host insight make that lane cheaper and more coherent than the prior
desktop-first plan assumed. **But** the whole thesis rests on two unmeasured things the research was
framed not to question: *whether anyone actually wants to compose on mobile* (no demand evidence exists),
and *whether ProseMirror can type trustworthily on a phone at byte-fidelity* (MAR-102 says the hard part
is real). So the recommendation is emphatically **not** "build the mobile app." It is: **run the demand
probe and the typing probe — the two cheap tests that could kill or confirm the thesis in a fortnight —
harvest the free VS Code-family reach meanwhile, sharpen the private/keep-your-voice identity now (which
pays off regardless), and only then choose.** If either probe comes back flat, the right answer is
"stay VS Code-only, and that was the right call."
