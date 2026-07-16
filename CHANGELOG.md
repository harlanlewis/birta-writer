# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

> Running log for the hard fork. Changes are grouped by type; the nightly `Release` workflow distills this section into end-user highlights when it cuts a versioned build. Versions are CalVer, stamped from the release clock (e.g. `2026.714.40000`) — see [`docs/RELEASING.md`](docs/RELEASING.md).

### Added

**Editing**

- **WYSIWYG Markdown editing** — open a `.md` file as rich text and save standard Markdown back. The editor is backed by a real VS Code text document, so it carries native dirty state and saves through VS Code's own `files.autoSave` / Cmd+S with no separate save timer. Toggle to Raw Markdown and back at any time; switching with unsaved edits shows the normal Save / Don't Save / Cancel prompt.
- **Block handles and the block menu** — every block, at every nesting depth (including inside callouts, quotes, and directives), has a gutter handle. Click it for a menu — turn into another block type, duplicate, copy as Markdown, copy link, move up/down, delete — or drag it to reorder; a heading carries its whole section. Open the same menu from the keyboard with ⌘. / Ctrl+. Resting visibility is set by `birta.blockHandles` (`always`, `headings` — the default — or `hover`), also reachable from the toolbar's display (A) menu.
- **Block selection and keyboard editing** — select whole blocks with an Escape ladder (caret → block → all document), Shift+↑/↓ to extend, or a rubber-band marquee dragged in the margins; move them with Alt+↑/↓, duplicate with ⇧⌥↑/↓, delete with ⌘⇧K. Plus the VS Code editing canon adapted to WYSIWYG: join lines, insert a paragraph above/below without splitting, transform case, and a smart expand/shrink-selection ladder.
- **Folding** — fold headings, callouts, nested list items, tables, and code blocks from a gutter chevron (or the Fold / Unfold / Fold All commands, ⌘⌥[ / ⌘⌥]). Chevron visibility follows VS Code's own `editor.showFoldingControls` / `editor.folding`. Folds persist per tab and never touch the file — or write an Obsidian `[!kind]-` marker explicitly from a callout's menu when you want the collapsed state saved.
- **Slash command menu** — type `/` to open a filterable, keyboard-first insert menu (text, lists, and insert blocks) with the markdown shortcut shown for each row. It's context-aware and runs the same commands as the toolbar and command palette.
- **Find and replace** — a find bar with ⌘D occurrence cycling, Select All Occurrences (⇧⌘L), Find in Selection, and Match Case / Whole Word / Regex toggles. It skips code blocks and diagrams that are showing their rendered preview, so a match never lands on hidden source.
- **Floating selection palette** — selecting text raises a small formatting bar just above it (bold, italic, strikethrough, inline code, inline math, highlight, link, clear formatting), lighting the buttons for marks already applied; a paragraph/heading turn-into appears only when the whole block is selected. Works for mouse and keyboard selections alike; selecting whole blocks raises move / duplicate / delete instead — the first mouse affordance for a multi-block selection. It follows its text as the view reflows, its Link button drives the same link editor as the toolbar and ⌘K, and the bar steps aside when the link editor or block menu opens. Turn it off with `birta.floatingToolbar.enabled`, or hide individual buttons with `birta.floatingToolbar.items.*`.

**Blocks and syntax**

- **Tables** — Google-Docs-style overlay chrome (row/column grips, hover insert bars, drag-to-reorder) and per-column alignment (left / center / right) with GFM markers that round-trip faithfully.
- **Callouts, admonitions, and directives** — GitHub alerts (`> [!NOTE]` …), Obsidian callouts (per-kind icon and accent, collapsible bodies, aliases, fold markers), Docusaurus `:::name` container directives, and Notion `<aside>` exports all render richly with editable titles. Insert from the slash menu, the command palette, or by typing `[!note] ` / `:::name `. Callout types nest, and every marker line round-trips byte-for-byte.
- **Math** — inline `$…$` edits in place like inline code (the caret walks into the raw LaTeX and it re-renders on exit), plus `$$…$$` math blocks. KaTeX loads on demand.
- **Mermaid diagrams** — render on a white canvas by default so they stay legible in dark themes (the way GitHub and Notion present them); `birta.mermaid.theme` chooses `light` / `dark` / `auto`. The engine loads on demand.
- **Highlight** — `==marked text==` (Obsidian) renders as a theme-aware highlight.
- **Images** — alt text shows as an editable caption under the image, the title as a hover tooltip, and the file path edits from a filename chip in the image toolbar (applied on blur).
- **Links and wikilinks** — one link editor for both inserting and editing (⌘K, or click a link; applies on blur; a Markdown / `[[wiki]]` format switch). Wikilinks (`[[target|alias#heading]]`) round-trip byte-identically with bare-name autocomplete. **Smart link resolution** (`birta.smartLinks`) opens local links the way a site generator would publish them — workspace-root paths, content-root inference, `index.md` / `_index.md` suffixes — and shows the resolved target while you edit. **Pasting a URL over selected text links the selection** instead of replacing it, opening the editor prefilled to confirm or fix it — one undo removes the link. Detection is narrow: full URLs (`https://…`, `mailto:…`) and bare web domains (`example.com`, `www.foo.com/path`) link; plain text, a file path or bare filename (`notes.md`, `app.ts`), a version tag (`v1.2`), or a markdown/wikilink snippet still replaces the selection, and a paste inside a code block, over an existing link, or across blocks is never intercepted.
- **Frontmatter panel** — YAML metadata edits as a borderless key/value grid; list values become removable chips with workspace-wide autocomplete; the panel collapses (`birta.frontmatterExpanded`) and has full keyboard, undo, and screen-reader support.

**Layout and appearance**

- **Customizable toolbar** — show, hide, and reorder every item (`birta.toolbar.items.*`), or hide the whole bar for a chrome-free surface; hidden actions stay reachable from the slash menu. Quote, Lists, and Code dropdowns group related inserts, and the bar highlights whatever the cursor is in.
- **Typography** — sans / serif / mono font presets with customizable stacks and a content font-size stepper (`birta.fontPreset`, `birta.fontFamily*`, `birta.fontSize`), plus a Full-Width / Fixed content-width control (`birta.contentWidth`, `birta.maxContentWidth`).
- **Word count in the status bar** — words, characters, and estimated reading time for the active document show in the status bar and update as you type; selecting text switches it to the selection's count ("N words selected"). Counting is CJK-aware (each CJK character counts as a word, Latin runs count by word). Hide it from the status bar's own right-click menu if you don't want it.
- **Resizable Table of Contents** — a chrome-free TOC docks on either side (`birta.tocPosition`), resizes by dragging, hides to a small tab, and switches sides in place. When collapsed, hovering (or focusing) the tab flies the panel out as a floating overlay so you can jump around without reopening it; click the tab to dock it open — the flyout is fully live, tracking the document and reordering from it exactly like the docked panel. Drag TOC items to reorder whole sections, or drag blocks into a section to refile them.
- **Live theme following** — the editor always matches your active VS Code color theme, recoloring instantly on theme and OS light/dark switches (Mermaid diagrams included).
- **Keyboard-first** — a Keyboard Shortcuts Help cheatsheet, plus command-palette entries for fonts, checks, and view toggles. UI-level actions — the list and heading chords (⌘⇧7–9, ⌘⌥0–6), find and its navigation, Replace, Insert/Edit Link (⌘K), Delete Block (⌘⇧K), Fold/Unfold (⌘⌥[ / ⌘⌥]), Open Block Menu (⌘.), Go to Symbol, and the Raw Markdown switch — are contributed VS Code keybindings, rebindable in the Keyboard Shortcuts editor. The typing-level grammar keeps a fixed chord set, including formatting (⌘B, ⌘I, ⌘E, ⌘⇧X), undo/redo, block move (⌥↑/↓) and duplicate (⇧⌥↑/↓), block selection (Escape, Shift+↑/↓, ⌘A), expand/shrink selection, and insert paragraph above/below (⌘↩, ⌘⇧↩); those defaults can't be reassigned, but each — undo/redo aside — also has a command-palette entry you can bind an additional chord to.

**Writing assistance**

- **Proofreading (offline)** — spelling, a Harper-backed grammar engine, and style checks (fillers, clichés, wordiness, passive voice, AI-tell vocabulary, em-dash and punctuation, and more) underline issues inline; click one for a popup with a one-click fix, Ignore, or Add to dictionary. A unified **Checks** menu groups them under a master **Proofreading** switch (`birta.proofreading.enabled`), and each check toggles individually. It runs entirely offline, is decoration-only, and loads lazily so it never delays opening a file — a check you've turned off costs nothing.

**Trust and safety**

- **Byte-faithful round-trips** — untouched lines are preserved exactly, and constructs the editor can't re-emit byte-for-byte (reference links, wikilinks, callout markers, tight lists, Notion asides) are pinned to their saved bytes, so editing one part of a file never rewrites another.
- **Content-conservation guard** — a move, duplicate, drag, or table reorder that would silently lose or corrupt content is blocked outright, with a quiet notice instead of vanishing text; drops can't land inside hidden or collapsed content.
- **No network egress for document content** — images are always saved to the local workspace and never uploaded; remote image loads are blocked, opened URL schemes are allowlisted (`javascript:` / `file:` / `command:` are blocked), the HTML sanitizer is hardened, and Mermaid runs in strict mode. The editor has no path to send document content off the machine.
- **A disk-drift badge** warns when a file open with unsaved edits is changed on disk by another tool — a terminal, git, an AI assistant: reload from disk or compare the two versions side by side. The editor never silently overwrites or merges.

**Platform**

- **Remote workspaces** — works in Remote-SSH, WSL, and Codespaces.
- **Fast launch** — heavy dependencies (the KaTeX stylesheet, ~66 syntax-highlighting grammars, the Mermaid engine) load on demand rather than at every open; a document with no math, code, or diagrams loads a fraction of what it used to, and proofreading and fidelity checks settle in after first paint rather than blocking it.
- **A hard fork, in English** — hard-forked from [`git-xing/md-wysiwyg-editor`](https://github.com/git-xing/md-wysiwyg-editor), with all Chinese content removed and English as the source and base language across code, UI, and docs (a CI guard prevents regressions). Source-available under the Functional Source License (FSL-1.1-ALv2) — free to read, run, modify, and self-host for any non-competing purpose, converting to Apache-2.0 two years after each release; portions derived from the upstream fork remain under their original MIT License — see `LICENSE`, `NOTICE`, and `LICENSE-MIT`.

### Fixed

- **Delete Block (⌘⇧K) with the caret in a table cell no longer deletes the whole table** — from a plain caret inside a cell the command now does nothing, matching Join Lines' never-destructive rule; deleting a table stays deliberate (select the whole table via its handle, the block menu, or a block/marquee selection).
- **Cmd+S now always saves what you just typed** — a save could silently do nothing and leave your latest keystrokes unwritten. The editor took about 200ms to register an edit with VS Code, and a save inside that window found nothing to write; typing *continuously* never registered at all, so saving mid-flow without pausing could write nothing no matter how long you'd been typing. The same delay bounded how much recent work VS Code's crash backup held. An edit now registers within a frame, so Cmd+S catches it however fast you get there.
- **The outline now updates the instant the document changes** — the table of contents refreshed on the *save* cadence rather than on edits, so how fast it caught up depended on your recent typing: near-instant after a pause, several hundred milliseconds mid-burst, and up to two seconds during continuous typing. It now tracks the document directly and reflects an edit on the next frame, whatever else you're doing.
- **A block dropped at the end of a collapsed section no longer disappears** — dragging a block to the boundary just below a folded heading (dragging it to the bottom of the document was the easiest way to hit this) dropped it *inside* that collapsed section, where it was hidden: the block vanished with no trace, reading as if the drag had deleted it. It was still in the file, but the only way to find it was to unfold the section. The fold now opens to show the block where you dropped it.
- **"Move Up" on a block nested in a list item no longer looks available when it isn't** — the first block under a list item's own line (an indented quote, code block, callout, table, or heading) offered a live "Move Up" row that did nothing when clicked. It can't move up: a list item has to start with its own text, so nothing else can take that first line. The row is now disabled, like every other move with nowhere to go. Moving such a block *down* past its siblings is unaffected.
- **Screen readers no longer hear two selected items in the block menu** — on a callout set to "Collapsed by default", both that row and the "Callout" block type announced as selected, though the menu allows only one selection. The fold toggle now announces as a checked item, which is what it is; the block type keeps the selection.

### Changed

- **Reordering a heading in the outline now sets its level to match where you drop it** — the table of contents is a structural editor as well as a view, so a drop's position decides the section's rank. Drop **onto** a heading to make the section its child (a heading dropped onto an H3 becomes an H4); drop on the **line between** headings to make it a sibling of the heading below (terminal position: of the last section). The section's whole subtree moves with it and shifts by the same amount, so its internal hierarchy is preserved; levels that would pass H6 stop there. A drop whose position already matches the section's level leaves it untouched, and the whole thing is a single undo step. A **collapsed** section accepts no child — nesting one under a fold would land it out of sight, which is indistinguishable from deleting it — so dropping onto a collapsed row places the section beside it instead; expand it first to file anything inside. Dragging a heading's gutter handle **in the document** is unchanged — that stays a literal move, because the text is text and the outline is the structure.
- **Nesting one `:::` directive inside another survives a save** — moving a `:::note`/`:::info` admonition into another directive now writes the outer fence longer than the inner (`::::` around `:::`, the CommonMark convention), so the inner block reopens as a directive instead of flattening to plain text.
- **Moving a horizontal rule to the top of a directive keeps it a rule** — a `---` dropped directly under a directive's opening fence used to reopen as a heading (the fence line became setext-underlined), destroying both the rule and the directive; the rule now stays a rule.
- **Moving a block between callouts no longer splits the callout on reopen** — dragging a paragraph out of one callout (or blockquote) and into another used to leave a stale blank line where the emptied callout sat, so on reload the destination callout was split in two and the moved block landed in a plain blockquote. The moved block now reopens inside the callout it was dropped into.
- **Moving a block no longer corrupts an escaped `\==highlight==`** — a hand-escaped highlight literal (`\==not a highlight==`) kept as plain text now re-serializes with its backslash intact when its block is moved, instead of silently dropping the `==` bytes and turning into a highlight on reopen.
- **Editing chords no longer change an unfocused document** — with the editor as the active tab but focus in the Explorer/sidebar, pressing a document-mutating shortcut (⌘⇧K delete block, ⌃J join lines, the list/heading/paragraph chords, ⌘K link) used to edit the document you weren't looking at. These chords now require the editor itself to be focused; find, fold, and navigation shortcuts are unchanged.
- **The numbered-list block handle no longer hides under multi-digit numbers** — on a list reaching item 10+ (or at 150–200% content scale) the grabber sat on top of the number as an invisible click target. It now tracks the number's width and the content font size, staying clear of the ink.
- **The slash command menu now opens inside headings** — typing `/` in a heading did nothing (the heading's own text normalization silently suppressed the menu right after the keystroke). It now opens the same insert menu it does in a paragraph.
- **Blocks nested inside a list item now have a grabber** — a blockquote, code block, callout, table, or heading indented under a list item had no gutter handle at all, so its block menu and drag handle were unreachable. It now shows its own marker like the same block nested anywhere else; click it for the menu or drag it to move the block.
- **List grabbers inside a callout, quote, or directive no longer overlap the accent bar** — a list nested in one of those containers drew its per-item handles on top of the container's colored bar. The handles now step clear of every enclosing bar, at any content font size.

---

## [0.2.3] - 2026-07-04

A large batch focused on round-trip fidelity, VS Code parity, and Markdown syntax breadth.

### Added

- **Math (KaTeX)**: inline `$…$` and block `$$…$$` math render in place. Click inline math to edit its source in a popover; block math toggles between source and a rendered preview like code blocks. The KaTeX engine loads lazily so it costs nothing on documents without math.
- **Footnotes**: `[^label]` references render as superscript chips with a hover preview of the definition and click-to-jump; definitions are editable in place with a back-link to the first reference. An "Insert Footnote" toolbar button auto-numbers.
- **Source-based find & replace**: find now searches the Markdown *source* — link URLs, image paths and alt text, and code-fence languages are matchable — with regex and whole-word toggles alongside case sensitivity, and `$1…$n` capture-group substitution.
- **Command palette & context menu**: all editor actions (formatting, insert table/link/image/math/footnote/HR, headings, lists, find, frontmatter, TOC) are now Command Palette commands, and right-click offers table row/column operations, edit link, and copy-as-HTML/Markdown.
- **Heading outline / Go-to-Symbol**: `Cmd/Ctrl+Shift+O` opens a heading quick-pick for the WYSIWYG document.
- **Responsive toolbar**: in narrow panes, overflowing toolbar groups collapse into a `⋯` menu instead of clipping.

### Changed

- **Native text-document editor (CustomTextEditorProvider)**: the WYSIWYG editor is now backed by VS Code's own `TextDocument` instead of reading and writing the file itself. This brings the standard editor experience:
  - **Native undo/redo**: Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z now use VS Code's document history and stay in sync with edits made in a side-by-side text view.
  - **Native dirty state**: the tab shows VS Code's unsaved-changes dot and participates in Save All, hot exit, and "revert file" like any text editor. The extension's own `markdownWysiwyg.autoSave` / `autoSaveDelay` settings are deprecated in favor of the built-in `files.autoSave`, which the editor now honors.
  - **Git integration**: because edits flow through the document, staging, diffing, discarding changes, and `git checkout` update the editor live.
- **Cursor-preserving inbound sync**: external changes (a side-by-side text edit, undo/redo, git operations, hot-exit restore) are applied to the editor as a minimal ProseMirror diff rather than a full rebuild, so the caret and selection survive edits made elsewhere in the document. Falls back to a full rebuild if the diff can't be applied cleanly.
- **Source-style preservation**: setext (underlined) headings, `***`/`___` thematic-break markers, and `_`/`*` emphasis markers now round-trip in their original style instead of being canonicalized on edit.
- **English-first UI**: remaining hardcoded Chinese strings were swept into the i18n layer (English as the base language), with a CI guard preventing regressions.

### Fixed

- **Formatted links no longer split**: a link whose text contains bold/italic/code (e.g. ``[**bold** and `code`](url)``) previously shattered into several adjacent links when its line was edited; it now serializes as a single link. Also root-fixes the related strong-around-link splitting.
- **Line breaks inside table cells**: `<br>` in a GFM table cell is preserved instead of being silently flattened to a space on save; Shift+Enter inserts one.
- **Remote/SSH/WSL/Codespaces**, **Cmd+B/Cmd+I no longer leak to VS Code**, **undo inside overlay inputs**, and **lossless frontmatter editing** (earlier Phase 0 fidelity fixes).

---

## [0.1.6] - 2026-04-27

### Fixed

- **Scroll position restored on tab switch**: switching away from a Markdown file and back no longer resets the scroll position to the top. The editor now persists the scroll offset via the VS Code WebView state API and restores it when the panel becomes visible again (via `visibilitychange`). Also handles WebView recreation on VS Code restart.

---

## [0.1.5] - 2026-04-08

### Fixed

- **Auto-reload on external file changes**: the editor now instantly reflects changes made by AI tools (e.g. Claude Code) or any external program without needing to close and reopen the file. Previously, writes from the same VS Code Extension Host were silently ignored due to VS Code's internal deduplication; atomic writes (rename-based) also caused the file watcher to stop tracking the file after the first replacement. Fixed by switching to Node.js `fs.watch` on the parent directory.
- **IME input**: prevent Chinese/Japanese/Korean intermediate composition states from triggering premature auto-saves, which caused duplicate or garbled characters.

### Added

- **Image path autocomplete**: type `./`, `../`, or `@/` in the image URL input to get smart path suggestions; image files show a 32 px thumbnail preview in the dropdown.
- **`@/` alias for image paths**: images referenced as `@/images/foo.png` (workspace root) are now correctly displayed in the editor.

---

## [0.1.4] - 2026-04-08

### Fixed

- Fixed the "Simplified Chinese" link in the Marketplace README pointing to a non-existent URL (corrected `--baseContentUrl` to include `/blob/main`)
- Fixed incorrect release dates in CHANGELOG for versions 0.1.0–0.1.2

---

## [0.1.3] - 2026-04-07

### Added

- **Path autocomplete**: type `@/`, `./`, or `../` inside inline code to trigger smart path suggestions
- **Hierarchical directory browsing**: path suggestions show the current directory level; selecting a folder drills into the next level
- **File-type icons**: the suggestion dropdown shows color-coded vscode-icons for 9 file types (folder, TypeScript, JavaScript, Markdown, JSON, CSS, HTML, image, and generic file)
- **`#line-number` jump in links**: links such as `README.md#27` or `README.md#27-30` jump directly to the specified line in the target file

---

## [0.1.2] - 2026-04-07

### Added

- **In-editor search** (`Cmd/Ctrl+F`): FindBar with real-time highlighting via CSS Custom Highlight API; navigate with `Enter` / `Shift+Enter`, dismiss with `Esc`
- **Link popup redesign**: single-card UI with view / edit modes; supports `@/` workspace paths and `#anchor` in-page links
- **In-page anchor navigation** (`#heading`): GitHub-compatible slug, smooth scroll
- **Global search navigation**: clicking a VS Code search result scrolls the WYSIWYG editor to the matching position
- **Code block full-screen editor**: textarea + pre overlay with syntax highlighting, fade-in/out animation; writes back to ProseMirror on close
- **Mermaid diagram rendering** (mermaid 11.x): inline preview, code/preview toggle, zoom, pan, full-screen lightbox

---

## [0.1.1] - 2026-04-01

### Added

- **Image support**: paste, drag-and-drop, or file picker to insert images; local storage with MD5 deduplication or custom server upload
- **Image NodeView**: selection border, lightbox zoom, toolbar for alt-text editing, rename, and delete
- **Internationalization**: English + Simplified Chinese; platform-aware shortcuts (Mac ⌘/⇧/⌥ vs Windows Ctrl/Shift/Alt)
- **Settings icon** (gear) in the toolbar opens the VS Code settings panel for this extension

---

## [0.1.0] - 2026-03-31

### Added

- Initial release: WYSIWYG Markdown editor powered by [Milkdown](https://milkdown.dev/) / ProseMirror
- Full GFM table support: insert rows/columns, drag-to-reorder
- Syntax-highlighted code blocks for 20+ languages with height-resize handle
- Auto-generated Table of Contents panel (TOC)
- Floating selection toolbar and table toolbar
- Claude integration: `Option+K` / `Alt+K` sends the current paragraph with precise file line numbers
- Auto-save: writes to disk 1 second after editing stops
