# Export fixtures (MAR-341)

Documents produced by a one-shot exporter (Notion, Craft, Evernote, Apple Notes, Confluence, Google Docs) rather than written by a living-vault tool. An exporter changes its output without notice, so a fixture here is a record of what one exporter emitted on one day, and its path says which:

```
exports/<exporter>/<YYYY-MM-DD>/<the export, exactly as it unpacked>
```

- `<exporter>` is lowercase, words joined by hyphens: `notion`, `craft`, `apple-notes`.
- `<YYYY-MM-DD>` is the day the export was taken, not the day it was committed. A later capture from the same exporter goes beside it under its own date, so a red on the newer one reads as the vendor changing rather than as the editor regressing.
- The export's own bytes are never edited, including its file names. If the exporter knows its version, say it in the commit that adds the capture.

A capture must come from running the exporter. A file written to look like an export, from documentation or memory, is a construct fixture and belongs one level up, named for the construct rather than the vendor. `exportProvenance.test.ts` holds both rules: a file under `exports/` sits at the path above, and a fixture anywhere else whose name carries an exporter's name is declared synthetic there, with its reason.

Every `.md` here is a corpus member like any other fixture (`loadCorpusFixtures()` walks this directory), so the round-trip invariants apply the day a capture lands. Two cautions for an export dump: no YAML frontmatter (the extension lifts it before the webview sees content, see `../tools/README.md`), and `roundTripCorpus` invariant C types into only the first 12 paragraph text nodes, so a long preamble keeps it from reaching the document's subject.
