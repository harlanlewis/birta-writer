# Features and settings

The complete reference. For the short version, see [`README.md`](../README.md); for *why* the fidelity guarantees matter, see [`BENEFITS.md`](BENEFITS.md).

***

## Your file stays yours

### Byte-faithful round-trips

The editor serializes your document and merges back only the lines that really changed. Formatting you chose survives edits elsewhere in the file: table padding, blank-line style, reference-link forms, setext headings.

### Nothing is silently lost

Constructs Birta doesn't understand stay visible and untouched, among them Obsidian `#tags`, `%%comments%%`, Quarto cells, and raw HTML. A move or drop that would corrupt content on save is quietly declined instead of half-applied.

### A badge when the file drifts on disk

Birta raises a badge when a file with unsaved edits changes on disk, whether the writer was git, a terminal, or an AI assistant. You can reload from disk or compare side by side. The editor never silently overwrites or merges.

### Offline by default

Images save into your workspace, remote loads are blocked, and proofreading runs offline, so document content has no path off your machine. Only three features can touch the network: paste-unfurl, URL embeds, and link cards. All three sit behind a master switch, `birta.network.enabled`, which ships off, and link cards ship off beneath it as well. With the master off the editor makes no outbound request at all.

## Blocks: grab, move, convert

Every block carries a gutter handle showing its slash-menu icon. That covers paragraphs, headings, list items at any depth, quotes, callouts, directives, code blocks, tables, images, footnotes, and blocks nested inside callouts and quotes.

Click the handle for the block menu: turn into, duplicate, copy as Markdown, move, delete. Headings also get copy-link. Drag the handle to move the block, with an accent drop line, auto-scroll, and one-step undo.

Select many blocks with a marquee drag in the margins, or from the keyboard: Escape selects the current block, Shift+↑/↓ extend, Cmd+A ladders block → document, Alt+↑/↓ move. Then drag any covered handle to move them all.

A move in the text is literal: a heading travels alone and the paragraphs under it keep their place. Section moves live in the table of contents, where a row stands for a whole section. Collapsed content always travels with its heading, wherever you move it, and Tab/Shift-Tab indent list items one level without dragging their children along.

## Writing

- The basics. Headings H1 to H6, `**bold**`, `*italic*`, `~~strikethrough~~`, `inline code`, ==highlight==, blockquotes, horizontal rules, and ordered, unordered, and task lists. Clicking a checkbox toggles it.
- Slash menu. Typing `/` at a block start, or after a space, opens everything insertable: headings, lists, callouts, tables, code, math, footnotes. It filters as you type.
- Callouts. GitHub-style `> [!note]` / `[!tip]` / `[!warning]` and friends render with icons and accent colors. A `[!kind]-` marker starts collapsed. Notion-style asides are preserved too.
- Math. Inline `$...$` and block `$$...$$` render with KaTeX, loaded lazily. Clicking one edits its source in place.
- Footnotes. `[^1]`-style footnotes can be inserted, edited, and followed. Their definitions render at the end with back-references.
- Frontmatter. YAML frontmatter renders as an editable key/value table at the top of the document, collapsible via `birta.frontmatterExpanded`.
- Occurrence editing. `Cmd+D` cycles through occurrences of the selection and `Cmd+Shift+L` selects them all, covering the common "change every X" cases without leaving WYSIWYG.
- Inline calculator. Arithmetic with `=` at either end (`12 * 4 =` or `=5+7`) gets its answer offered as a suggestion, which Tab accepts. Functions and constants count as arithmetic (`sqrt(9) =`, `3+log10(100)/π^2 =`), because each means one thing in any document; a variable does not, and belongs to `=>`. `birta.calc.autoInsert` opts into insert-on-`=` instead, and it is also a menu row and a palette command. The parser is deterministic, the result is plain text, and it never produces anything with letters in it.
- Ask your agent from the caret. `/ai`, Space, then a request in plain words (`/ai add a mermaid diagram of the flow above`), then Enter. Birta composes one line, your request plus a `path.md#L12` reference to the caret, saves the document so that reference names what is on disk, and hands the line to the agent you already run per `birta.agent.command` (asked once, on first use): a shell command such as `claude -p {prompt} --permission-mode acceptEdits`, VS Code's Chat view, or the clipboard. Nothing is sent to a model by Birta itself, and it is one request each time, not a conversation. Ask Agent in the palette does the same and asks for the request in an input box.
- The agent works in the background by default (`birta.agent.mode`): no terminal, a small filled pill with a stop square in the gutter beside the line you typed the request on (hover it for which harness, click it to stop the run), and when it finishes its edit lands in the editor and undoes with Cmd+Z like a paste; if you kept typing meanwhile the edit is merged around yours. A run that changes nothing reports the agent's last words in a message, a failure is a message and an error mark, and a Birta AI output channel keeps every transcript. A status bar item shows live runs and stops them all on click. Set the mode to `terminal` to watch the run in one reused Birta AI terminal instead.
- Working checklists. With Move checked tasks to bottom on (toolbar Lists menu, task-list block menu, palette, or `birta.checklist.sinkChecked`), checked items sink below the unchecked ones. Uncheck All Tasks resets a whole checklist in one undo step.

## Offline proofreading

Spelling, grammar, and style checking runs entirely on your machine, on the [Harper](https://writewithharper.com) engine via WASM. Nothing is sent anywhere.

Style checks cover fillers, redundancies, clichés, wordiness, passive voice, long sentences, and AI-writing tells (vocabulary, artifacts, em-dash habits, non-ASCII punctuation, and uniform rhythm: a paragraph whose sentences all run to about the same length, the structural habit that most makes prose read as machine-written). Each rule toggles individually under `birta.styleCheck.*`. The tells are a lens on your own habits, never a verdict on who wrote the text: each finding names the habit and why it reads as generic, and you keep it or change it.

Findings are quiet dotted underlines, with suggested fixes in a hover popup. "Add to dictionary" writes to your personal settings, never the workspace, and "Keep this phrase" on a flagged phrase does the same for `birta.styleCheck.exceptions`, your protect-list of phrases that are yours and no check may flag. Toggle everything with `Cmd+Alt+Shift+D` or the toolbar checks menu.

## Folding and navigation

- Folding works on anything with structure: heading sections, callouts, list items, tables, code blocks (`Cmd+Alt+[` / `Cmd+Alt+]`, fold-all and unfold-all commands, chevrons in the gutter). Folds persist across reopen and travel with drags. An edit can never hide content you could see, because a fold opens rather than silently swallowing anything.
- Table of contents: an auto-generated outline that is also a structural editor. Drag a TOC entry to move its whole section, and a drop that changes nesting relevels the headings. Click to jump.
- Sticky headings keep your current section's heading pinned while you scroll.
- Go to Heading (`Cmd+Shift+O`) jumps by heading.
- A word count for the document, or for the selection, lives in the status bar.

## Links

- Inline link editing. Hovering a link opens a popup with text and URL editing plus a format switch (markdown ⇄ `[[wikilink]]`). It supports `@/` workspace paths, `#anchor` jumps, `file.md#27` line links, and cross-file heading links.
- Smart link resolution (`birta.smartLinks`). Local links resolve the way your site generator publishes them: workspace-root paths, ancestor content roots, and `.md` / `index.md` / `_index.md` inference. External links open through VS Code's own trusted-domains prompt.
- Wikilinks. `[[target]]`, `[[target|alias]]`, and `[[target#heading]]` (Obsidian conventions) parse, render, navigate, and round-trip byte-identically. Typing `[[` opens name autocompletion.
- Section links. Picking a heading from a live list (`/section`, the selection palette, or Link to Section) inserts a standard `[text](#slug)` anchor. Typing `#` in the link editor's URL field suggests the document's headings. Renaming a heading repoints every in-note anchor to it, in the same undo step (`birta.autoUpdateAnchors`).
- Bare-URL paste. Pasting a bare URL with nothing selected fetches the page's own title extension-side, with network features on and no third-party service involved, and offers it as the link text. Accept it and the link becomes `[title](url)`; ignore it and the plain link stays. Nothing is written to your file until you accept, unless you turn on `birta.pasteUnfurl.autoApply`. A bare YouTube link on its own line renders as a player card instead. The card is display only, so the file keeps the plain link either way (`birta.embeds.enabled`), and a link that can become a card is never retitled.
- Link cards. A web link alone on its own line, bare or `[labelled](url)`, can render as a quiet card of the page's title, description, and site, read from the page's own Open Graph metadata; the file keeps the plain link. Off by default (`birta.linkCards.enabled`, or per link from the block menu's Show as Card / Show as Link), and needs `birta.network.enabled`. Cmd/Ctrl+click on any card body, link card or embed, opens the page; a plain click selects it, and in read-only mode a plain click opens it too.
- Path autocomplete. `@/`, `./`, and `../` inside inline code browse the workspace with file-type icons.

## Tables

Full GFM support. Hover a border for the + insert bars, click a ⠿ handle to select a row or column, then drag it to reorder. Align columns from the table toolbar. All of it updates live as the table grows. Shift+Enter inserts a line break inside a cell.

## Code and diagrams

- Syntax highlighting for ~66 languages, with a searchable language picker, one-click copy, drag-to-resize height, and a full-screen editor. Grammars load lazily, so they cost nothing at launch.
- Mermaid diagrams render inline with a source/preview toggle, zoom, pan, and a full-screen view. The theme follows your editor (`birta.mermaid.theme`). Full screen shows the diagram edge to edge on its own paper, with the same controls in the same corners it uses in the page.
- PlantUML diagrams (```` ```plantuml ````/```` ```puml ````) render the same way, through the same preview, with the same zoom, pan and lightbox. Rendering is offline: the engine ships with the editor, so no diagram source leaves your machine and directives that would fetch a remote theme or include fail rather than reaching out. Palette via `birta.plantuml.theme`.
- Graphviz graphs (```` ```dot ````/```` ```graphviz ````) render through that same preview, with the same zoom, pan and lightbox. The layout engine ships with the editor, so nothing leaves your machine. There is no palette setting: a graph is drawn on its own light paper rather than recolored, because recoloring means rewriting your source.
- An SVG picture in a ```` ```svg ```` fence renders inline through the same preview too. The source stays in the document, editable and diffable and round-tripping as an ordinary code block, which is what makes it a good place to put a picture an agent wrote for you. What is drawn is filtered first: script, event handlers, a `<style>` element that would reach outside the picture, and any reference that would fetch from the network are all removed, in the editor and in an exported HTML file alike. An embedded `data:` image and a `url(#id)` reference to the picture's own gradients and filters are kept. Two elements are dropped outright rather than filtered, and they are worth knowing because a picture can visibly lose something: `<use>`, so an icon sprite renders empty, and `<foreignObject>`, so a diagram whose text labels are HTML rather than `<text>` renders without them. Dropping or pasting an `.svg` file does something different and simpler: it saves the file beside your document and links it, the way any other image does.

## Images

Paste from the clipboard, drag and drop, or pick a file. Images save into your workspace with MD5 deduplication and are never uploaded. Click to select, click again for a lightbox; captions edit in place.

## Find and replace

`Cmd+F` opens find. `Cmd+Alt+F` (or `Ctrl+H` on Windows/Linux) opens replace, with match-case, whole-word, and regex modes, live highlighting, and Replace All. `Enter` and `Shift+Enter` step through matches, and find-in-selection scopes the search.

## Theming

The editor follows your active VS Code color theme automatically. Text, code, callouts, tables, and Mermaid all recolor from the theme's palette, live, with nothing to configure. Content font and size are independent of the theme (`birta.fontPreset`, `birta.fontSize`).

## Saving

The editor is backed by a native text document, so saving is VS Code's own `Cmd+S` and `files.autoSave`, unsaved edits show `●` in the tab, and hot exit protects your work like any editor.

Switching to Raw Markdown (`Cmd+Shift+M`) and back is lossless. External file changes from git or another editor sync in without stealing your cursor. If the editor ever hits an internal error, VS Code shows a notification instead of failing silently, and your document and its save path are unaffected.

## Export

Export as HTML (palette, or the right-click menu's Export group) writes the rendered document as one self-contained HTML file: diagrams as SVG, math, code highlighting, tables, callouts, task state, footnotes and images, styled with the theme the editor is showing and print-ready, with editor chrome and proofreading marks left out. It offers to open the file in your browser, where print-to-PDF is one step. Images stay linked relative to the document, so save the export beside it.

***

## Keyboard shortcuts

macOS shown; Ctrl on Windows/Linux unless noted. Most are contributed commands and rebindable in VS Code's Keyboard Shortcuts. The block and selection chords (Escape, Shift+Arrow, Alt+Arrow) are not: they are handled inside the editor and cannot convert to contributed keybindings, for the three structural reasons set out in `webview/keyboardShortcuts.ts`. You can bind an extra key to the equivalent palette command, but you cannot rebind the chord itself.

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
| `Cmd+Alt+1` to `Cmd+Alt+6` / `Cmd+Alt+0` | Heading level / paragraph |
| `Cmd+Shift+M` | Toggle WYSIWYG ⇄ Raw Markdown |

The full list lives in the shortcuts help: the toolbar's settings menu → *Show Keyboard Shortcuts*, or the command palette.

***

## Settings

The settings you're most likely to touch. The full list is searchable in VS Code's Settings UI under "Birta", including per-item toolbar layout under `birta.toolbar.*` and `birta.floatingToolbar.*`, and per-rule proofreading toggles under `birta.styleCheck.*`.

| Setting | Default | Description |
| --- | --- | --- |
| `birta.defaultMode` | `"preview"` | Open `.md` in WYSIWYG (`preview`) or the text editor (`markdown`) |
| `birta.proofreading.enabled` | `true` | Master switch for spelling, grammar, and style checking |
| `birta.blockHandles` | `"headings"` | Gutter handles at rest: `headings`, `always`, or `hover` |
| `birta.lineNumbers` | `false` | Source line numbers along the window's start edge, spaced to the rendered document |
| `birta.fontPreset` | `"editor"` | Content font: follow the VS Code editor font, or `sans` / `serif` / `mono` |
| `birta.fontSize` | `100` | Content font size as % of the editor font (50 to 200) |
| `birta.contentWidth` | `"full"` | Fill the pane, or cap at Max Content Width (`fixed`) |
| `birta.maxContentWidth` | `100` | Width cap in `ch` when Content Width is `fixed` |
| `birta.tocPosition` | `"right"` | Which side the table of contents docks on |
| `birta.frontmatterExpanded` | `true` | Frontmatter table starts expanded or collapsed |
| `birta.frontmatterAddButton` | `false` | Show the Add metadata button on documents without frontmatter (Edit Frontmatter starts the same flow either way) |
| `birta.smartLinks` | `true` | Site-generator-style local link resolution |
| `birta.agent.command` | `""` | Where `/ai` and Ask Agent hand your request: a shell command with `{prompt}` (`claude -p {prompt} --permission-mode acceptEdits`), `chat` for the VS Code Chat view, or `clipboard`. Empty asks on first use. Never read from a workspace |
| `birta.agent.mode` | `"background"` | How a shell command in `birta.agent.command` runs: `background` (no terminal, a stop pill in the gutter while it runs, the edit undoes like a paste) or `terminal` (one reused Birta AI terminal) |
| `birta.copyFormat` | `"markdown"` | What Cmd+C puts on the clipboard as plain text: the selection's Markdown source, or the rendered text (`richText`). The rich HTML flavor is always included |
| `birta.pasteFormat` | `"markdown"` | How Cmd+V reads plain text: parsed as Markdown source, or inserted literally (`plainText`). Rich pastes and code blocks are unaffected, and Paste as Plain Text (⇧⌘V) is always literal |
| `birta.network.enabled` | `false` | Master network switch, offline by default; gates paste-unfurl, URL embeds, and link cards. Off means no outbound request at all |
| `birta.pasteUnfurl.enabled` | `true` | Paste a bare URL (nothing selected) to fetch the page title and offer it as the link text. Needs `birta.network.enabled` (offered inline when off), and falls back to the plain link offline |
| `birta.pasteUnfurl.autoApply` | `false` | Apply a fetched title as soon as it arrives instead of offering it. Off by default, so a network reply never edits your document unprompted |
| `birta.embeds.enabled` | `true` | Bare YouTube links on their own line render as player cards. Display only, so your file is never changed; needs `birta.network.enabled` |
| `birta.linkCards.enabled` | `false` | A lone web link on its own line renders as a card of the page's title and description. Display only; needs `birta.network.enabled`. Choose per link from the block menu when off |
| `birta.autoUpdateAnchors` | `true` | Renaming a heading repoints every in-note `[text](#slug)` link to it, in the same undo step |
| `birta.calc.enabled` | `true` | Inline calculator: `12 * 4 =` (or `=5+7`) offers the result as a suggestion (Tab to accept; Return stays a newline) |
| `birta.calc.autoInsert` | `false` | Insert the calc result immediately on `=` instead of offering a suggestion |
| `birta.checklist.sinkChecked` | `false` | Checked task items sink below their unchecked siblings, and float back up when unchecked |
| `birta.tableWrap` | `"normal"` | Table cell wrapping: `normal`, `aggressive`, or `none` |
| `birta.codeBlockMaxHeight` | `600` | Max code block height in pixels |
| `birta.mermaid.theme` | `"light"` | Mermaid palette: `light`, `dark`, or `auto` (follow VS Code) |
| `birta.plantuml.theme` | `"light"` | PlantUML palette: `light`, `dark`, or `auto` (follow VS Code) |
| `birta.imageLocalPath` | `""` | Workspace-relative folder for pasted and dropped images |

***

## Compatibility with other Markdown tools

Birta isn't a personal-knowledge-management tool. It reads and writes plain Markdown files, and because it preserves what it doesn't interpret (see [fidelity and safety](BENEFITS.md#fidelity-and-safety-come-first)), it works well *on the files* of many tools people already use. Interop is a consequence of fidelity, not a design goal, so this is about what's safe to open and edit rather than about matching each tool's feature set.

| Tool | Birta can open it | Notes |
| --- | --- | --- |
| Obsidian | Yes, directly (`.md` vault) | Wikilinks, `==highlights==`, `> [!callouts]`, footnotes, math, and frontmatter render or round-trip; `#tags`, `^block-ids`, `![[embeds]]`, `%%comments%%` are preserved as text |
| Foam | Yes, directly (`.md`) | Same wikilink family; its link-reference-definition shim is preserved, not inlined away |
| "Second Brain" / PARA | Yes, directly | A folder convention, not a format, so there is nothing tool-specific to preserve |
| Logseq | Yes, opens (round-trip tested) | Its outliner model renders as one big nested list, because every block is a bullet and tab indentation encodes the tree. Untouched lines keep their tabs and org tokens byte for byte, and an edited or moved block keeps the file's own indentation, so its nested children stay children. Pinned by `logseqRoundTrip.test.ts`, which `pnpm fidelity` runs |
| Quarto (`.qmd`) | Caution, needs a file association | Safe to round-trip; executable cells, `:::` fenced divs, shortcodes, and citations are preserved as inert text or code, not understood |
| MDX (`.mdx`) | Yes, directly (MDX mode) | Parses the real MDX grammar; prose edits work as in Markdown, while JSX, `{expressions}` and `import`/`export` stay inert, read-only, and round-trip byte-perfect. A file that is not valid MDX falls back to the text editor with the parser's error. Don't rename `.mdx` to `.md`, which bypasses the mode and makes an edit corrupting |
| Roam Research | No, export first | Proprietary database (JSON/EDN), not files |
| Bear | No, export first | Proprietary SQLite database, not files |
| Emacs Org mode | No, out of scope | `.org` is a different markup language, not Markdown |

See [`BENEFITS.md`](BENEFITS.md#compatibility-with-other-markdown-tools) for the full breakdown, including per-tool syntax fidelity and the confidence caveat.

***

## Requirements

VS Code 1.95 or later, the floor `package.json` declares in `engines.vscode`. The Language Model Tool integration raised it from 1.80.

## Known limitations

- Editable HTML is not yet supported. Embedded HTML renders read-only, and editing it means switching to the raw text editor.
- Global search navigation: clicking a search result for a `.md` file may not scroll to the matched line in WYSIWYG mode when multiple `.md` files are open simultaneously.
- True multi-caret editing, column (box) selection, and transpose are deliberately not reimplemented. Pop to the raw editor for those (`Cmd+Shift+M`, which round-trips losslessly). In-editor, occurrence cycling and Replace All cover the common cases.
