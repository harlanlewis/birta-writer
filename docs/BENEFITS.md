# Birta Writer

Birta Writer is a visual editor for richly formatted Markdown documents. It strives to be your favorite way to write and edit text.

## Why I use it

- Fast to open and responsive to use.

- Familiar and powerful controls including slash commands, block-based drag-and-drop, and VS Code keyboard shortcuts for editing.

- Instant updates reflect changes made outside of your edits, including AI agent edits or cloud sync.

- Safely opens and edits any Markdown-like content, with no risk of data loss or unexpected modification from a parser mishandling unfamiliar syntax. Document fidelity is a first-class concern.

- It sits within [VS Code](https://code.visualstudio.com) and its _vast_ (but optional!) catalog of themes and extensions. You're a keystroke away from editing files in the raw editor, or comparing changes in a diff view. Birta Writer is simple by design, but every aspect is customizable through VS Code's settings scopes at app, user, or project level.

- It helps me write better:
    - Offline proofreading of spelling, grammar, prose, and common "AI tells" in sentence construction, punctuation, and vocabulary.
    - Customizable draft-management tools for `[TK]` notes, `TODOs`, and inline comments. Each marker is highlighted where it sits, so unresolved bits are visible while writing, and the review sidebar lists them all for jumping between. The in-text highlighting is a switch in the Checks menu and on the sidebar's Notes tab, independent of the proofreading switches, because your own notes are content, not findings.

- It's better than me at math:
    - Basic equations compute in text. `6^2+(8*3/4)= 42` prints the answer after the `=`. It updates when you change the equation, too.

    - Variables, conversions, and more advanced math with `=>`
        - Construct formulas...
            - a=2, b=4
            - c=sqrt(a²+b²) => 4.472136
            - log10(c\*100+π^2) => 2.659995

        - ... for something useful...
            - budget=3000, rent=700, food=600
            - savings=budget-(rent+food) => 1700
            - savings \* 12 => 20400

        - ...or quick conversions:
            - 24901 mile in km => 40074.274944
            - t = 24\*60\*60\*1000ms in days => 1
            - t\*365 days in weeks => 52.142857

    - The answers are portable, because the equation stays plain text and any calculator can be handed it. Where notations disagree, Birta follows the overwhelming majority: `%` is modulo carrying the divisor's sign, `round` sends halves away from zero, trig is in radians, `-2 ^ 2` is `-4`. Where there is no majority, it declines to answer rather than guess. A bare `log(...)` is base 10 in spreadsheets and natural in Python, so it computes as neither. The menu offers both readings with their values, and picking one rewrites the equation to `log10` or `ln` so the meaning travels with the file.

- It's private.
    - By default, it makes no network requests of any kind. Even rich link previews are opt-in.
    - No usage tracking to opt out of, because it doesn't exist.

While superficially a single-document editor, Birta Writer has deep system awareness and broad compatibility:

- Display and edit both basic Markdown and extended syntax used by [Obsidian](https://obsidian.md), [Foam](https://marketplace.visualstudio.com/items?itemName=foam.foam-vscode), [GitHub](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax), [Notion exports](https://www.notion.com/help/export-your-content), and others.
- Crosslink local documents with Markdown links, [wikilinks](https://obsidian.md/help/links), or even [Logseq](https://www.markdownguide.org/tools/logseq/) with an inline file browser UI.
- Interactive [Mermaid](https://mermaid.js.org) diagrams, [LaTeX](https://en.wikipedia.org/wiki/LaTeX) rendering, images, and a full-featured visual table editor with drag-and-drop rows and columns.
- Optionally display rich link previews or embedded documents and videos.

It's not a wiki, knowledge base, or [PKM](https://en.wikipedia.org/wiki/Personal_knowledge_management) - but it sure can act like one:

- Open an existing Obsidian vault in VS Code and use the file explorer and command palette to view your full repository of knowledge.
- Markdown files open automatically in Birta Writer. Crosslink them. Click to navigate across pages. View files side by side in a window.
- Open GitHub Copilot, Claude Code, or another AI assistant in a VS Code sidebar to chat with and modify your documents live, and let it see what you're looking at. VS Code hides a custom editor from the active-editor API agents read, so Birta bridges the gap. Copy a precise `file.md#L12-L20` reference (or the reference plus the selected lines, quoted as real markdown) to paste into any agent, or let a tool-using agent pull your current file, caret, and selection directly: a Language Model Tool for Copilot agent mode, and a public API for any extension. No more hand-directing the agent to the lines you mean.

Use Birta Writer as a knowledge base complement when you want a more enjoyable and helpful writing tool, or lean on VS Code and fully replace your other systems.

## Why I made it

Almost everything I do on a computer in 2026 reduces to code and context.

I pipe meeting transcripts → research repositories → spreadsheets → confluence documents → tickets → coding agents → pull request descriptions → communication channels → slide decks. Then back again.

The emergent interface between humans and AI is text, and the dominant flavor is Markdown.

Markdown is simple, semantic, portable, universal, and I _really_ want to love my tools for reading and writing it.

I'm tired of:

- Pouring content into proprietary systems, only for my preferences to change or for the platforms to develop in ways that no longer serve me.

- Copy-pasting across apps, losing all formatting and semantics.

- Restricting my documents to a single tightly-coupled AI agent system or harness.

- Tools that leak private content. Experience in both security and health technology companies has strongly shaped my thinking and expectations here.

- Popping back and forth between apps depending on the format of my text document. It's just text.

- Choosing between:
    - Beautiful, modern, and thoughtfully designed apps that are extractive and centralized,
    - or functional, dated, somewhat incoherent tools that are portable and extensible.

### Design principles

Every new feature, interaction, and presentation decision must satisfy my bar for quality:

1. Data fidelity first. Preserve, rather than "correct", unexpected syntax that the editor can't handle. Bonus: broad interoperability with Obsidian, [Foam](https://marketplace.visualstudio.com/items?itemName=foam.foam-vscode), Logseq, and the rest is a happy side effect of non-destructive tolerance.
2. Natively support the Markdown that people and tools actually write. [CommonMark](https://commonmark.org/help/) is a great starting point, but there are _at least_ three different widely-adopted formats for callouts, none of which are in the essential set. Breadth is a virtue.
3. Ergonomic and capable in every sense. Must be fast (to open and use), keyboard-first, feature rich, and get out of your way so you can _just write_.
4. Fully integrate with VS Code. Embrace infinite customizability and inherit existing preferences, while establishing calm, opinionated defaults.
5. As Teller put it, _"Sometimes magic is just someone spending more time on something than anyone else might reasonably expect."_ It's especially powerful when unexpected.

### Ancient history

My first attempt at a visual Markdown editor was in 2011, with Eric Danielson.

It was a web-based local Markdown editor that synced through the Dropbox API, embarrassingly called [Marlan](https://github.com/harlanlewis/Marlan). The world is so different now, and there's so much more foundation to stand on.

It's so _fun_ to think about this same problem from a new vantage of experience and purpose, crafting at speed the same tools I use to sharpen thought.

---

## Fidelity and safety come first

A WYSIWYG Markdown editor lives or dies on one question: when you open a file and save it, is the file still _yours_? Most editors of this kind reformat on save. They re-wrap tables, swap `*` for `_`, normalize list markers, and drop syntax they don't understand. One such surprise sends a writer back to the raw text editor for good.

Birta is built so that never happens. You can point it at a file from almost any Markdown tool, edit it like a document, and trust the save. Interop (see [Compatibility](#compatibility-with-other-markdown-tools) below) mostly falls out of building for fidelity. It isn't a separate feature to chase.

### It only rewrites the lines you changed

On save, Birta diffs its output against the file on disk and splices back just the real content changes. Every untouched line stays byte-for-byte identical, so your formatting choices survive, your git diffs stay small and readable, and editing one paragraph never reflows the rest of the document.

That holds however many lines you touched between saves. A save carries every edit since the last one, so the pipeline has to line each changed line up with the one it came from. Getting that correspondence wrong is how an editor loses a cell from a table row you never opened, or writes half a list at one indent width and half at another.

Blank lines are part of that judgement. The ones that are your spacing are left alone. The ones that carry block structure are written when an edit adds or removes them, so an edit whose whole effect is on a block boundary still reaches the file, rather than looking right on screen and vanishing on reopen. Two kinds carry structure: the blank that makes two paragraphs two instead of one wrapped one, and the blank directly after a list marker. The second is not spacing at all. An item that begins with one gives up everything below it to the document, so keeping it there would cost the item its own content.

### Cosmetic style is reproduced, not just protected

Markdown offers the same construct several spellings, and a serializer normally picks one: `*` or `_` for emphasis, `***`/`___`/`---` for a divider, ATX or underlined headings, `-`/`*`/`+` bullets, `.` or `)` after an ordered item's number, and whether a numbered list counts up or repeats `1.`. Birta reads which one your file used and writes that one back. The same holds for the file's line endings: a document written with Windows CRLF endings stays CRLF, down to the lines an edit passes through.

This is the difference between a choice _surviving_ and a choice being _restored_. Protection (below) works per region, so editing one item in a list would otherwise re-canonicalize every other item in it. Reproducing the style means an edit changes only what you edited, however much of the document the construct spans.

### Syntax it can't perfectly reproduce is protected, not rewritten

When Birta opens a file, it records every region it couldn't round-trip on its own: an unusual reference-link layout, a closed `## heading ##`, hand-escaped text. Those regions are restored to their original bytes on save, and lines the round trip would _add_ (like a closing fence for a deliberately unclosed one) are withheld the same way.

The editor can't silently "correct" Markdown you wrote deliberately, and an edit elsewhere in the document can never leak into syntax it doesn't fully model.

### Non-standard syntax is preserved verbatim

Wikilinks, `==highlights==`, callouts, and `:::` directives are stored as their exact source bytes and written back unchanged. The conventions from tools like Obsidian round-trip exactly, even the parts Birta renders as plain interactive elements.

### YAML frontmatter is handled out of band

The frontmatter block is lifted off the top of the file before the editor ever sees it, then reattached on save. Your metadata is immune to any editor reformatting: key order, comments, and spacing are exactly as you left them.

### Anything unrecognized stays visible, never deleted

Syntax Birta doesn't model (inline tags, block references, raw HTML, an unknown construct) remains as legible text or an inert, preserved block, never a silent drop. You can always see what the editor didn't interpret, so you're never trusting it with content it quietly discarded.

### Block gestures that would lose content are blocked

A move, duplicate, table reorder, or drag that would alter or drop document content is refused outright, with a brief notice, instead of applied. The convenience of block editing never comes at the cost of the document's integrity.

### A save always captures your latest edit

The moment you type, the editor marks the document unsaved, within a few milliseconds, faster than you can reach Save. A save then waits for the editor to hand back its freshest content before writing to disk.

The old trap where a quick Cmd+S seemed to "not take" and the change quietly vanished on close is gone. Your edits are never left stranded in the editor, unwritten.

### You're told when a file changes underneath you

The conflict is never resolved silently. If another tool (a terminal, git, an AI assistant) rewrites a file you have open _with unsaved edits_, a warning badge appears, and one click reloads from disk or shows a side-by-side compare. A file with no unsaved edits just reloads on its own.

Editing alongside tools that also write your files is normal now. Birta surfaces the collision and lets _you_ pick the winner, instead of guessing a merge or quietly discarding a side. The editor never writes or reverts your document on its own, and it never takes over a raw editor holding unsaved changes: rendering one means closing it, and closing an unsaved file is what makes VS Code ask whether to save, so Birta leaves that tab alone until you've saved it yourself.

## It understands the Markdown people actually write

CommonMark is the floor. On top of it Birta renders, live as you type, the extensions that show up in real documents:

- GitHub Flavored Markdown: tables, task lists, strikethrough, autolinks, and footnotes.
- Math (`$...$` and `$$...$$`, rendered with KaTeX) and Mermaid diagrams.
- Wikilinks (`[[target]]`, `[[target|alias]]`, `[[target#heading]]`) that render, navigate, and autocomplete.
- Highlights (`==text==`) and callouts or admonitions, in both the GitHub (`> [!NOTE]`) and Obsidian (`> [!tip]- Title`) spellings, plus `:::` container directives.
- Reference-style links, raw HTML (rendered read-only, preserved), and image handling with local, deduplicated storage.

You rarely hit a wall where the editor can't show what you wrote, and where it can't, the previous section guarantees it's preserved rather than mangled.

## It's a real editor, not a preview pane

The point of staying in WYSIWYG is that you never _need_ the raw text editor. That only holds if the editor does the things you expect from VS Code.

### Block handles that never touch content

Every block has a gutter handle: click it for the block menu (turn into, duplicate, move, delete), drag it to move the block. A handle click selects or opens a menu, and never edits the block, including task-list checkboxes. The handle is a safe, predictable grip you can reach for without worrying it'll change what you're pointing at.

### Keyboard-first block editing

Select, move, duplicate, and fold blocks entirely from the keyboard, with a slash menu for inserts and find/replace with match-case, whole-word, and regex. The fast paths you already have muscle memory for in VS Code work here too.

### The clipboard speaks Markdown in both directions

Copying puts the selection's Markdown source on the clipboard's plain-text flavor, and pasting plain text reads it back as Markdown: `# Title` arrives as a heading, not as the literal characters the serializer then has to escape. Rich content pasted from a browser or a word processor keeps its own formatting as before, a paste inside a code block is always literal, and Paste as Plain Text (⇧⌘V, or the command palette) is literal for one paste (`birta.pasteFormat` makes it the rule).

Pasting rich content from a browser or word processor converts to Markdown, including the parts most editors drop: `<s>` strikethrough, task-list checkboxes, and an image's alt without a title invented from it. A paste into a table cell keeps the table's shape, because a GFM cell holds only inline content.

Markdown's whole appeal is that it survives the trip through any plain-text channel: a terminal, a chat box, an agent's reply. An editor that writes Markdown to the clipboard but can't read it back breaks that trip at its own front door.

### Folding and go-to-heading

Both are for navigating long documents, and neither touches the file. You get structure you can move through without scrolling, and without it leaking into what's saved.

### The switch to raw Markdown carries your cursor, and your selection

Cmd+Shift+M opens the other editor at the line you were working at, and at the exact column where the mapping is unambiguous. It works in both directions, so you can switch mid-sentence and keep typing. A selection survives the trip whole, drag direction included, with block selections arriving as whole source lines, and the arriving cursor is centered on screen. Scrolled away from a bare cursor, it takes you to what's on screen instead. Navigation _into_ the editor arrives the same way: click a hit in VS Code's search and the match is selected and centered, as it would be in the raw editor.

The raw editor is the escape hatch, and an escape hatch that dumps you at the top of a long file is one you hesitate to use. Nothing about the document changes on the way through. The switch moves you, not your text.

### Optional line numbers, spaced to the rendered document

`birta.lineNumbers` (off by default) draws a quiet column along the start edge of the window. Because a source line has no fixed height once rendered, the spacing is irregular by design: each number sits beside the content it labels, a paragraph that wraps to six rows gets one number and the room it takes, and a line that renders nothing sits in the gap where it belongs. A code block's interior is left to that block's own numbers, and a line the editor can't place honestly gets none rather than a wrong one.

Everything else that reads your file speaks in line numbers: a diff, a build error, a review comment, an agent. Answering "which line is this?" used to mean switching editors and losing your place. The numbers are display only, and they cost nothing when off.

### A table of contents you can also edit through

It reads as an outline of the document, and dragging within it restructures: drop a section onto a heading to nest it beneath, or between headings to place it as a sibling. The section's rank follows where you dropped it, its subtree moves and shifts with it, and the whole reorder is one undo step.

Reorganizing a long document is the one edit that's genuinely painful in raw Markdown: cutting a section, finding its end, pasting it, then renumbering every `#` underneath by hand. The outline is where that shape is actually visible, so it's where the edit belongs. Dragging a heading's handle in the _document_ stays a literal move. The text is text, the outline is the structure.

## It stays out of the way

- It matches your VS Code theme, with no per-editor color settings, recoloring live when you switch themes or the OS flips light and dark. The document looks like the rest of your editor, always, with nothing to configure.
- It starts fast. Heavy dependencies (math, diagrams, syntax grammars) load only when a document needs them, so opening a file paints quickly and switching in and out of the editor never feels like a penalty.
- Saving is just VS Code saving. The editor is backed by a native text document, so `files.autoSave`, the dirty-dot in the tab, and hot-exit all work exactly as they do everywhere else. There is no bespoke save model to learn or distrust.
- Your images never leave your machine. Pasted and dropped images are stored locally in your workspace, deduplicated by content hash. No surprise uploads, and the document is self-contained.

## Offline by default

Nothing leaves your machine unless you turn it on. Every feature that could touch the network sits behind a single master switch, `birta.network.enabled`, which ships off. With it off the editor makes no outbound request at all. One embed still renders offline: the GitHub info card, which is built purely from the URL text in your document and requests nothing.

The private default is the default, not a setting you have to remember to find. Turn the switch on and exactly two features become live. Each is narrow, legible, opt-in, and self-limited, and each carries its own switch: `birta.pasteUnfurl.enabled` and `birta.embeds.enabled`.

### Paste-unfurl

Paste-unfurl contacts only the host of a bare URL you paste (with nothing selected), to read that page's title. No third-party service, no analytics. It refuses local and private-network addresses, and re-checks every redirect. When the page is offline or untitled, it falls back to the plain link.

### URL embed cards

A card contacts only the named provider of a bare link on its own line: a YouTube thumbnail at render, and a title lookup at that provider's own oEmbed endpoint, so the card can name what it embeds. The player is created only when you click, whether that's YouTube in privacy mode (`youtube-nocookie.com`), a Loom or Vimeo video (Vimeo's always loads with its `dnt=1` do-not-track flag), or a live Figma frame. Each provider's exact hosts are pinned in one shared table that also generates the webview's content-security-policy. Never a wildcard, never an aggregation service.

### You're asked in place, and the choice is yours alone

You don't have to hunt for the setting first. Whichever of the two you just triggered offers a quiet, dismissable prompt right where you're working, and you decide there. Flipping the switch takes effect immediately in every open editor, with nothing to reload.

The decision is _yours alone_. The network settings are user-level only (VS Code `application` scope), so a repository's checked-in `.vscode/settings.json` can never switch them on for you. A test pins that, and fails the build if a consent setting ever loses that scope.

### Only one of the two touches your file

"Will this change my file?" is the only question that matters when you are deciding whether to trust a feature, and here it has a stable answer per feature rather than depending on timing.

Paste-unfurl _writes_, so it asks first. It puts a fetched title into your document, and the title arrives as an offer at the link: nothing changes until you accept it. `birta.pasteUnfurl.autoApply` turns that into an automatic apply once you trust it.

URL embeds _never_ write. A card, its fetched title included, is a rendering of the plain link that is already in the file, so turning embeds off simply shows the link again and no byte ever moved. Editing the URL through the card's palette is your explicit edit, applied on Enter like any other.

Because a card and a fetched title are mutually exclusive ways to present the same link, each URL has exactly one owner: a link that can render as a card is never retitled.

---

## Compatibility with other Markdown tools

We're not building a personal-knowledge-management tool. But because Birta reads and writes plain Markdown files and preserves what it doesn't interpret, it works well _on the files_ of many tools people already use. Interop is a nice consequence of fidelity, not a design goal, so this table is about what's safe to open and edit, not about matching every tool's feature set.

| Tool                      | Stores plain files?                    | Birta can open it                       | Syntax fidelity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                                   |
| ------------------------- | -------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Obsidian**              | ✅ vault of `.md`                      | ✅ directly                             | Wikilinks, `==highlights==`, `> [!callouts]`, footnotes, math, and YAML frontmatter render or round-trip; `#tags`, `^block-ids`, `![[embeds]]`, `%%comments%%` stay as preserved text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 🟢 Strong                                 |
| **Foam**                  | ✅ `.md` (VS Code-native)              | ✅ directly                             | Same wikilink family as Obsidian; its optional CommonMark link-reference-definition shim is preserved, not inlined away                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 🟢 Strong                                 |
| **"Second Brain" / PARA** | ✅ (a folder convention, not a format) | ✅ directly                             | Nothing tool-specific to preserve: it's just folders of Markdown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 🟢 Strong                                 |
| **Logseq**                | ✅ `.md`                               | ✅ opens (round-trip tested)            | Logseq is an outliner: every block is a bullet and tab indentation encodes the block tree, so a file renders as one big nested list. Untouched lines (tabs, `key:: value` properties, `((block-refs))`, `TODO`/`DOING`/`[#A]` markers, `CLOCK:` timestamps) are byte-preserved through an edit elsewhere, and an edited line keeps its org tokens unescaped and its own tab indentation, so the blocks nested under it stay nested (pinned by a round-trip test suite that types into every block of each fixture and re-parses the result). Block _moves_ within a tab-indented outline now keep the file's own indentation too, so a dragged or Alt+moved block lands at the depth you left it at, including a block whose content is a heading or a quote rather than plain prose, the outliner's own `- # Title` shape among them. The whole-file move gate runs against the Logseq fixtures with no carve-out. A bullet whose content is a **table** now moves correctly too: its rows re-base to the depth it lands at instead of keeping the indent of the nesting they left, which used to bring the table back as literal pipe text. An outline that spells one level two ways (a tab in one place, spaces in another, which is the ordinary state of a file more than one tool has edited) now moves correctly as well: the moved bullet is re-spelled into the convention its neighbours use instead of reopening one level deeper. A bullet whose content is a horizontal rule now keeps its nesting as well. It used to save as a bare marker on its own line, which Markdown reads as part of the text above it rather than as an item (a lone `-` is a heading underline; a lone `*` or `+` is a continuation of the previous line), so the sublist vanished on reopen, and Tab-indenting such an item hit the same collision. One shape is still open and worth knowing if you hit it: a moved item whose marker differs from its saved counterpart _only_ in indentation still comes back in the editor's spelling rather than the file's (its content survives intact) | 🟡 Text-edit safe; structure renders flat |
| **Quarto** (`.qmd`)       | ✅ single `.qmd` file                  | ⚠️ needs a file association (see below) | Pandoc Markdown doesn't subtract from CommonMark, so untouched content round-trips safely; but executable ` ```{r} ` cells, `::: {.callout}` fenced divs, shortcodes, cross-refs, and citations are preserved as inert text/code, not understood                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 🟡 Safe, not fluent                       |
| **MDX** (`.mdx`)          | ✅ `.mdx` file                         | ⚠️ not recommended                      | MDX _changes_ CommonMark rules (`<` and `{` become special, indented code and HTML comments behave differently) and adds JSX/`import`/`export`; re-serializing edited regions risks producing invalid MDX                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 🔴 Risky                                  |
| **Roam Research**         | ❌ proprietary DB (JSON/EDN)           | ❌ only after Markdown export           | Moot until exported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 🔴 Not file-based                         |
| **Bear**                  | ❌ proprietary SQLite                  | ❌ only after export                    | Moot until exported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 🔴 Not file-based                         |
| **Emacs Org mode**        | ✅ `.org`, but not Markdown            | ❌ don't; it's a different language     | `* headlines`, `:PROPERTIES:` drawers, `#+BEGIN_` blocks aren't Markdown; a Markdown parser would misread them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 🔴 Wrong format                           |

How to read this:

- Plain-Markdown tools (Obsidian, Foam, PARA setups) open directly. Birta renders the common extensions and preserves the tool-specific bits it doesn't render, so a round-trip is safe even where it isn't fully interactive.

- Logseq also opens, but it's an outliner: its whole-file structure, not just its text, rides on exact bullet indentation. Text edits are round-trip tested. Untouched lines keep their tab bytes and org tokens exactly, and the edited line keeps both its tokens unescaped and its own tab indentation, so its nested children stay children. Moving blocks, by drag or by keyboard, keeps the outline's own indentation as well, so a moved block re-opens at the depth you left it at, carrying its continuation lines and any nested code fence intact. That now includes a block whose content is not a plain paragraph: a heading (the Logseq shape `- # Project Atlas`), a quote, a fence. Such a block used to be re-written as an empty bullet with the content indented beneath it, a form that reopens as something else entirely. Typing inside one hit the same shape, so it is fixed for edits as well as moves, and it now covers a bullet whose content is a _table_ too. Separately from moving: a bullet whose content is a _horizontal rule_ used to lose its sublist when the file was saved and reopened, and no longer does. The compatibility row above has the detail.

- Markdown supersets (Quarto, MDX) are plain files, but they extend or alter the language. Birta registers only `.md` and `.markdown`, so a `.qmd` or `.mdx` file won't open in Birta on its own. The reliable way is to rename it to `.md`, or point the extension at Birta with a `workbench.editorAssociations` entry (e.g. `"*.qmd": "birta.editor"`). Quarto is then safe to round-trip, its extensions surviving as inert text. MDX is not recommended, because it redefines base Markdown behavior that a CommonMark editor can't re-serialize faithfully.

- Proprietary-format tools (Roam, Bear) don't keep plain Markdown files at all. There's nothing on disk for a file-based editor to open until you export.

- Org mode is a different markup language, not a Markdown dialect. Opening an `.org` file as Markdown would misparse it, so it's out of scope by design.

> **A note on confidence:** the claims above are machine-verified. One command, `pnpm fidelity`, drives a per-tool fixture corpus (authored from each tool's own documentation) through the production save pipeline and asserts the table's claims. The 🟢 and 🟡 rows round-trip byte-identically and keep every tool-specific construct named above through an edit; frontmatter, handled before the editor ever sees content, is verified by the extension-side suites. The 🔴 rows for MDX and Org are encoded as expected-corruption cases: an untouched save is still byte-identical even for those, but an edit corrupts the edited construct. For Org that is the edited headline itself, which Birta reads as a bullet, while its property drawer and the rest of the file, keyword lines included, are left alone. The fixtures and how to read the suites live in `webview/__tests__/fixtures/tools/README.md`; CI runs the same assertions on every PR and push to main, so a claim that stops being true fails the build.

---

## Crosslinks

- [`README.md`](../README.md)
- [`FEATURES.md`](FEATURES.md)
- [`WHY_THIS_FORK.md`](WHY_THIS_FORK.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md)
- [`NETWORK_POSTURE.md`](NETWORK_POSTURE.md)
- [`RELEASING.md`](RELEASING.md)
- [`CHANGELOG.md`](../CHANGELOG.md)
