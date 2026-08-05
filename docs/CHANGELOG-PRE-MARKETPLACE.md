# Changelog: before the Marketplace listing

Birta Writer's public listing (`BirtaLabs.birta-writer`) begins at `2026.731.0`, released 2026-07-31. The versions below predate it: they were built and installed locally while the fork found its shape, and none of them was ever publicly installable. Neither of the two ids the extension carried before moving to the Birta Labs publisher was ever published. They are kept here for the record.

They also use the semver scheme the project has since left behind. Every release from `2026.731.0` on is CalVer; see [`RELEASING.md`](RELEASING.md).

This file is not shipped inside the extension (`docs/**` is excluded by `.vscodeignore`), so the Marketplace Changelog tab shows only versions a user could install. The current changelog is [`../CHANGELOG.md`](../CHANGELOG.md).

---

## [0.2.3] - 2026, July 4

A large batch focused on round-trip fidelity, VS Code parity, and Markdown syntax breadth.

### Added

- Math renders in place, inline `$...$` and block `$$...$$` alike. Click inline math to edit its source in a popover; block math toggles between source and a rendered preview, like a code block. The KaTeX engine loads lazily, so it costs nothing on a document without math.

- Footnotes render as superscript chips you can preview and jump to. A `[^label]` reference shows the definition on hover and jumps to it on click, and definitions are editable in place with a back-link to the first reference. An Insert Footnote toolbar button auto-numbers.

- Find and replace searches the Markdown source. Link URLs, image paths and alt text, and code-fence languages are all matchable, regex and whole-word toggles join case sensitivity, and replacement takes `$1...$n` capture-group substitution.

- Every editor action is a Command Palette command. The palette covers formatting, insert table, link, image, math, footnote and horizontal rule, headings, lists, find, frontmatter, and the table of contents. Right-click offers table row and column operations, edit link, and copy as HTML or Markdown.

- Go to Symbol opens a heading quick-pick for the WYSIWYG document, on `Cmd/Ctrl+Shift+O`.

- The toolbar collapses instead of clipping in a narrow pane. Overflowing groups move into an overflow menu.

### Changed

- The editor is backed by VS Code's own `TextDocument`. It no longer reads and writes the file itself, which brings the standard editor experience. Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z use VS Code's document history and stay in sync with edits made in a side-by-side text view. The tab shows VS Code's unsaved-changes dot and takes part in Save All, hot exit, and revert file like any text editor. Staging, diffing, discarding changes, and `git checkout` update the editor live, because edits flow through the document. The extension's own `markdownWysiwyg.autoSave` and `autoSaveDelay` settings are deprecated in favor of the built-in `files.autoSave`, which the editor now honors.

- The caret and selection survive an edit made elsewhere in the document. External changes, whether a side-by-side text edit, undo or redo, a git operation, or a hot-exit restore, are applied as a minimal diff rather than a full rebuild. It falls back to a full rebuild where the diff cannot be applied cleanly.

- Your own source style survives an edit. Setext (underlined) headings, `***` and `___` thematic-break markers, and `_` and `*` emphasis markers round-trip as you wrote them, instead of being canonicalized.

- The UI is English-first. The remaining hardcoded Chinese strings moved into the i18n layer, with English as the base language.

### Fixed

- A link whose text carries bold, italic, or code stays one link. Editing its line previously shattered it into several adjacent links. The same root fix covers the related strong-around-link splitting.

- A line break inside a table cell survives a save. `<br>` in a GFM table cell was silently flattened to a space; Shift+Enter inserts one.

- Four earlier fidelity fixes ship here too: Remote/SSH/WSL/Codespaces, Cmd+B and Cmd+I no longer leaking through to VS Code, undo inside overlay inputs, and lossless frontmatter editing.

---

## [0.1.6] - 2026, April 27

### Fixed

- Switching away from a Markdown file and back keeps your scroll position. It previously reset to the top. The position survives a VS Code restart too.

---

## [0.1.5] - 2026, April 8

### Fixed

- The editor reflects a change made by another program straight away. A file rewritten by an AI tool such as Claude Code, or by any other program, previously needed closing and reopening: writes from the same VS Code Extension Host were silently ignored, and a rename-based atomic write stopped the watcher tracking the file after the first replacement.

- Typing with a Chinese, Japanese, or Korean input method no longer produces duplicate or garbled characters. Intermediate composition states were triggering premature auto-saves.

### Added

- The image URL input suggests paths as you type. Type `./`, `../`, or `@/` for suggestions, and image files carry a 32 px thumbnail preview in the dropdown.

- An image referenced from the workspace root displays correctly. `@/images/foo.png` and the like now resolve.

---

## [0.1.4] - 2026, April 8

_Documentation only: a broken "Simplified Chinese" README link, and wrong release dates for 0.1.0 through 0.1.2 in this changelog._

---

## [0.1.3] - 2026, April 7

### Added

- Inline code suggests paths as you type. Type `@/`, `./`, or `../` inside inline code and a dropdown offers the current directory level; picking a folder drills into the next one. Suggestions carry color-coded icons for nine file types: folder, TypeScript, JavaScript, Markdown, JSON, CSS, HTML, image, and generic file.

- A link with a line number jumps to that line. `README.md#27` or `README.md#27-30` opens the target file at the line or the range.

---

## [0.1.2] - 2026, April 7

### Added

- `Cmd/Ctrl+F` opens a find bar with real-time highlighting. Navigate matches with `Enter` and `Shift+Enter`, and dismiss with `Esc`.

- The link popup is one card with view and edit modes. It handles `@/` workspace paths and `#anchor` in-page links.

- A `#heading` link scrolls smoothly to that heading, using GitHub-compatible slugs.

- Clicking a VS Code search result scrolls the editor to the matching position.

- A code block opens full-screen for editing, with syntax highlighting, and writes back when you close it.

- Mermaid diagrams (11.x) render inline, with a code and preview toggle, zoom, pan, and a full-screen lightbox.

---

## [0.1.1] - 2026, April 1

### Added

- Paste, drag and drop, or pick a file to insert an image. Images are stored locally with content-based deduplication, or uploaded to a server you configure. A selected image carries a border, a lightbox zoom, and a toolbar for editing alt text, renaming, and deleting.

- The UI ships in English and Simplified Chinese, and shortcut hints follow the platform: Mac ⌘/⇧/⌥ against Windows Ctrl/Shift/Alt.

- A gear in the toolbar opens this extension's VS Code settings panel.

---

## [0.1.0] - 2026, March 31

### Added

- The first release: a WYSIWYG Markdown editor built on [Milkdown](https://milkdown.dev/) and ProseMirror.

- GFM tables are fully editable, with insert row, insert column, and drag to reorder.

- Code blocks are syntax-highlighted for more than 20 languages, and carry a height-resize handle.

- The document gets an auto-generated table of contents panel.

- Selecting text raises a floating toolbar, and a table raises one of its own.

- `Option+K` / `Alt+K` sends the current paragraph to Claude with precise file line numbers.

- The editor writes to disk one second after editing stops.
