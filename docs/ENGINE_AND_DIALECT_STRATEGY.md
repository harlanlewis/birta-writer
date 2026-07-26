# Engine & dialect strategy — own vs. rent across the editing stack

**Status:** strategy / decision framework. No implementation. Written 2026-07-26.

**Tracking:** proposed Linear items in §7 (to be filed under `phase-*` once triaged).
Related: **MAR-100** (the ProseMirror funnel — the inventory this rests on),
**MAR-101** (evaluate removing Milkdown — sharpened here), **MAR-40** (multi-format),
**MAR-41** (the `FormatModule` seam), **MAR-128** (per-tool fidelity fixtures),
**MAR-225** (multi-surface epic — the collaboration/cloud forcing functions).

**Questions this answers:**
1. Should Birta carry in-code associations between constructs and the dialects
   (Obsidian, Confluence, Notion, …) they belong to — and what would make that
   valuable (e.g. a future sync/mapping layer)?
2. When, if ever, is it right to replace ProseMirror and/or Milkdown with our
   own engine — considering performance (large-doc open/edit), compatibility,
   and fidelity? What would owning it buy, and is any of it worth publishing?
3. The broader "own vs. rent" question underneath both, including **WASM**.

> **Scope.** This is a decision framework, not a plan. Where it and the
> maintained docs (`README.md`, `docs/BENEFITS.md`, `docs/MULTI_SURFACE_INVESTIGATION.md`)
> disagree about what Birta *is today*, those win.

---

## 0. The one distinction that makes both questions answerable

"The parser" and "compatibility" each hide a **four-layer stack** the codebase
already keeps apart. Almost every wrong answer comes from collapsing them.

| # | Layer | What it is today | Where its cost/risk lives |
|---|-------|------------------|---------------------------|
| 1 | **Parse** | md bytes → mdast → PM doc (remark + `@milkdown/transformer`) | Large-doc *open* — but see §3, parse is usually *not* the open bottleneck |
| 2 | **View / edit** | the ProseMirror `EditorView` | Large-doc *typing* (per-keystroke reconciliation over `contenteditable`) |
| 3 | **Serialize** | PM doc → mdast → md bytes (remark stringify + fidelity serializer) | On save; plugin-entangled |
| 4 | **Merge** | serialized bytes vs. saved bytes → minimal edit (`@birta/minimal-diff`) | On save; scales with doc size; **entirely ours, already extracted** |

Milkdown-the-framework *wraps* 1–3 but **is not** any of them. Its load-bearing
contribution is the **mdast↔ProseMirror bridge** (the transformer + preset
schemas), not the ctx/plugin sugar. `pm.ts` (MAR-100) inventories the raw-PM
surface; it does **not** inventory the transformer surface. That gap is the true
scope of MAR-101 (§4).

---

## 1. The decision rule

> **Own the layers whose spec is *ours*; rent the layers whose spec is
> *external and adversarial*.**

- **CommonMark** and **`contenteditable`** are the two "everyone underestimates
  them" tar pits. Rent them forever — remark (layers 1/3) and ProseMirror
  (layer 2). Decades of edge cases; months of our time would not close the gap.
- Our **merge semantics** (layer 4) and our **custom nodes** (calc, wikilinks,
  notion callouts, directives) are *our* spec. Own them — we do.
- The maintainer's stated humility about battle-testing is correctly aimed: it
  bites **only in the rented layers**. In the owned layer — round-trip
  persistence — we have battle-testing *no incumbent has*, because nobody ships
  it as a product.

Two corollaries that decide sequencing:

- **Reversibility.** Growing the corpus / publishing minimal-diff is additive
  and reversible → do freely. Dropping Milkdown is reversible-ish → do when
  triggered. Dialect tags features depend on are sticky → resist. Replacing
  remark or ProseMirror is near-irreversible → requires a forcing function, not
  a preference.
- **Maintenance / bus factor.** remark (Titus Wormer) and ProseMirror (Marijn
  Haverbeke) are one-maintainer-grade but *the best code we depend on*; Milkdown
  is a thin, self-labeled-early-access layer. Sustainability says reduce
  exposure to the *thinnest* dependency (drop Milkdown) and never take ownership
  of the *highest-quality* ones (keep remark + PM). This reinforces §4's
  conclusion from a non-performance direction.

---

## 2. The real moat is the test harness, not any layer's code

The reason we *could* safely swap a bridge, port minimal-diff to WASM, or adopt
a new parser someday is that `roundTripCorpus` + the move-fuzz suites +
`toolFidelity` (MAR-128) would catch the regression. **That harness — not any
single layer — is the asset**, and it is the cheapest of everything here to
grow. Deepening the corpus (more real-world-messy documents, more dialects) is
what de-risks every other bet in this document and should out-rank the parser
question in priority. Every "own more of the stack" move below is only as safe
as the corpus is broad.

---

## 3. Performance — where large-doc cost actually lives

- **Open** cost on large docs is dominated by ProseMirror's *first paint* (the
  `paint` span — first DOM build + layout), **not** by parsing. Measure the
  `mdw:` User-Timing marks (`webview/perf.ts`, `pnpm perf`) before assuming
  parse speed is the lever. A faster parser (layer 1) may optimize a
  non-bottleneck.
- **Typing** cost on large docs is layer 2 — per-keystroke view reconciliation.
  This is largely inherent to `contenteditable` + PM's decoration model; **any**
  rich-text engine pays a version of it. "Just virtualize ProseMirror" is *not*
  an easy win — selection/coordinate mapping across un-rendered content is one
  of the hardest, least-solved problems in the whole PM ecosystem.
- **The escape hatch already exists.** Source mode (CodeMirror) renders by
  viewport and pays no WYSIWYG reconciliation. **Defaulting very large documents
  to source mode** is the cheapest large-doc lever we have and needs no new
  engine. (Typing is gated in CI by `typing-perf` on `xlarge` — MAR-224.)

**Implication:** performance is a weak argument for replacing either engine.
The strong perf levers are host-side (source-mode default, decoration budgeting,
lazy NodeView mounting), not a new document model.

---

## 4. Milkdown / ProseMirror — when (not) to replace

**Never roll a CommonMark parser or a rich-text view from scratch.** That is the
second-system trap in its purest form (CommonMark's spec is a 600-case
adversarial suite; micromark is a hand-tuned state machine that exists *because*
"markdown looks easy to parse" has killed a dozen parsers). If we ever leave
remark it is a **lateral move to another mature engine**, never a hand-rolled
one — and the value of doing so is near-zero while the risk is the entire
fidelity story.

**MAR-101 is not "roll a parser" — it is "own the remark↔PM bridge."** Dropping
Milkdown keeps remark and ProseMirror and deletes the `@milkdown/core`
ctx/plugin/preset layer, but *we* then own the transformer (mdast↔PM) and the
schema definitions Milkdown's presets currently supply. That is a real, bounded
cost — not a trivial delete. Pull it only when a **forcing function** fires,
measured, not felt:

- **Bundle/launch:** `@milkdown/*` framework bytes show up in `perf:bundle` /
  `launch-perf` as eager cost we cannot lazy-load. (A number, via the funnel —
  not a feeling.)
- **Lifecycle friction:** we are repeatedly fighting `ctx`/plugin ordering to do
  what raw ProseMirror would allow directly (we already carry several
  "register after preset, before chrome" ordering hazards).
- **Forced-migration parity:** a Milkdown major breaks us and the migration cost
  approaches the drop cost anyway → drop instead of migrate.

Until one fires, Milkdown works and removing it is motion without value. The
funnel means we can start the day one fires.

**Collaboration is a stronger forcing function on the model layer than perf will
ever be.** If the multi-surface cloud/sharing surface (MAR-225) ever wants
real-time collaboration, that reshapes layer 2 decisively — and the mature
answer is Yjs, which has first-class **ProseMirror** bindings. That is an
argument to *stay on ProseMirror specifically*, and to keep persistence
(minimal-diff) cleanly separable from a future CRDT sync path.

---

## 5. WASM — why, when, and where it actually fits

WASM earns its place only where all three hold: the work is (a) CPU-bound and
hot, (b) **pure** — no DOM, no plugin-ecosystem entanglement, (c) big enough
that the JS↔WASM **marshalling cost** (copy input in, result out) does not eat
the speedup. Across the stack:

| Layer | Hot? | Pure / un-entangled? | Verdict |
|-------|------|----------------------|---------|
| Parse | only large docs | **No** — remark plugins + our custom nodes | **Bad fit.** Adopting a Rust parser (comrak/pulldown) means abandoning the remark ecosystem *and* re-implementing every extension in Rust; and open-time is paint-bound, not parse-bound |
| View | per keystroke | **No — it *is* the DOM** | Impossible (WASM has no DOM) |
| Serialize | on save | **No** — plugin-entangled | Bad fit |
| **Merge (minimal-diff)** | **yes, every save, scales with size** | **Yes** — pure LCS over strings, zero deps | **The only real candidate** — and only if measured save latency demands it |

Minimal-diff is the clean WASM candidate for exactly the reasons it was
extracted: self-contained, pure, no DOM. But the cons bite even there, and
several collide with our own principles:

- **Bundle bytes.** A WASM blob is 100s of KB against a *gated* launch ceiling
  (`perf:bundle`). Lazy-loading it means it is absent for the first save after
  open → we keep a JS fallback → we maintain **two** implementations.
- **Marshalling.** Copying a large serialized string into linear memory and the
  diff back out can erase the algorithmic win. Benchmark end-to-end, never the
  LCS in isolation.
- **SIMD/threads need cross-origin isolation** (`COOP`/`COEP`) we may not control
  inside a VS Code webview — so WASM's best modes may be off the table.
- **Toolchain/debugging tax** against a plain-TS, esbuild, solo-maintained
  codebase — ongoing, not one-time.

**Conclusion:** do not reach for WASM to make parsing fast. Reach for it *only*
if minimal-diff save latency shows up on `xlarge`, treat it as an optimization
of a package we already own, gate it on a real measurement, and price in the JS
fallback. The cheaper large-doc lever (source-mode default, §3) comes first.

---

## 6. Dialect associations & compatibility

**Keep two concerns explicitly separate:**

- **Persistence is, and must stay, dialect-*blind*.** Birta round-trips
  Obsidian embeds, Foam's LRD shim, Confluence-ish and Notion-ish constructs not
  because it knows their provenance but because it preserves bytes it does not
  model (`toolFidelity` invariant A). This is *the* fidelity guarantee — it must
  never become dialect-conditional. The BENEFITS compatibility table is
  descriptive documentation of emergent behavior, not a runtime association.
- **Affordances are already selectively dialect-*aware*.** `wikiLinkComplete`,
  the notion-callout input rules, Logseq handling — authoring help keyed to a
  dialect. This is legitimate and can grow; it is a *different axis* from
  persistence.

**Would explicit provenance metadata pay for itself? Only if a consumer exists.**
Metadata with no consumer rots (the repo's "no speculative hooks" rule). Two
possible consumers:

1. **The affordance layer** (real today) — a provenance registry would let
   dialect-aware authoring help be declared once rather than scattered.
2. **A sync/mapping layer** (hypothetical) — a Confluence→Obsidian map is
   fundamentally a *per-node, per-dialect renderer table* (`highlight` → `==x==`
   vs `<mark>` vs Confluence storage markup; `embed` → `![[x]]` vs
   `<ac:image>`; three callout syntaxes we already juggle). That table is the
   "association" the question imagines — and it is **not editor state**.

**Confluence specifically breaks the premise that any of this belongs in the
editor.** Confluence is not markdown-on-disk — it is XHTML "storage format" /
ADF over an API. There is nothing for a file serializer to round-trip;
"Confluence compatibility" is an *import/export/sync* problem against a canonical
AST, not a serialization concern. That is the tell that dialect mapping lives in
a **separate layer** that speaks mdast-plus-extensions, not in
`webview/serialization.ts`.

**And rent that layer too.** The same own-vs-rent discipline applies:
**pandoc already maps Confluence↔markdown↔everything.** If a sync layer is ever
real, build only the *edges pandoc does badly* — our custom nodes (calc, notion
callouts, wikilink flavors) ↔ canonical AST — and delegate the rest. Owning a
general dialect mapper is the compatibility-layer version of rolling our own
parser.

**Cheap, non-speculative step now:** the `toolFidelity` fixtures already *are*
the provenance inventory (machine-verified, dialect-by-dialect). Add a
structured provenance field at dialect-specific *registration* sites (near-zero
cost) so both a future affordance-registry and a future mapper have a
machine-readable source — without building either consumer speculatively.

---

## 7. Recommendations & proposed tracking

**Do now (additive, reversible, high-leverage):**

1. **Grow the fidelity corpus** — more real-world-messy documents and more
   dialects. This is the moat (§2) and de-risks everything else. *(Proposed:
   `phase-0-fidelity` improvement.)*
2. **Harden `@birta/minimal-diff`'s internal API + README**, leading with the
   novel part — **FormatProfile + round-trip protection**, not "an LCS differ."
   Keep it an in-repo workspace package. **Publish to npm only if external pull
   materializes** — the OSS-maintenance tax (semver, issues, API freeze) is a
   real liability against a deliberately tight-scope solo project. *(Proposed:
   `phase-1-performance`/tooling improvement, gated on demand.)*
3. **Add structured dialect-provenance fields** at dialect-specific registration
   sites, feeding off the existing `toolFidelity` inventory. No new consumer
   built. *(Proposed: small `phase-2-syntax` improvement.)*

**Do when a measured trigger fires (not before):**

4. **Sharpen MAR-101** to state its real scope — "own the remark↔PM bridge" —
   and its three trigger conditions (§4). It is a bridge-ownership refactor, not
   a parser project.
5. **Large-doc source-mode default** as the first perf lever (§3), ahead of any
   engine or WASM work.

**Explicitly do NOT do (absent a hard forcing function):**

6. Roll a CommonMark parser or a rich-text view from scratch (§4).
7. Replace remark or ProseMirror for performance (§3/§4) — attack perf host-side;
   stay on PM for the Yjs/collab path (§4).
8. Adopt WASM for parsing; if ever, only for the minimal-diff core, measured
   (§5).
9. Build a general dialect mapper; rent pandoc, own only the custom-node edges
   (§6).

---

## Crosslinks

- [`MULTI_SURFACE_INVESTIGATION.md`](MULTI_SURFACE_INVESTIGATION.md) — the surface axis (MAR-225)
- [`research/markdown-editor-landscape.md`](research/markdown-editor-landscape.md) — engine selection rationale
- [`BENEFITS.md`](BENEFITS.md) — the compatibility table these fixtures back
- [`../webview/pm.ts`](../webview/pm.ts) — the MAR-100 funnel (the inventory §4 rests on)
