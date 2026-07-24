# Brand & identity — principles and discovery plan

How the **outward identity** of Birta Labs (parent) and Birta Writer (product) gets
decided — the fixed principles any exploration must satisfy, and the ordered plan for
running the exploration. It exists so a proposed logo, wordmark, palette, or piece of
voice can be checked against intent instead of taste alone. Living document: add to it
when a decision turns out to be load-bearing.

The organization does not exist yet; this is the groundwork that comes *before* a mark.
It defers to the canon and must not restate it:

- **Thesis & priorities** → `README.md` § "Why this fork" — the north star and the
  fidelity › parity › syntax › interaction ordering.
- **Scope** → `docs/BENEFITS.md` — Birta Writer is *a document editor*.
- **Naming decision** → `docs/POSITIONING.md` and Linear **MAR-134** — why *Birta*, the
  runners-up, the rejected candidates, and the external publishing/legal tasks.
- **The word itself** → `docs/research/birta-name-meaning.md` — meanings, etymology,
  cultural weight, sensitivity.

**Boundary vs `docs/DESIGN_PRINCIPLES.md`:** that file governs *how the in-product UI
communicates* (decoration semantics, `--vscode-*` theming, how much the editor may
interrupt). This file governs the *identity the company and product wear in the world*
(mark, wordmark, visual theme, voice). They meet at exactly one seam — the app/extension
icon — and where they do, the in-product theming constraints in `DESIGN_PRINCIPLES.md`
win.

---

## The starting advantage — the name is already the concept

Most identity work starts from a blank concept and reverse-engineers a story. Here the
etymology hands us one, and it lands on the product thesis almost exactly:

> *birta* (Icelandic) — the **quality of light** (the ambient glow, not a lamp); and the
> verb **to publish / reveal / bring to light** (*birting* = a publication, and also
> daybreak).

That is the product in one word: the raw source *brought into the light and shown
plainly*. So our job is **not** to invent meaning — it is to *render* an already-loaded
word without falling into its own clichés. Treat this coherence as an asset to protect,
not decoration to add.

---

## The gating decision — brand architecture

Nothing visual can be resolved until we fix how Labs and Writer relate, because that
decides whether we are designing *one flexible system* or *two things*.

| Model | Here | 
|---|---|
| **Branded house (shared mark)** | One *Birta* mark; Labs vs Writer differ by the suffix word (and possibly a mark *state*). Cheapest, most coherent, scales to future products (*Birta X*). |
| **Endorsed** | Writer gets its own identity, "by Birta Labs" as endorsement. Overkill this early. |
| **House of brands** | Independent identities — throws away the shared name's equity. Wrong. |

**Recommendation: branded house with a shared icon.** The monogram does the recognition;
"Labs" / "Writer" (and later product words) are the differentiator. This is the first
decision to lock — Phase 0 below.

### The variation model — a constant core, an expressive descriptor

Within the branded house, treat the wordmark as two parts with different jobs:

- **The constant — *Birta* + the monogram.** One resolved logotype for the word *Birta*,
  and one rigid `b` mark, identical across every product. This is the recognition anchor
  and the equity that compounds — it is the favicon, the app icon, the avatar, and it
  never flexes.
- **The variable — the product descriptor.** *Writer*, *Budget*, *Reader*… each gets its
  own typographic voice: Writer might be a fluid, contemporary thick-ink stroke; a
  hypothetical *Budget* structured and solid. The descriptor is where a product's
  personality — whimsy, seriousness, flair — is allowed to live.

The grammar of the name carries this for free: *Birta* is the noun/verb (the house), the
product word is the modifier (the thing). The brand structure mirrors the language, which
is what makes it feel inevitable rather than applied.

**What stays fixed for the family to hold — vary the personality, fix the geometry.** The
word *Birta* and the monogram; the lockup geometry (how the descriptor aligns to *Birta* —
shared baseline / optical size ratio, spacing, clear space); and monochrome. Only the
descriptor's *letterform character* moves. Two lockups in the identical skeleton with
different-temperature descriptors still read as one company; change the skeleton and the
family fragments.

**The tradeoff, going in.** This buys per-product personality at the cost of a typographic
decision per product and a system harder to police than a rigid one. Mitigate by defining
the axes a descriptor may move along (weight · structure · contrast · fluidity) as a small
playbook, so variation is guided, not a free-for-all. It is the recommended model, but the
central thing to pressure-test in Phase 2–3 is exactly *how much descriptor variance the
constant can absorb before it stops reading as one company* — mock several products and
squint.

---

## Principles

The fixed stars. A proposal that fights one of these is a signal to rethink the proposal.
Grouped by what they constrain.

**Two scopes.** *Universal* principles bind *Birta* **and** every product descriptor.
*Signature* principles bind the constant *Birta* only — a product descriptor may range
beyond them (that is the whole point of the variation model above), but never below the
universal floor: monochrome, no clip-art/props, value-not-hue where light is expressed,
and legible at minimum size. Signature principles are tagged below; the rest are
universal.

### Meaning

1. **Concept over shape.** Every candidate must be explainable in one sentence that ties
   back to *birta* (light / reveal / publish). The name gives us this for free; a mark
   that needs a paragraph of justification, or none, is off-brief.
2. **Render light, don't depict a light.** *Birta* is the *quality* of light, not a
   source. This bans the obvious executions — sun, ray-burst, lightbulb, lens-flare — and
   points instead at *value* (how light falls) and *negative space* (the space light
   fills). "About light without drawing a light" is the whole game.
3. **The Icelandic tie stays quiet.** Use the word accurately; never invent a false
   origin story or lean on Nordic mystique. No flags, runes, glaciers, aurora. The
   warmth of the word carries the heritage; kitsch would misrepresent it
   (see `birta-name-meaning.md` § sensitivity).

### Form

4. **Design in black and white first.** The mark must be fully resolved in one value
   before colour is considered. Colour is decided last and is **never load-bearing** — if
   the identity only works in colour, it isn't finished.
5. **Value, not hue.** Where light is expressed, express it through value contrast and
   flat tone — no gradient as the defining feature, ever. (A two-value split is fine; a
   gradient is not.)
6. **Humanist, not cold.** *(Birta's signature.)* The word is warm. The default
   "Icelandic = cold minimal blue-white" move is not just generic, it *misreads the
   word*. Curves, optical warmth, a humanist hand — closer to the wordmark sketches
   (ARIA / FLOW / CURVE / STRUCTURAL) than to a cold geometric grotesk. A product
   descriptor may run colder or more structured if the product calls for it (a *Budget*
   reading serious and solid is appropriate); the constant *Birta* stays humanist and
   carries the warmth for the family.
7. **Plain, not decorated.** *(Birta's signature.)* The product's value is plainness —
   real files, minimal diffs, nothing between you and the source. The constant should
   feel the same: honest, unfussy, confident. The descriptor is the one sanctioned place
   for flair — but flair *within the universal floor* (monochrome, no props, legible),
   never drop shadows, bevels, glass, or effects that vanish in one colour. Between two
   candidate *constants* that are otherwise close, the plainer wins.
8. **No literal props.** No pen-nibs, no document/page shapes, no cursors. Apple isn't a
   computer; Birta isn't a page. Appropriateness ≠ depiction.

### System

9. **The icon carries the distinctiveness the word can't.** "Birta" is a common Icelandic
   noun *and* an approved given name — weak on legal distinctiveness alone (MAR-134 tracks
   clearance). A distinctive mark is ownable in a way the plain word may not be; lean on
   the mark for ownability.
10. **One family from a fixed core and a variable descriptor.** The constant (*Birta* +
    monogram) does the coherence work; the product descriptor carries personality (see
    the variation model above). Differentiate products by the descriptor's voice, not by
    redrawing the core. Guardrail: fix the geometry, vary only the character.
11. **It's a set, not a lockup.** Plan for primary / horizontal / stacked / icon-only /
    monogram from the start, with clear-space and minimum-size rules — not one hero
    arrangement retrofitted later.

### Voice

12. **Say it plainly.** Brand voice matches the docs and the product: matter-of-fact,
    precise, English-first, warm without hype. State what a thing is and why it matters;
    never marketing copy. ("Publish", then "Published" — not "Effortlessly illuminate
    your workflow.")

---

## Concept territories to explore

Divergent directions to put on the wall — *exploration space, not chosen answers*. All
share the lowercase **b** (the initial for both Labs and Writer) and treat its **counter**
(the enclosed space) as where light lives.

**In scope:**

- **Lit counter** — the counter as a held void of light; the quietest, most typographic
  answer.
- **Reveal / negative space** — the counter opening or spilling; encodes *birta* the verb
  (to publish, disclose). Memorability from the unexpected break.
- **Value / illuminated form** — a form lit inside the counter, described only by the
  terminator between lit and shadowed. The purest take on Principle 2.
- **Figure/ground plate** — the letter *is* the light, knocked out of a solid ground;
  natural fit for the app-icon end of the family.

**Benched (with reasons):**

- **Dawn / horizon** — on-meaning (*birting* = daybreak) but a visual cliché; needs an
  unexpected crop to escape generic, and probably not worth the risk.
- **Crescent / waxing** — expressive ("it's brightening") but flirts with a moon read and
  is the first thing to close up at small sizes.
- **Anything from Principle 2's ban list** — sun, bulb, rays, nib, page.

---

## Theme discovery — the visual world

The identity's *theme* (palette, type, motion, texture) is discovered in this order, so
the load-bearing decisions are made in the robust medium first:

1. **Value first.** Resolve everything in black and white (Principle 4). If it works
   here, it works everywhere.
2. **Typography second.** The wordmark is half the identity. Pair a humanist display face
   (the direction the ARIA / FLOW / CURVE / STRUCTURAL sketches point at) with a plain
   utility face for labels and UI. Custom kerning; possibly modified letterforms. Bad
   kerning is the amateur tell.
3. **Colour last, and thin.** If any colour enters, it is one warm value decided after
   the mark is final, chosen to reproduce reliably in one colour and to survive being
   removed. Warm, never cold (Principle 6). No palette-of-the-moment.
4. **Motion, only if it serves.** Restraint by default; a single considered moment beats
   scattered effects and reads less "generated."

Relationship to the product surface: the extension's *in-product* theming answers to
`--vscode-*` and `DESIGN_PRINCIPLES.md`, and it lives in both light and dark editor
chrome. The identity theme is separate and upstream; only the app icon has to satisfy
both, and there the in-product constraints win.

---

## The discovery plan

Phased, with an explicit owner-gate (a decision only the maintainer makes) closing each
phase. Don't start a phase before its predecessor's gate is decided.

- **Phase 0 — Architecture.** Choose the Labs↔Writer model (recommendation: branded
  house, shared mark). *Gate: model chosen.*
- **Phase 1 — Brief.** One page per brand: the three identities it must span (plain files
  · real editor · room to grow, from `POSITIONING.md`), attributes, the one-sentence
  concept, and an explicit do/don't drawn from the Principles above. *Gate: briefs
  signed off.*
- **Phase 2 — Divergence.** 3–4 genuinely different territory boards, black-and-white
  thumbnails only (from the list above). Breadth over polish. *Gate: 2 territories chosen
  to develop.*
- **Phase 3 — Filter.** Run the survivors through the test set (below). Kill what fails at
  16px or in one colour. *Gate: one direction chosen.*
- **Phase 4 — Resolve.** Typography pairing, custom kerning, the single colour/value
  decision, and the lockup family (primary / horizontal / stacked / icon-only /
  monogram). *Gate: mark + wordmark locked.*
- **Phase 5 — System.** Clear-space, minimum-size, misuse rules, and proofs in the real
  contexts: GitHub org avatar, marketplace / Open VSX tile, `birta.dev` favicon, README
  header, one-colour and knockout. *Gate: guidelines shippable.*

Legal clearance (USPTO / Nordic / EUIPO) and the publishing tasks run in parallel and are
already tracked in **MAR-134**; a mark can't be leaned on until it clears.

---

## Evaluation — the test set

The bar every candidate is measured against. Generic logo quality (simplicity,
memorability, scalability, versatility, appropriateness, timelessness, ownability, clean
construction) applies; these are the Birta-specific sharpenings:

- **Sketch-from-memory.** Someone who saw it for five seconds can redraw it. If not, too
  complex.
- **16 px and one colour.** Reads at favicon size and as pure black and pure white
  (knocked out). Thin voids and fine detail die here — this test alone may pick the mark.
- **Both grounds.** Works on light and on dark without redraw (org avatar, marketplace
  tile).
- **Beside three competitors.** Doesn't disappear in a marketplace grid of other
  extension icons.
- **Appropriateness.** Reads between dev-tool and consumer; warm, not clinical; plain, not
  decorated.
- **One-sentence concept.** Ties to *birta* (Principle 1).
- **Clearable.** Distinct enough to trademark and not confusable with a competitor
  (Principle 9).

---

## Open decisions & next actions

1. **Lock Phase 0** — pick the architecture model (recommendation: branded house with the
   constant-core / variable-descriptor variation model). Everything downstream depends on it.
2. **Resolve the monogram's scope** — does the shared `b` stay rigidly constant across all
   products (recommended — it is the recognition anchor), or may a product's *icon* pick up
   its descriptor's flavor? Fix this alongside Phase 0; it bounds how far personality reaches.
3. **Set the descriptor playbook** — the axes a product word may move along
   (weight · structure · contrast · fluidity) and the coherence-absorption limit found by
   squinting at several mocked products (Phase 2–3 output).
4. **Decide who executes** — maintainer, a hired designer, or agent-assisted exploration;
   this doc is the brief either way.
5. **Track it** — the *identity design* is planned work distinct from the MAR-134 rebrand
   residual; worth its own Linear issue (via `/devlog`) referencing this doc, so the
   design effort and the legal/publishing tasks stay linked but separate.
