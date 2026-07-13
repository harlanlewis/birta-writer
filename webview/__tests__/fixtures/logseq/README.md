# Logseq round-trip fixtures

**Synthetic, hand-authored — not captured from a real Logseq export.** They
encode the file-based Logseq markdown conventions below so `logseqRoundTrip.test.ts`
can pin fidelity, but no one ran them through Logseq. Before trusting an *edge*
case (unusual property placement, LOGBOOK shape, macro nesting), verify against a
real graph and update the fixture. Tracked by MAR-131 / MAR-132 / MAR-133.

## Format assumptions encoded here

- **Outliner**: every block is a `- ` bullet; nesting is **tab** indentation
  (Logseq's default file format), where indentation encodes the block tree.
- **Block continuation**: extra lines of a block align under the text after the
  bullet — two spaces past the bullet's own indent (`\t  ` under a `\t- ` block).
- **Page properties**: `key:: value` lines at the top of the file, above the
  first bullet (`title::`, `tags::`, `type::`, `alias::`).
- **Block properties**: `key:: value` lines within a block (`collapsed::`,
  `background-color::`).
- **Refs / macros**: `[[Page]]` page refs, `((uuid))` block refs,
  `{{query …}}`, `{{embed …}}`.
- **Tags**: `#tag` and `#[[multi word]]`.
- **Task markers**: `TODO` / `DOING` / `DONE` / `LATER` / `NOW`, priority
  cookies `[#A]`, `SCHEDULED:` / `DEADLINE:` with `<org timestamps>`, and
  `:LOGBOOK:` / `CLOCK:` / `:END:` blocks with `[org timestamps]`.

## Files

- `page.md` — a page with page properties and a deep outliner tree covering all
  of the above.
- `journal.md` — a smaller journal-style page (`NOW`, inline refs/tags).

## What the tests currently show

- Opening/saving an **untouched** file is byte-identical (the minimalDiff
  protection layer rescues serializer churn on lines the user didn't touch).
- Editing a **top-level** block changes only that block.
- Editing a **tab-indented** block collapses its sibling subtree's tabs to
  spaces; editing an **org-cookie** line escapes it (`[#A]` → `\[#A]`). These
  are the residual gaps MAR-131 closes.
