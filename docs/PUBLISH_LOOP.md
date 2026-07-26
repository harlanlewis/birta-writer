# The publish loop — local-first documents, cloud-published, self-describing

**Status:** design sketch / thinking only. No implementation, nothing measured. Written 2026-07-26.

> **⚠️ This presumes a strategic gate the maintainer has not decided.** `docs/POSITIONING.md`
> explicitly holds "linked/structured knowledge" and anything beyond *a document editor* as an
> **"open question, not committed scope."** This document does not close that question — it exists
> to *inform* it. Read every "we would…" below as conditional on a decision that hasn't been made.
> A confident design creates gravity even when filed as gated; the honest framing is "here is what
> it would look like *if* we went there, and what it would cost the brand," not "here is the plan."

**Tracking:** Linear **MAR-232** (`phase-5-surfaces`, child of MAR-225). A gated *design record*
that holds the thinking; **not** queued work.

**Relationship to MAR-225 / `MULTI_SURFACE_INVESTIGATION.md`:** that investigation is about
*running the editor* on new surfaces (desktop, web) — the host-adapter axis. This is the orthogonal
axis: the *document's lifecycle* across a local↔cloud boundary. They converge at exactly one point —
the cloud web product (MAR-225 Rung 4) is the natural publish *destination* — and the publish loop
is what would make "the local editor" and "the cloud app" one product instead of two disconnected
editors that share a renderer.

---

## 1. Why this idea has unusually deep roots (the case *for*)

Before the critique, the honest case that this is on-mission — because it is stronger than a
feature request usually is:

- **The name literally means this.** `POSITIONING.md`: Icelandic *birta* = "to brighten / reveal /
  **publish**; the source brought into the light and shown plainly (*birting* = a publication)."
  The product is named for the act of publishing. That is not a bolt-on; it is the etymology.
- **It targets a *named* founding grievance.** README "Why I made it" is a list of pains about
  *piping content across systems* — transcripts → repos → Confluence → tickets → PRs → decks — and
  specifically **"copy-pasting across apps, losing all formatting and semantics."** A faithful
  publish path attacks that head-on, and does it with the one thing Birta is best at (fidelity).
- **There is a 15-year precedent.** README "Ancient history": Marlan (2011) was "a web-based local
  Markdown editor that synced through the Dropbox API." The local↔cloud loop is the maintainer's
  *original* thread returning with more foundation under it.

So the *mission and values* pull toward this. What follows is where the *current product's scope
and architecture* pull the other way — and they must be reconciled before any of it is built.

---

## 2. The one structural idea

> **The document is canonical and lives on the user's disk. "Publishing" is an explicit,
> per-document, reversible act that pushes a copy to a destination. The record of *what was
> published where* is a sync ledger — and *where that ledger lives is an open design question*
> (§4), because the obvious answer (in-file frontmatter) collides with a shipped guarantee.**

The loop is a *pull-the-trigger* cycle the user controls, not continuous background sync:

```
author locally ──publish──▶ destination(s)
      ▲                          │
      └───────sync back──────────┘
   (local file stays canonical; the ledger records the round-trip, auditable after the fact)
```

---

## 3. The posture change this represents (read before designing anything)

The most important thing to understand is that this is **not a feature addition — it is a change in
what the app *is*.** Today Birta is trustworthy precisely because it is *passive* toward the outside
world:

- BENEFITS states, twice, that **"the editor never writes or reverts your document on its own."**
  Its entire relationship to the outside is *detection*: it notices an external change (git, an
  agent, cloud sync) and surfaces it for the user to resolve. It initiates nothing.
- README "Why I use it" already names **"cloud sync"** — but as something Birta *coexists with and
  reflects*, not something Birta *is*. The committed role is good-citizen-beside-Dropbox, not
  be-the-sync-engine.

Publishing makes the editor, for the first time, **actively initiate a network write of your
document content.** That is a categorical shift from passive to agent. Every problem below descends
from that shift, so it is the thing to decide first: *do we want Birta to be an actor on the
network, or to stay the calm local citizen that other actors write around?*

---

## 4. The sync ledger — a mechanism in tension, not a settled choice

The proposal's original framing put the ledger *in the document's frontmatter*. That is attractive
(self-describing, portable, nothing stranded server-side) but it **collides with a shipped fidelity
guarantee**, so it must be presented as *one candidate*, not the design.

**The collision.** BENEFITS: "YAML frontmatter is handled **out of band** … immune to any editor
reformatting — key order, comments, and spacing are exactly as you left them." Today the editor
faithfully *reattaches what the user wrote*; it does **not author** frontmatter. A machine-maintained
`birta:` block (remote ids, content hashes, timestamps) is the editor **injecting and mutating**
state the user never typed — which surfaces in every git diff, in the rendered frontmatter table,
and to every other tool that reads the file. That is a genuinely new editor behavior, at odds with
the "your metadata is exactly as you left it" promise.

**The three candidate homes, none free:**

| Where the ledger lives | Buys | Costs |
|---|---|---|
| **In-file frontmatter** (original proposal) | Self-describing, portable, no server-side mapping, un-publish = delete the block | Editor now authors/mutates frontmatter (breaks the out-of-band guarantee); pollutes diffs + the frontmatter table + every other tool's view |
| **Sidecar file** (`doc.md.birta.json`) | Keeps the `.md` byte-pure; frontmatter guarantee intact | Breaks "self-describing/portable" — the relationship is now *two* files that can separate; a `.gitignore`'d sidecar loses the record entirely |
| **Host state** (settings/db, keyed by path) | `.md` fully untouched | Least portable of all; move/rename the file and the mapping dangles; contradicts "the file carries its own provenance" |

**The only durable claim is "the publication relationship should be recoverable and lock-in-free,"
not "it lives in frontmatter."** The trust model in §5 is what makes *any* of these safe; the
storage location is unresolved and should stay that way until a real destination forces the choice.

Illustrative shape (whichever home wins), one entry per destination — a *thinking aid, not a spec*:

```yaml
birta:
  published:
    - target: birta-cloud          # a NAME; its URL + token resolve out-of-band (never in the file)
      remoteId: doc_abc123
      publishedAt: 2026-07-26T12:00:00Z
      sourceHash: sha256:9f8e…     # bytes last pushed → drift is detectable
      status: clean                # clean | local-ahead | remote-ahead | diverged
```

Hard constraint regardless of home: **secrets never live with the ledger.** `target` is a name; the
URL + credential resolve out-of-band, because the record might be committed to git or shared.

---

## 5. Trust model — who owns the truth

Three stores, none authoritative alone:

1. **The on-disk file** — canonical *content*. Always wins for "what the document *is*."
2. **The ledger** — canonical *intent* ("this document is meant to be published to X"). Advisory
   about remote state; re-verifiable; deliberately the **weakest** link (a rebuildable cache).
3. **The remote** — canonical for *its own* live state (id, last-received hash, remote-side edits).

Because the ledger is a rebuildable cache and the content lives in a file the user holds, nothing
irreversible is lost if the ledger is corrupted or deleted — which is exactly what keeps the design
lock-in-free, and is the property that survives no matter which §4 home is chosen.

---

## 6. The four edges — and where they reuse vs. invent

| Edge | What happens | Reuse? |
|---|---|---|
| **Publish (first time)** | Push bytes, remote mints an id, write a ledger entry. | New host `publish()` capability + the existing serializer. |
| **Re-publish (update)** | Local hash ≠ ledger hash → push. If remote also moved → **diverged**, surface a conflict, never overwrite. | *Philosophy* reused; the 1:1 disk↔editor conflict UI does **not** cover N remotes (see §8). |
| **Pull (remote → local)** | Remote changed → fetch, present as an inbound external change, user accepts/rejects. | `externalChanges.ts` + minimal-diff — the strongest reuse. |
| **Un-publish** | Remove server-side (best-effort) + delete the ledger entry. Local file untouched. | — |

The status field is the same three-way comparison Birta already does (disk vs editor), generalized
from two stores to three (disk vs ledger vs remote). That generalization is real reuse; the *UI* for
resolving it across multiple destinations is not (§8).

---

## 7. The cheaper, in-scope sibling — exhaust this first

The founding grievance is **"copy-pasting across apps, losing all formatting and semantics."** The
publish *loop* (stateful, bidirectional, cloud-backed, account-bearing) is a large swing at it. But
the same grievance is hit — more cheaply and entirely *within the document-editor scope* — by
**lossless export / smart paste** into the systems the maintainer actually pipes into:

- copy-as-Confluence-storage-format, paste-into-Substack-intact, export-to-Google-Docs-with-semantics;
- `birta.copyFormat` already ships (markdown vs richText, rich HTML always included), and **smart
  paste is already named as next-up** (README "Why this fork" §4 — "with smart paste still ahead").

This sibling:

- stays inside *a document editor* (no platform creep, no PKM drift);
- needs **no** cloud, accounts, sync ledger, or privacy reconfiguration;
- plays *to* Birta's fidelity strength instead of against it (faithful format translation is the
  same muscle as faithful round-trips);
- and directly answers the pain the maintainer actually wrote down.

**This is the publish-loop analog of MAR-225's "Rung 0" lesson:** exhaust the cheap, in-scope reach
before committing to the big surface. If lossless export satisfies the grievance, the stateful loop
may never need to exist. Worth its own ticket, ranked ahead of this one.

---

## 8. Self-critique (red-team) — the honest cost sheet

- **It presumes an undecided strategic gate** (the banner up top). Publishing/destinations/sync is
  the feature-space of the platforms the maintainer is *fleeing* (Notion, Confluence, Obsidian
  Publish). Building it risks becoming the thing he's tired of. `POSITIONING.md` keeps this an open
  question on purpose; this doc must not quietly close it.
- **The privacy contract cannot just absorb this.** Privacy is the deepest brand value (security +
  health-tech background, "nothing leaves your machine," offline by default). The two current
  network exceptions are deliberately tiny — unfurl *reads* a title, embeds *render* a card;
  **neither uploads your content.** Publishing uploads the whole document: a new *class* of
  capability, categorically heavier than anything behind `birta.network.enabled` today. It likely
  needs its own consent architecture, not a third checkbox under the existing master switch.
- **Who is the user?** (MAR-225 §13's crux.) The maintainer uses Birta *because* it sits in VS Code
  beside git and agents — and he *already publishes* via git and existing pipes. A cloud publish
  loop may serve a *different* ICP than its creator. Name that user before building for them; a
  feature whose only justification is a hypothetical audience is a different product, not a port.
- **Every concrete destination is already-solved or a fidelity nightmare.** Static site / git repo →
  he already has that (the beachhead). Confluence / Substack / Ghost → each has its own storage
  format that mangles Markdown, so publishing *faithfully* is the inverse of Birta's one strength.
  The flagship "birta-cloud" destination → doesn't exist. The abstraction floats above every real
  target; it needs a *first concrete destination* to become honest.
- **The frontmatter ledger is in tension with a shipped guarantee** (§4) — the mechanism is
  unresolved, not chosen. The §4 illustrative schema is almost certainly too simple for real
  destinations anyway; the durable claim is "recoverable + lock-in-free," not the keys.
- **Multi-destination divergence** multiplies the conflict surface beyond what the elegant 1:1
  disk↔editor model covers; the *presentation* of several simultaneous divergences is unexamined.
- **Nothing is measured.** The validating probe (if ever green-lit) is a
  publish → edit-remote → pull round-trip against a stub destination — the publish-loop analog of
  MAR-227's save probe.

---

## 9. Where this nets out

- **On mission/values** (local-first, portable, anti-lock-in, anti-copy-paste, *the name itself*):
  a natural — arguably inevitable — extension.
- **On the current north star** ("never leave WYSIWYG"; *a document editor*, not a platform/PKM),
  **the architecture** (passive detection; frontmatter out-of-band; offline-by-default), and
  **strategic scope** (explicitly undecided): a divergence that must be chosen deliberately, not
  drifted into.

The one-line recommendation: **if the loop is ever built, build the cloud app as a *publish
destination for local-first documents* — with a recoverable, lock-in-free ledger — so "local" and
"cloud" are two ends of one loop the user controls. But exhaust lossless export (§7) first, decide
the privacy-contract and who-is-the-user questions before any code, and treat the frontmatter ledger
as one unproven option, not the design.**
