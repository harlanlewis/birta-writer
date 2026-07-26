# The publish loop — local-first documents, cloud-published, self-describing

**Status:** design sketch / thinking only. No implementation, nothing measured. Written 2026-07-26.

**Tracking:** Linear **MAR-232** (`phase-5-surfaces`, child of MAR-225). This is a *design
record* that holds the thinking — it is **gated behind the cloud-web green-light** (Rung 4 of
MAR-225, deliberately unscheduled) and filed to keep the idea honest, not to queue work.

**Relationship to MAR-225 / `MULTI_SURFACE_INVESTIGATION.md`:** that investigation is about
*running the editor* on new surfaces (desktop, web) — the host-adapter axis. This document is
the orthogonal axis: the *document's lifecycle* across a local↔cloud boundary. They converge at
exactly one point — the cloud web product (MAR-225 Rung 4) is the natural publish *destination* —
and the publish loop is the thing that makes "the local editor" and "the cloud app" one coherent
product instead of two disconnected editors that happen to share a renderer.

---

## 0. The one structural idea

> **The document is canonical and lives on the user's disk. "Publishing" is an explicit,
> per-document, reversible act that pushes a copy to a destination. The record of *what was
> published where* lives inside the document itself, as a block of YAML frontmatter — a sync
> ledger. The file is self-describing about its own publication state; no external database owns
> the mapping.**

Everything else follows from that sentence. The loop is closed:

```
author locally ──publish──▶ destination(s)
      ▲                          │
      └───────sync back──────────┘
   (local file stays canonical; the frontmatter ledger records the round-trip)
```

The "loop" is not continuous background sync. It is a *pull-the-trigger* cycle the user controls,
with the ledger making each edge auditable after the fact.

---

## 1. Why this is on-brand (and why frontmatter, specifically)

Birta's differentiated promises are **fidelity, offline/local-first, privacy, no lock-in**. A
naive "cloud sync" feature erodes all four. The publish-loop framing preserves them because the
design choices fall directly out of the brand, not the other way around:

- **Local-first / privacy.** The canonical copy never leaves disk unless the user publishes. There
  is no ambient sync daemon, no account required to *use* Birta, and no server that silently holds
  the truth. Publishing is the *one* act that sends content off-device, so it must be explicit,
  per-document, and revocable — and the ledger makes it the opposite of hidden.
- **Fidelity.** What gets published is the same byte-exact markdown the user authored. The ledger
  stores a content hash per destination, so drift between "what's on disk" and "what the remote
  last received" is *detectable*, not silent. This reuses Birta's existing external-change
  philosophy verbatim: **surface the collision, let the user pick the winner, never silently
  merge** (the same posture as `externalChanges.ts` + minimal-diff — see MAR-225 §9). No CRDTs;
  CRDTs fight byte-fidelity, which is the product.
- **No lock-in.** Because the publication relationship lives *in the file*, it is portable and
  inspectable. Deleting the ledger block un-publishes — nothing is stranded in a server-side
  mapping table the user can't see. Open the `.md` in any editor and the provenance is right there.
- **The recursion (why frontmatter earns its place).** This very document is a `.md` file that
  could carry a sync ledger and be published *through the loop it describes*. The mechanism and the
  content are the same substance. That is the tell that the abstraction is at the right altitude.

Frontmatter as the ledger is the same split Birta already lives by: the **CHANGELOG records what
shipped, Linear tracks planned work** — two complementary records, neither a single source of
truth. Here: **the frontmatter ledger records what was published, the remote holds its own live
state** — complementary, cross-checkable, neither authoritative alone (see §4, the trust model).

---

## 2. The sync ledger — shape (illustrative, not a spec)

A reserved key in the document's frontmatter, one entry per destination:

```yaml
---
title: My essay
birta:
  published:
    - target: birta-cloud            # a named destination (resolved to a URL + token out-of-band)
      remoteId: doc_abc123           # the destination's id for this document
      publishedAt: 2026-07-26T12:00:00Z
      sourceHash: sha256:9f8e…       # hash of the exact bytes last pushed
      status: clean                  # clean | local-ahead | remote-ahead | diverged
    - target: my-blog
      remoteId: post/42
      publishedAt: 2026-07-20T09:00:00Z
      sourceHash: sha256:1a2b…
      status: local-ahead
---
```

Design constraints on the block:
- **Advisory, never authoritative.** The ledger is *provenance*, re-verifiable against the remote.
  A user can hand-edit or corrupt it; the system must degrade to "re-query the destination" rather
  than trust it blindly (§4).
- **One reserved namespace.** Everything lives under a single `birta:` key so the rest of the
  frontmatter stays the user's. The block round-trips through Birta's serializer byte-exactly like
  any other frontmatter (it must not become a fidelity hazard — it is exercised by the corpus).
- **Secrets never live here.** `target` is a *name*; the URL + credential for that name resolve
  out-of-band (a per-destination token in host settings/keychain), because the `.md` is portable
  and might be committed to git or shared.

---

## 3. The four edges of the loop

| Edge | What happens | Reuses |
|---|---|---|
| **Publish (local → remote, first time)** | Push bytes, remote mints an id, write a ledger entry with `sourceHash` + `publishedAt`. | The serializer; a new host `publish()` capability. |
| **Re-publish (local → remote, update)** | Local hash ≠ ledger hash → push, update the entry. If remote also moved since → **diverged**, surface a conflict (don't overwrite). | External-change / conflict UI philosophy. |
| **Pull (remote → local)** | Remote changed (e.g. a lightweight edit or comment resolved on the cloud) → fetch, present as an *inbound external change* exactly like a disk edit, user accepts/rejects. | `externalChanges.ts` mechanisms; minimal-diff. |
| **Un-publish** | Remove the destination server-side (best-effort) and delete the ledger entry. The local file is untouched and canonical. | — |

The status field (`clean` / `local-ahead` / `remote-ahead` / `diverged`) is computed by comparing
three things: the current on-disk hash, the ledger's `sourceHash`, and the remote's current hash.
It is the same three-way comparison Birta already does for external changes, generalized from
"disk vs editor" to "disk vs ledger vs remote."

---

## 4. Trust model — who owns the truth

Three stores, none authoritative alone:

1. **The on-disk file** — canonical *content*. Always wins for "what the document *is*."
2. **The frontmatter ledger** — canonical *intent* ("this document is meant to be published to X").
   Advisory about remote state; re-verifiable.
3. **The remote** — canonical for *its own* live state (id, last-received hash, remote-side edits).

The ledger is the join between (1) and (3), and it is deliberately the *weakest* — it's a cache of
the relationship that can always be rebuilt by asking the remote. This is what keeps the design
lock-in-free: the source of truth for content is the file the user holds, and the source of truth
for the remote is queryable, so the middle record can be lost without losing anything irreversible.

---

## 5. What this needs that doesn't exist yet

Almost all of it is gated behind the cloud-web product (MAR-225 Rung 4), which is itself unscheduled.
Naming the pieces so the gate is honest:

- **A destination abstraction** — `publish() / pull() / unpublish() / remoteHash()` as a host
  capability, with per-destination credential resolution. This is Bucket-3 host-only work in the
  MAR-225 taxonomy (it's OS/network integration, not editor behavior).
- **The cloud endpoint itself** — the server that accepts a publish, mints ids, stores content, and
  reports its hash. That is the cloud-web product; it does not exist and is deliberately deferred.
- **A conflict-surfacing UI for the `diverged` case** — reuses the external-change philosophy but
  needs its own presentation (this is *remote* divergence, not disk divergence).
- **Ledger read/write in the serializer path** — must be byte-safe and corpus-tested, since it
  writes into frontmatter (a fidelity-critical region).

Nothing here should be built before the cloud-web green-light. The value of writing it down now is
to *constrain* that future product: if/when the cloud app is built, it should be built as a
publish *destination* for local documents, not as a separate editor with its own storage — because
the latter is what quietly betrays the local-first promise.

---

## 6. Self-critique (red-team)

Read this as a counterweight, not a footnote.

- **This is design-ahead of a product that isn't scheduled.** MAR-225 explicitly refuses to file
  Rung-4 (cloud web) work to avoid queuing speculation. This document is the same speculation with
  nicer framing. The mitigation is honesty: it is filed as a *design record*, `Backlog`, gated —
  not as work. If cloud web never happens, the publish loop never happens, and that's fine.
- **"Frontmatter as ledger" may not survive contact with real destinations.** A blog (Ghost,
  a static-site repo, Substack) has its own id/slug/state model that may not map cleanly to one
  `remoteId` + `sourceHash`. The illustrative schema in §2 is almost certainly too simple; treat it
  as a thinking aid, not a spec. The one durable claim is *"the relationship lives in the file,"*
  not the exact keys.
- **Multiple destinations multiply the conflict surface.** One document published to three places,
  each of which can diverge independently, is a genuinely harder UX than the single disk↔editor
  case Birta solves today. "Surface, don't merge" is the right posture but the *presentation* of
  three simultaneous divergences is unexamined.
- **Identity leaks in through the back door.** Publishing to a cloud instance implies *some*
  identity for the destination (a token, at least). The brand's "no account to use Birta" holds for
  local editing, but the moment you publish you've authenticated to *something*. Keep that scoped to
  the destination, never to the app — but acknowledge the seam exists.
- **Nothing is measured.** Same caveat as the whole MAR-225 family: this is reasoning over the
  existing architecture, not a prototype. The cheapest validating probe (if the cloud product is
  ever green-lit) is a single publish→edit-remote→pull round-trip against a stub destination, the
  publish-loop analog of MAR-227's save probe.

---

## 7. The one-line takeaway

If the cloud web app is ever built, build it as a **publish destination for local-first
documents** — with the publication record living **in the document** — so that "local" and "cloud"
are two ends of one loop the user controls, not two editors that lost their shared file.
