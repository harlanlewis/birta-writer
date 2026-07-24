# Positioning — brand & naming

Scope: this file records only the **brand brief** and the **naming decision** — the slice of
positioning not already captured elsewhere. It is a point-in-time decision record, not a
statement of values; it must not restate (and drift from) the canon:

- **Thesis & priorities** → `README.md` § "Why this fork" — the north star (*never leave
  WYSIWYG*) and the 1–4 investment ordering (fidelity › VS Code parity › syntax breadth ›
  interaction). That ordering is also the tie-breaker when goals conflict.
- **Scope & why it matters** → `docs/BENEFITS.md` — Birta is *a document editor* ("not a
  knowledge base, not an outliner, not a note graph").
- **How the UI communicates** → `docs/DESIGN_PRINCIPLES.md`.

## The brand brief

The name had to **span the product's identities without binding to any one**, so it wouldn't
foreclose where the product might later go:

- **plain files** — the developer beachhead (Markdown on disk, in your editor, under git)
- **a real editor** — rich WYSIWYG editing of that file; today's shipped scope (see `BENEFITS.md`)
- **room to grow** — the name should still fit *if* the maintainer later explores
  linked/structured knowledge. To be clear: local databases / a Foam-style ecosystem are
  **open questions, not committed scope** — `BENEFITS.md` deliberately scopes today's product
  as a document editor. The brief's point is neutrality: the name must not *bind* to
  `markdown` / `editor` / `note` / `graph` either, so no direction is foreclosed.

Practical gate: a VS Code extension's identity is its **Open VSX namespace** (Cursor installs
from there) and its **Marketplace publisher id** — not npm.

## Decision: Birta Writer

Icelandic *birta* — to brighten / reveal / **publish**; the source brought into the light and
shown plainly (*birting* = a publication). Chosen for meaning-fit, clean mouthfeel, and
availability (`birta.dev` free; no editor/Markdown/notes product on the name). The full
linguistic and cultural reference — declension, cognates, cross-language false friends,
sensitivity — lives in [`docs/research/birta-name-meaning.md`](research/birta-name-meaning.md).

Runners-up held in reserve: **Palese**, **Disvela**, **Limpido**. Rejected candidates
(**Grove, Loam, Gleba, Limn/Limner, Valo, Trazo**, …) fell to collisions, mouthfeel, or the
"limb" homophone. The full decision record — criteria, every candidate, and the availability
evidence — lives in Linear **MAR-134**.
