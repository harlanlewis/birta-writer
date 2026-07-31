# Features and settings

The complete reference. For the short version, see [`README.md`](../README.md); for *why* the fidelity guarantees matter, see [`BENEFITS.md`](BENEFITS.md).

***

## Your file stays yours

- **Byte-faithful round-trips** — the editor serializes your document and merges only the lines that really changed; formatting you chose (table padding, blank-line style, reference-link forms, setext headings) survives edits elsewhere in the file
- **Nothing is silently lost** — constructs Birta doesn't understand (Obsidian `#tags`, `%%comments%%`, Quarto cells, raw HTML) stay visible and untouched; a move or drop that would corrupt content on save is quietly declined instead of half-applied
- **A disk-drift badge** warns when a file with unsaved edits changes on disk (git, a terminal, an AI assistant) — reload or compare side by side; the editor never silently overwrites or merges
- **Offline by default** — images save into your workspace, remote loads are blocked, proofreading runs offline; document content has no path off your machine. The only two features that can touch the network — paste-unfurl and URL embeds — sit behind a master switch (`birta.network.enabled`) that ships **off**; with it off the editor makes no outbound request at all

## Blocks: grab, move, convert

Every block — paragraphs, headings, list items (at any depth), quotes, callouts, directives, code blocks, tables, images, footnotes, even blocks nested inside callouts and quotes — has a gutter handle showing its slash-menu icon. **Click it for the block menu** (turn into, duplicate, copy as Markdown, move, delete; headings get copy-link and whole-section moves), **drag it to move the block** — with an accent drop line, auto-scroll, and one-step undo. Select many blocks with a **marquee drag in the margins** or from the keyboard (**Escape** selects the current block, **Shift+↑/↓** extend, **Cmd+A** ladders block → document, **Alt+↑/↓** move), then drag any covered handle to move them all. Headings carry their sections, collapsed content always travels with its heading, and Tab/Shift-Tab indent list items one level without dragging their children along.

## Writing

- **All the basics**: headings H1–H6, **bold**, *italic*, ~~strikethrough~~, `inline code`, ==highlight==, blockquotes, horizontal rules, ordered/unordered/task lists (click a checkbox to toggle)
- **Slash menu**: type `/` at a block start (or after a space) for insertable everything — headings, lists, callouts, tables, code, math, footnotes — filtering as you type
- **Callouts**: GitHub-style `> [!note]` / `[!tip]` / `[!warning]` … render with icons and accent colors; `[!kind]-` markers start collapsed; Notion-style asides are preserved too
- **Math**: inline `$…$` and block `$$…$$` rendered with KaTeX (loaded lazily); click to edit the source in place
- **Footnotes**: insert, edit, and follow `[^1]`-style footnotes; definitions render at the end with back-references
- **Frontmatter**: YAML frontmatter renders as an editable key/value table at the top of the document (collapsible; `birta.frontmatterExpanded`)
- **Occurrence editing**: `Cmd+D` cycles through occurrences of the selection, `Cmd+Shift+L` selects them all — the common "change every X" cases without leaving WYSIWYG
- **Inline calculator**: type arithmetic with `=` at either end (`12 * 4 =` or `=5+7`) and the answer is offered as a suggestion — Tab accepts, or opt into insert-on-`=` (`birta.calc.autoInsert`, also a menu row and palette command). Deterministic parser, plain-text result, never anything with letters
- **Working checklists**: turn on **Move checked tasks to bottom** (toolbar Lists menu, task-list block menu, palette, or `birta.checklist.sinkChecked`) and checked items sink below the unchecked ones; **Uncheck All Tasks** resets a whole checklist in one undo step

## Proofreading — offline

Spelling, grammar, and style checking runs entirely on your machine (the [Harper](https://writewithharper.com) engine via WASM — nothing is sent anywhere). Style checks cover fillers, redundancies, clichés, wordiness, passive voice, long sentences, and AI-writing tells (vocabulary, artifacts, em-dash habits, non-ASCII punctuation) — each rule individually toggleable under `birta.styleCheck.*`. Findings are quiet dotted underlines with suggested fixes in a hover popup; "Add to dictionary" writes to your personal (never workspace) settings. Toggle everything with `Cmd+Alt+Shift+D` or the toolbar checks menu.

## Folding and navigation

- **Fold anything with structure**: heading sections, callouts, list items, tables, code blocks (`Cmd+Alt+[` / `Cmd+Alt+]`, fold-all/unfold-all commands, chevrons in the gutter). Folds persist across reopen, travel with drags — and an edit can never hide content you could see: a fold opens rather than silently swallowing anything
- **Table of contents**: auto-generated outline that is also a structural editor — **drag a TOC entry to move its whole section**, and drops that change nesting relevel the headings; click to jump
- **Sticky headings** keep your current section's heading pinned while you scroll; **Go to Symbol** (`Cmd+Shift+O`) jumps by heading; a **word count** for the document (or selection) lives in the status bar

## Links

- **Inline link editing**: hover a link for a popup with text/URL editing and a **format switch** (markdown ⇄ `[[wikilink]]`); supports `@/` workspace paths, `#anchor` jumps, `file.md#27` line links, and cross-file heading links
- **Smart link resolution** (`birta.smartLinks`): local links resolve the way your site generator publishes them — workspace-root paths, ancestor content roots, `.md`/`index.md`/`_index.md` inference; external links open through VS Code's own trusted-domains prompt
- **Wikilinks**: `[[target]]`, `[[target|alias]]`, `[[target#heading]]` (Obsidian conventions) parse, render, navigate, and round-trip byte-identically; typing `[[` opens name autocompletion
- **Section links**: pick a heading from a live list (`/section`, the selection palette, or Link to Section) and a standard `[text](#slug)` anchor is inserted; typing `#` in the link editor's URL field suggests the document's headings. **Renaming a heading repoints every in-note anchor to it** — same undo step (`birta.autoUpdateAnchors`)
- **Paste a bare URL** (nothing selected) and, with network features on, the page's own title is fetched extension-side (no third-party service) and *offered* as the link text — accept it and the link becomes `[title](url)`; ignore it and the plain link stays. Nothing is written to your file until you accept, unless you turn on `birta.pasteUnfurl.autoApply`. A bare **YouTube link** on its own line renders as a player card instead — display only, so the file keeps the plain link either way (`birta.embeds.enabled`), and a link that can become a card is never retitled
- **Path autocomplete**: `@/`, `./`, `../` inside inline code browse the workspace with file-type icons

## Tables

Full GFM support: hover a border for **+ insert lines**, click **⠿ handles** to select rows/columns, drag them to reorder, align columns from the table toolbar — all updating live as the table grows. Shift+Enter inserts a line break inside a cell.

## Code and diagrams

- Syntax highlighting for ~66 languages (grammars load lazily — they cost nothing at launch), a searchable language picker, one-click copy, drag-to-resize height, and a full-screen editor
- **Mermaid** diagrams render inline with source/preview toggle, zoom, pan, and a full-screen lightbox; the theme follows your editor (`birta.mermaid.theme`)

## Images

Paste from the clipboard, drag-and-drop, or pick a file — images save into your workspace with MD5 deduplication and are **never uploaded**. Click to select, click again for a lightbox; captions edit in place.

## Find and replace

`Cmd+F` opens find; `Cmd+Alt+F` (or `Ctrl+H` on Windows/Linux) opens replace — with match-case, whole-word, and regex modes, live highlighting, and Replace All. `Enter`/`Shift+Enter` step through matches; find-in-selection scopes the search.

## Theming

The editor follows your active VS Code color theme automatically — text, code, callouts, tables, and Mermaid all recolor from the theme's palette, live, with nothing to configure. Content font and size are independent of theme (`birta.fontPreset`, `birta.fontSize`).

## Saving

The editor is backed by a native text document: saving is VS Code's own `Cmd+S` / `files.autoSave`, unsaved edits show `●` in the tab, and hot exit protects your work like any editor. Switching to Raw Markdown (`Cmd+Shift+M`) and back is lossless; external file changes (git, other editors) sync in without stealing your cursor. If the editor ever hits an internal error, VS Code shows a notification instead of failing silently — your document and its save path are unaffected.

***

## Keyboard shortcuts

macOS shown; Ctrl on Windows/Linux unless noted — all rebindable in VS Code's Keyboard Shortcuts.

| Keys | Action |
| --- | --- |
| `/` at a block start | Slash menu (insert anything) |
| `Cmd+.` | Block menu for the current block |
| `Esc`, then `Shift+↑/↓` | Select blocks from the keyboard; `Alt+↑/↓` moves them |
| `Cmd+F` · `Cmd+Alt+F` | Find · Replace (`Ctrl+H` on Windows/Linux) |
| `Cmd+D` · `Cmd+Shift+L` | Next occurrence · all occurrences |
| `Cmd+Alt+[` / `Cmd+Alt+]` | Fold / unfold (`Ctrl+Shift+[` / `]` on Windows/Linux) |
| `Cmd+Shift+O` | Go to heading |
| `Cmd+K` | Insert / edit link |
| `Cmd+Alt+1…6` / `Cmd+Alt+0` | Heading level / paragraph |
| `Cmd+Shift+M` | Toggle WYSIWYG ⇄ Raw Markdown |

The full list lives in the shortcuts help (toolbar ⌄ menu → *Show Keyboard Shortcuts*, or the command palette).

***

## Settings

The settings you're most likely to touch. The full list — including per-item toolbar layout under `birta.toolbar.*` / `birta.floatingToolbar.*` and per-rule proofreading toggles under `birta.styleCheck.*` — is searchable in VS Code's Settings UI under "Birta".

| Setting | Default | Description |
| --- | --- | --- |
| `birta.defaultMode` | `"preview"` | Open `.md` in WYSIWYG (`preview`) or the text editor (`markdown`) |
| `birta.proofreading.enabled` | `true` | Master switch for spelling/grammar/style checking |
| `birta.blockHandles` | `"headings"` | Gutter handles at rest: `headings`, `always`, or `hover` |
| `birta.lineNumbers` | `false` | Source line numbers along the window's start edge, spaced to the rendered document |
| `birta.fontPreset` | `"editor"` | Content font: follow the VS Code editor font, or `sans` / `serif` / `mono` |
| `birta.fontSize` | `100` | Content font size as % of the editor font (50–200) |
| `birta.contentWidth` | `"full"` | Fill the pane, or cap at Max Content Width (`fixed`) |
| `birta.maxContentWidth` | `100` | Width cap in `ch` when Content Width is `fixed` |
| `birta.tocPosition` | `"right"` | Which side the table of contents docks on |
| `birta.frontmatterExpanded` | `true` | Frontmatter table starts expanded or collapsed |
| `birta.frontmatterAddButton` | `false` | Show the Add metadata button on documents without frontmatter (Edit Frontmatter starts the same flow either way) |
| `birta.smartLinks` | `true` | Site-generator-style local link resolution |
| `birta.copyFormat` | `"markdown"` | What Cmd+C puts on the clipboard as plain text: the selection's Markdown source, or the rendered text (`richText`); the rich HTML flavor is always included |
| `birta.pasteFormat` | `"markdown"` | How Cmd+V reads plain text: parsed as Markdown source, or inserted literally (`plainText`); rich pastes and code blocks are unaffected, and Paste as Plain Text (⇧⌘V) is always literal |
| `birta.network.enabled` | `false` | Master network switch — offline by default; gates paste-unfurl and URL embeds. Off means no outbound request at all |
| `birta.pasteUnfurl.enabled` | `true` | Paste a bare URL (nothing selected) to fetch the page title and offer it as the link text; needs `birta.network.enabled` (offered inline when off), falls back to the plain link offline |
| `birta.pasteUnfurl.autoApply` | `false` | Apply a fetched title as soon as it arrives instead of offering it — off by default, so a network reply never edits your document unprompted |
| `birta.embeds.enabled` | `true` | Bare YouTube links on their own line render as player cards — display only, your file is never changed; needs `birta.network.enabled` |
| `birta.autoUpdateAnchors` | `true` | Renaming a heading repoints every in-note `[text](#slug)` link to it, in the same undo step |
| `birta.calc.enabled` | `true` | Inline calculator: `12 * 4 =` (or `=5+7`) offers the result as a suggestion (Tab to accept; Return stays a newline) |
| `birta.calc.autoInsert` | `false` | Insert the calc result immediately on `=` instead of offering a suggestion |
| `birta.checklist.sinkChecked` | `false` | Checked task items sink below their unchecked siblings (and float back up when unchecked) |
| `birta.tableWrap` | `"normal"` | Table cell wrapping: `normal`, `aggressive`, or `none` |
| `birta.codeBlockMaxHeight` | `600` | Max code block height in pixels |
| `birta.mermaid.theme` | `"light"` | Mermaid palette: `light`, `dark`, or `auto` (follow VS Code) |
| `birta.imageLocalPath` | `""` | Workspace-relative folder for pasted/dropped images |

***

## Compatibility with other Markdown tools

Birta isn't a personal-knowledge-management tool — it reads and writes plain Markdown files. But because it preserves what it doesn't interpret (see [fidelity and safety](BENEFITS.md#fidelity-and-safety-come-first)), it works well *on the files* of many tools people already use. Interop is a consequence of fidelity, not a design goal, so this is about what's safe to open and edit — not about matching each tool's feature set.

| Tool | Birta can open it | Notes |
| --- | --- | --- |
| **Obsidian** | 🟢 directly (`.md` vault) | Wikilinks, `==highlights==`, `> [!callouts]`, footnotes, math, and frontmatter render or round-trip; `#tags`, `^block-ids`, `![[embeds]]`, `%%comments%%` are preserved as text |
| **Foam** | 🟢 directly (`.md`) | Same wikilink family; its link-reference-definition shim is preserved, not inlined away |
| **"Second Brain" / PARA** | 🟢 directly | A folder convention, not a format — nothing tool-specific to preserve |
| **Logseq** | 🟡 opens (round-trip unverified) | Text is preserved, but its outliner model renders as one big nested list; whether Birta keeps the exact bullet indentation Logseq's structure needs is untested |
| **Quarto** (`.qmd`) | 🟡 needs a file association | Safe to round-trip; executable cells, `:::` fenced divs, shortcodes, and citations are preserved as inert text/code, not understood |
| **MDX** (`.mdx`) | 🔴 not recommended | MDX changes base Markdown rules and adds JSX/imports; re-serializing edited regions risks invalid MDX |
| **Roam Research** | 🔴 export first | Proprietary database (JSON/EDN), not files |
| **Bear** | 🔴 export first | Proprietary SQLite database, not files |
| **Emacs Org mode** | 🔴 out of scope | `.org` is a different markup language, not Markdown |

See [`BENEFITS.md`](BENEFITS.md#compatibility-with-other-markdown-tools) for the full breakdown, including per-tool syntax fidelity and the confidence caveat.

***

## Requirements

VS Code **1.95** or later — the minimum `package.json` contributes (`engines.vscode`), raised from 1.80 by the Language Model Tool integration.

## Known limitations

- **Editable HTML** is not yet supported — embedded HTML renders read-only; editing it means switching to the raw text editor
- **Global search navigation**: clicking a search result for a `.md` file may not scroll to the matched line in WYSIWYG mode when multiple `.md` files are open simultaneously
- **True multi-caret editing, column (box) selection, and transpose** are deliberately not reimplemented — pop to the raw editor for those (`Cmd+Shift+M`, which round-trips losslessly); in-editor, occurrence cycling and Replace All cover the common cases
