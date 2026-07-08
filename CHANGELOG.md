# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Removed

- **Image server upload**: removed the `server` image-storage mode and all `imageServer*` settings (`imageServerUrl`, `imageServerFieldName`, `imageServerExtraParams`, `imageServerResponsePath`) along with the `imageStorage` toggle. Images are now always saved to the local workspace and are never uploaded off the machine — the editor no longer has any network egress path for document content.
- **Send to Claude**: removed the selection-toolbar "Send to Claude" button and the `Option+K` / `Alt+K` shortcut, along with the terminal/extension detection plumbing.
- **External-link confirmation dialog**: opening an external link no longer shows an extension-level confirm — VS Code's own trusted-domains prompt on `openExternal` already covers it, so the extension dialog only stacked a second question on top. The `javascript:`/`file:`/`command:` scheme blocklist stays.

### Fixed

- **Link fragments survive modifier-click**: the click handler stripped `#…` from the href before messaging the host, which broke `file.md#27` line navigation and dropped anchors from external URLs.
- **Find bar tab order**: Tab in the Find field jumps straight to Replace when the replace row is open (Shift+Tab returns), matching VS Code's find widget, and the cycle wraps after Replace All back to the navigation buttons so every control stays keyboard-reachable; Escape still exits to the editor.
- **Inline math in a code block no longer crashes**: with the caret inside a code block (or a block node selected), the math toolbar button threw `Cannot read properties of null (reading 'nodeSize')`; the command now refuses cleanly where inline math cannot live.
- **Screen-reader names for toolbar buttons**: every toolbar button and dropdown trigger (Format, Font, Checks, Settings, overflow, Debug) now carries an `aria-label`; icon-only buttons derive it from their tooltip automatically, minus the shortcut hint.
- **Mark input rules near the end of the document**: `listSpreadNormalizePlugin` unioned step-map ranges without mapping them through later steps, so a multi-step mark input-rule transaction (`==x==`, and the same shape as `**x**`) near the doc end could compute a range past the final document and crash the dispatch — the mark silently failed to apply. Ranges are now clamped to the final doc size.

### Added

- **Callouts / admonitions**: GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) and Obsidian-style callouts (`> [!tip]- Optional title`, aliases like `hint`/`faq`/`error`, `+`/`-` fold markers) render with a per-kind icon and accent color, a collapsible body (visual only — folding never rewrites the file), and a type-picker dropdown in the title bar. Insert via the slash menu ("Callout"), the command palette, or by typing `[!note] ` at the start of a blockquote. Unknown types render neutrally; the marker line's exact source bytes round-trip verbatim, and a marker line with inline formatting deliberately stays a plain blockquote (not provably reconstructable).
- **Container directives**: `:::name` fenced blocks (the Docusaurus admonition syntax — titles, `{attrs}` kept raw, `::::` nesting) render as labeled containers with an editable body; known names (note/tip/info/warning/danger/…) pick up callout-style accents. Typing `:::name ` in an empty paragraph creates one. Built as a fidelity-safe tree transform — deliberately **not** remark-directive, whose text-directive syntax would swallow `:word` patterns in ordinary prose. Unclosed or formatted fences stay plain paragraphs.
- **Highlight**: `==marked text==` (Obsidian) renders as a theme-aware highlight; typing `==text==` applies it live, a Highlight command sits in the palette, and an opt-in toolbar button ships hidden by default (like Footnote). Strict grammar — no `=` inside, no edge spaces — anything else stays plain text, byte-preserved.
- **Editable callout and directive titles**: the title in a callout's or directive's header is an inline text field — click to edit, Enter or click away saves, Escape reverts, and an untouched blur never dirties the file. Callout titles write back backslash-escaped so a typed `*x*` can't downgrade the callout to a plain blockquote on reload; directive titles are sanitized (fence lines can't carry escapes) with any `{attrs}` block preserved. ⌘A/Ctrl+A inside a title selects the title only.
- **Callout icon affordances**: the kind icon is now the picker button — accent-chip hover, keyboard focus ring, and full keyboard menu support (Enter/Space/ArrowDown opens, arrows navigate, Enter applies, Escape closes) with `aria-haspopup`/`aria-expanded`/menu roles.
- **Notion callouts**: `<aside>` blocks from Notion's "Export as Markdown & CSV" (the shape Notion documents as having "no Markdown equivalent") render as editable callouts — the leading emoji becomes the icon and accent color (💡 tip, ⚠️ warning, 🐛 bug, …), the body is real editable markdown (the raw first segment is sub-parsed, so `**bold**` inside is a live mark, not literal text), and the exact byte shape round-trips including the blank-line-before-`</aside>` variant. Out-of-grammar shapes (the `<img>`-icon variant, unclosed asides, a blank line straight after `<aside>`) stay as the read-only sanitized HTML preview, byte-preserved.

- **Keyboard focus indicators**: every button and select in the editor UI now shows a `focusBorder` outline when focused via keyboard (mouse clicks stay ring-free) — previously keyboard focus was invisible across the find bar, toolbar, and link popup.
- **Find toggle shortcuts**: Alt+C / Alt+W / Alt+R (⌘⌥C/W/R on macOS) toggle Match Case / Whole Word / Regex from anywhere in the find bar, as in VS Code; the toggle tooltips show the shortcut.
- **Tooltips on keyboard focus**: tabbing onto a button now shows its tooltip (including shortcut hints), hidden again on blur or Escape; click focus stays silent since mouse users already have hover.
- **Keyboard activation for toolbar controls**: Enter/Space now activates toolbar buttons (previously they were wired to mousedown only, so keyboard focus could reach them but not trigger them), and the toolbar dropdowns (Format, Font, Checks, Settings, overflow) open from the keyboard — Enter/Space or ArrowDown on the trigger, arrows to move across rows, Enter to apply, Escape or tabbing away to close. Triggers now carry `aria-haspopup`/`aria-expanded`.
- **Slash command menu**: typing `/` at the start of a block (or after a space) opens a filterable, keyboard-first insert menu — headings, lists, task list, blockquote, divider, code block, mermaid diagram, table, image, link, math, footnote — with markdown-shortcut hints per row. Type to filter, arrows to navigate, Enter/Tab or click to insert, Escape to dismiss (typed text stays). The menu is context-aware (same-type list/quote toggles and schema-invalid items are hidden, e.g. only inline insertions inside table cells), never opens from undo/paste/external rewrites, and never steals focus. Items run the same actions as the toolbar and command palette, so behavior is identical everywhere.
- **Smart link resolution** (`markdownWysiwyg.smartLinks`, default on): clicking a local link resolves it the way a site generator would publish it — workspace-root paths (`/docs/guide`, VS Code's own convention), ancestor content roots (inside a Hugo `content/` tree, `/write/uber` opens `content/write/uber/index.md`), `.md`/`.markdown`/`index.md`/`_index.md` suffix inference, percent-decoding, and a workspace-wide suffix-match fallback. A miss shows a non-modal warning instead of VS Code's open error; resolution is click-time only (zero rendering cost). Off: links resolve relative to the document — a leading `/` still means the workspace root, never the filesystem root (previously it resolved to the filesystem root and always failed).
- **Wikilinks**: `[[target]]`, `[[target|alias]]`, `[[target#heading]]` (Obsidian conventions) parse, render as links, and round-trip **byte-identically** (the stringifier re-emits the exact source bytes between the brackets). Clicking resolves bare names by filename across the workspace (case-insensitive, markdown files preferred, shortest path wins); `[[#heading]]` jumps in page. Typing `[[` opens bare-name autocompletion (a bundle's `index.md` completes as its directory name; duplicate names disambiguate as paths). Parsing is always on so round-trip behavior never depends on configuration; navigation and autocomplete sit behind `smartLinks`. Note: where a `[a]: url` definition exists, `[[a]]` now reads as a wikilink rather than a bracketed shortcut reference — serialization is unchanged either way. `[[x]](url)` stays a normal CommonMark link (the citation pattern), never a wikilink. A bare `[[` opens the suggestion menu immediately; `\|` in a target reads as a plain pipe (Obsidian's in-table spelling), and newly created alias wikilinks escape their pipe inside table cells so a cell can never split.
- **Resolved-target hint**: the link popup shows where a local link will actually open (`→ content/write/replit/index.md`) — the same resolver the click uses, updating live under the URL input while editing; a smart-mode miss reads "not found in workspace".
- **Link edits save on blur**: the popup's confirm button is gone — Enter applies and closes, and moving focus away applies the edit while keeping the panel open, so a change is never lost to a stray click. Remove Link stays.
- **Link format switch**: the link popup's edit panel and the toolbar's insert-link prompt carry a two-option format control (`markdown` / `[[wiki]]`) — standard markdown is the default for new links, an existing link opens on its own current format, and switching converts the link in place in both directions. The wikilink option disables for external targets.
- **Cross-file heading navigation**: `file.md#some-heading` and `[[page#Heading]]` open the target and scroll to the matching heading, using the same slugs as in-page anchors.
- **Consistent right-click menus**: the toolbar now has its own context menu (Customize Toolbar / Extension Settings / Keyboard Shortcuts, mirroring the settings gear); Copy as HTML / Copy as Markdown appear in table and link menus too, and with nothing selected they copy the block under the cursor (right-click a table → copy the whole table); every content menu gains **Edit Raw Markdown** in a bottom group, preserving the scroll position like the toolbar button; the table menu shows a divider between the insert and delete actions.

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
