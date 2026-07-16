# Per-tool compatibility fixtures (MAR-128)

These fixtures back the compatibility table in `docs/BENEFITS.md`. Each one is
a small, representative document authored from its tool's own documented
syntax — Obsidian's help vault conventions, Foam's generated link-reference
shim, Quarto's guide (`.qmd` constructs), the MDX spec, and the Org manual —
so the claims are exercised against the dialect as the tool actually writes
it, not against our own serializer's habits.

Run the whole claims set with one command:

```bash
pnpm fidelity
```

That runs, verbosely, the three suites that together state the claims:

- `roundTripCorpus.test.ts` — the general trust contract for every `.md`
  fixture in `__tests__/fixtures/` (invariant A: a zero-edit save is
  byte-identical; invariant B: a real edit keeps every original line).
- `toolFidelity.test.ts` — the per-tool claims: the constructs the BENEFITS
  table names survive an edit byte-for-byte, plus the **negative** claims.
- `logseqRoundTrip.test.ts` — Logseq's own suite (`fixtures/logseq/`).

## Conventions

- **`.md` fixtures are corpus members automatically.** Anything with an `.md`
  extension under `__tests__/fixtures/` is auto-discovered by
  `loadCorpusFixtures()` and held to invariants A and B, and is sampled by the
  generative move-fuzz suites. Dropping a new tool's fixture here is the whole
  enrollment step.
- **`.mdx` / `.org` are deliberately NOT corpus members.** They encode the
  table's 🔴 rows: formats where corruption *on edit* is the expected,
  asserted outcome. Only `toolFidelity.test.ts` consumes them. If one of its
  negative assertions ever fails, the serializer got *better* — re-verify and
  upgrade the BENEFITS row rather than patching the test.
- **No YAML frontmatter in fixtures.** The extension lifts frontmatter off
  before the webview ever sees content (`src/utils/contentTransform.ts`), so
  a webview-side fixture with frontmatter would test a state production never
  produces. Frontmatter fidelity is covered by the extension-side tests.
- **Roam and Bear have no fixtures** on purpose: they don't store plain
  Markdown files, so there is nothing on disk for a file-based editor to
  open — exactly what their table rows say.

## Adding a tool

1. Author `<tool>.md` here from the tool's primary documentation (small, but
   dense with the tool's own constructs).
2. Add a `describe` block to `toolFidelity.test.ts` asserting the constructs
   the compatibility table names survive `saveEditing` byte-for-byte.
3. Update the table row in `docs/BENEFITS.md` to say the claim is now
   machine-verified.
