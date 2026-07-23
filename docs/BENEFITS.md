# Birta Writer

Birta Writer is a live visual editor for editing richly formatted and structured Markdown documents. It strives to be your favorite way to write and edit, regardless of format.

## Why I use it

- Fast and responsive, with familiar and powerful controls including drag and drop, slash commands, and keyboard shortcuts.

- Instant updates reflect changes made outside of your edits, including AI agent edits or cloud sync.

- Safely open and edit any Markdown-like content with no risk of data loss or unexpected modification due to parser mishandling unfamiliar syntax. Document fidelity is a first-class concern.
- It sits within [VS Code](https://code.visualstudio.com) and its *vast* (but optional!) ecosystem of themes and extensions. You're a keystroke away from editing files in the raw editor with multi-cursor support, or opening a diff view to compare conflicting changes. Birta Writer is simple by design, but nearly every aspect is customizable through VS Code's settings scopes at app, user, or project level.
- There's a little more magic than you might expect, like an inline calculator that autocompletes the answer to a math expression (`6^2+(8*3/4)= 42`), or evaluates one with `=>` using named variables you defined earlier in the document and offline unit conversions (`3 km in mi =>`, `rent / budget * 100 =>`) — and a fenced ` ```calc ` block that turns those into a live worksheet, computing every line under one shared scope. All computed locally, never over the network.

- It helps me write better:

  - Offline proofreading of spelling, grammar, prose, and common "AI tells" in sentence construction, punctuation, and vocabulary.
  - Customizable draft-management tools to help you find `[TK]` notes, `TODOs`, and inline comments.

- It's private.

  - By default, makes no network requests of any kind. Rich link previews are opt-in.
  - No usage tracking to opt out of, because it doesn't exist.

While superficially a single-document editor, Birta Writer has deceptively-deep system awareness and broad compatibility:

- Display and edit both basic Markdown and extended syntax used by [Obsidian](https://obsidian.md), [Confluence](https://confluence.atlassian.com/doc/confluence-wiki-markup-251003035.html), [Github](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax), [Notion exports](https://www.notion.com/help/export-your-content), and others.
- Crosslink local documents with Markdown links, [wikilinks](https://obsidian.md/help/links), or even [Logseq](https://www.markdownguide.org/tools/logseq/) with an inline file browser UI.
- Interactive [Mermaid](https://mermaid.js.org) diagrams, [LaTeX](https://en.wikipedia.org/wiki/LaTeX) rendering, images, and a full-featured visual table editor with drag-and-drop rows and columns.
- Optionally display rich link previews or embedded documents and videos.

It's not a wiki, knowledge base, or [PKM](https://en.wikipedia.org/wiki/Personal_knowledge_management) - but it sure can act like one:

- Open an existing Obsidian vault in VS Code and use the file explorer and command palette to view your full repository of knowledge.
- Markdown files open automatically in Birta Writer. Crosslink them. Click to navigate across pages. View files side by side in a window.
- Open Github Copilot, Claude Code, or other AI assistant in a VS Code sidebar to chat with and modify your documents live.

Use Birta Writer as a knowledge base complement when you want a more enjoyable and helpful writing tool, or lean on VS Code and fully replace your other systems.

## Why I made it

Almost everything I do on a computer in 2026 reduces to code and context.

I pipe meeting transcripts to research repositories to spreadsheets to confluence documents to tickets to coding agents to pull request descriptions to communication channels to slide decks and back again.

The emergent interface between humans and AI is text, and the dominant flavor is Markdown. 

Markdown is simple, semantic, portable, universal, and I ***really*** want to love my tools for reading and writing it.

I'm tired of:

- Pouring content into proprietary systems, only for my preferences to change or for the platforms to develop in ways that no longer serve me.
- Copy-pasting across apps, losing all formatting and semantics.

- Restricting my documents to a single tightly-coupled AI agent system or harness.

- Tools I can't trust to keep my private content private (having worked at both security and health care technology companies has strongly shaped my thinking here).

- Popping back and forth between apps depending on the format of my text document. It's just text.

- Choosing between:

  - Beautiful, modern, and thoughtfully designed apps that are extractive and centralized,
  - or functional, dated, somewhat incoherent tools that are portable and extensible.

### Design principles

1. Data fidelity first. Preserve, rather than "correct", unexpected syntax that the editor can't handle. Bonus: broad interoperability with Obsidian, [FOAM](https://marketplace.visualstudio.com/items?itemName=foam.foam-vscode), Logseq, and the rest are a happy side effect of non-destructive tolerance.

1) Understand and natively support the Markdown that people and tools actually write. CommonMark is a good starting point, but there are *at least* three different widely-adopted formats for callouts. Breadth is a virtue.

1. It's a real editor that feels capable and ergonomic in every sense. Must be fast (to open and use), keyboard-first, capability rich, and get out of your way. You can always choose to switch to the raw text editor, you should rarely *need* to.

1) Fully integrate with VS Code. Embrace its customizability and infinite ecosystem while establishing calm, opinionated defaults.
2) As Teller put it, *"Sometimes magic is just someone spending more time on something than anyone else might reasonably expect."* Magic is especially powerful when unexpected. 

### Ancient history

My first attempt at a visual Markdown editor was in 2011, with Eric Danielson.

It was a web-based local Markdown editor that synced through the Dropbox API, embarrassingly called [Marlan](https://github.com/harlanlewis/Marlan). The world is so different now, and there's so much more foundation to stand on.

It's incredibly fun to think about this same problem from a new vantage of experience and purpose, crafting at speed the same tools I use to sharpen thought.

---

---

---

## Crosslinks

- [`README.md`](../README.md)
- [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md)
- [POSITIONING.md](POSITIONING.md)
- [RELEASING.md](RELEASING.md)
- [../CHANGELOG.md](../CHANGELOG.md)

---

## Fidelity and safety come first

A WYSIWYG Markdown editor lives or dies on one question: when you open a file
and save it, is the file still *yours*? Most editors of this kind reformat on
save — re-wrapping tables, swapping `*` for `_`, normalizing list markers,
dropping syntax they don't understand. One such surprise sends a writer back to
the raw text editor for good. Birta is built so that never happens.

- **It only rewrites the lines you changed.** On save, Birta diffs its output
  against the file on disk and splices back just the real content changes; every
  untouched line stays byte-for-byte identical. **Why it matters:** your
  formatting choices survive, your git diffs stay small and readable, and
  editing one paragraph never reflows the rest of the document.

- **Syntax it can't perfectly reproduce is protected, not rewritten.** When
  Birta opens a file, it records every region it couldn't round-trip on its own
  (an unusual reference-link layout, a setext heading, hand-escaped text) and
  restores those regions to their original bytes on save — and lines the round
  trip would *add* (like a closing fence for a deliberately unclosed one) are
  withheld the same way. **Why it matters:** the editor can't silently
  "correct" Markdown you wrote deliberately — an edit elsewhere in the document
  can never leak into syntax it doesn't fully model.

- **Non-standard syntax is preserved verbatim.** Wikilinks, `==highlights==`,
  callouts, and `:::` directives are stored as their exact source bytes and
  written back unchanged. **Why it matters:** the conventions from tools like
  Obsidian round-trip exactly, even the parts Birta renders as plain interactive
  elements.

- **YAML frontmatter is handled out of band.** The frontmatter block is lifted
  off the top of the file before the editor ever sees it, then reattached on
  save. **Why it matters:** your metadata is immune to any editor reformatting —
  key order, comments, and spacing are exactly as you left them.

- **Anything unrecognized stays visible, never deleted.** Syntax Birta doesn't
  model (inline tags, block references, raw HTML, an unknown construct) remains
  as legible text or an inert, preserved block — never a silent drop. **Why it
  matters:** you can always see what the editor didn't interpret, so you're
  never trusting it with content it quietly discarded.

- **Block gestures that would lose content are blocked.** A move, duplicate,
  table reorder, or drag that would alter or drop document content is refused
  outright, with a brief notice, instead of applied. **Why it matters:** the
  convenience of block editing never comes at the cost of the document's
  integrity.

- **A save always captures your latest edit.** The moment you type, the editor
  marks the document unsaved — within a few milliseconds, faster than you can
  reach Save — and a save then waits for the editor to hand back its freshest
  content before writing to disk. **Why it matters:** the old trap where a quick
  Cmd+S seemed to "not take" and the change quietly vanished on close is gone;
  your edits are never left stranded in the editor, unwritten.

- **You're told when a file changes underneath you — it's never resolved
  silently.** If another tool (a terminal, git, an AI assistant) rewrites a file
  you have open *with unsaved edits*, a warning badge appears; one click reloads
  from disk or shows a side-by-side compare. A file with no unsaved edits just
  reloads on its own. **Why it matters:** editing alongside tools that also write
  your files is normal now — Birta surfaces the collision and lets *you* pick the
  winner instead of guessing a merge or quietly discarding a side. The editor
  never writes or reverts your document on its own.

Together these mean you can point Birta at a file from almost any Markdown tool,
edit it like a document, and trust the save. Interop (see
[Compatibility](#compatibility-with-other-markdown-tools) below) mostly falls
out of building for fidelity — it isn't a separate feature to chase.

## It understands the Markdown people actually write

CommonMark is the floor. On top of it Birta renders — live, as you type — the
extensions that show up in real documents:

- **GitHub Flavored Markdown**: tables, task lists, strikethrough, autolinks,
  and footnotes.
- **Math** (`$…$` / `$$…$$`, rendered with KaTeX) and **Mermaid diagrams**.
- **Wikilinks** (`[[target]]`, `[[target|alias]]`, `[[target#heading]]`) that
  render, navigate, and autocomplete.
- **Highlights** (`==text==`) and **callouts / admonitions** — both the GitHub
  (`> [!NOTE]`) and Obsidian (`> [!tip]- Title`) spellings, plus `:::` container
  directives.
- **Reference-style links**, **raw HTML** (rendered read-only, preserved), and
  **image handling** with local, deduplicated storage.

**Why it matters:** you rarely hit a wall where the editor can't show what you
wrote — and where it can't, the previous section guarantees it's preserved
rather than mangled.

## It's a real editor, not a preview pane

The point of staying in WYSIWYG is that you never *need* the raw text editor.
That only holds if the editor does the things you expect from VS Code:

- **Block handles that never touch content.** Every block has a gutter handle:
  click it for the block menu (turn into, duplicate, move, delete), drag it to
  move the block. A handle click selects or opens a menu — it never edits the
  block, including task-list checkboxes. **Why it matters:** the handle is a
  safe, predictable grip; you can reach for it without worrying it'll change
  what you're pointing at.
- **Keyboard-first block editing** — select, move, duplicate, and fold blocks
  entirely from the keyboard; a slash menu for inserts; find/replace with
  match-case, whole-word, and regex. **Why it matters:** the fast paths you
  already have muscle memory for in VS Code work here too.
- **Folding and go-to-heading** for navigating long documents — neither touches
  the file. **Why it matters:** structure you can move through without
  scrolling, and without it leaking into what's saved.
- **A table of contents you can also edit through.** It reads as an outline of
  the document, and dragging within it restructures: drop a section onto a
  heading to nest it beneath, or between headings to place it as a sibling. The
  section's rank follows where you dropped it, its subtree moves and shifts with
  it, and the whole reorder is one undo step. **Why it matters:** reorganizing a
  long document is the one edit that's genuinely painful in raw Markdown —
  cutting a section, finding its end, pasting it, then renumbering every `#`
  underneath by hand. The outline is where that shape is actually visible, so
  it's where the edit belongs. Dragging a heading's handle in the *document*
  stays a literal move: the text is text, the outline is the structure.

## It stays out of the way

- **It matches your VS Code theme** with no per-editor color settings, recoloring
  live when you switch themes or the OS flips light/dark. **Why it matters:** the
  document looks like the rest of your editor, always, with nothing to configure.
- **It starts fast.** Heavy dependencies (math, diagrams, syntax grammars) load
  only when a document needs them, so opening a file paints quickly. **Why it
  matters:** switching in and out of the editor never feels like a penalty.
- **Saving is just VS Code saving.** The editor is backed by a native text
  document, so `files.autoSave`, the dirty-dot in the tab, and hot-exit all work
  exactly as they do everywhere else. **Why it matters:** no bespoke save model
  to learn or distrust.
- **Your images never leave your machine.** Pasted and dropped images are stored
  locally in your workspace, deduplicated by content hash. **Why it matters:** no
  surprise uploads; the document is self-contained.
- **Offline by default — nothing leaves your machine unless you turn it on.**
  Every feature that could touch the network sits behind a single master switch,
  `birta.network.enabled`, which ships **off**. With it off the editor makes no
  outbound request at all. Turn it on and exactly two features become live, each
  narrow and legible: **paste-unfurl** contacts *only* the host of a bare URL you
  paste (with nothing selected) to read that page's title — no third-party
  service, no analytics, it refuses local and private-network addresses (and
  re-checks every redirect), and it falls back to the plain link when the page is
  offline or untitled; and **URL embeds** load *only* a YouTube thumbnail for a
  bare YouTube link on its own line, with the player (privacy-mode
  `youtube-nocookie.com`) created only if you click play. You don't have to hunt
  for the setting first: whichever of the two you just triggered offers a quiet,
  dismissable prompt right where you're working, and you decide in place.
  Flipping the switch takes effect immediately in every open editor — there is
  nothing to reload. **Why it matters:** the private default is the *default*,
  not a setting you have to remember to find; the two exceptions are opt-in,
  self-limited, and each still has its own switch (`birta.pasteUnfurl.enabled`,
  `birta.embeds.enabled`).

- **The two network features differ in the way that actually matters: whether
  they touch your file.** Paste-unfurl *writes* — it puts a fetched title into
  your document — so it asks first: the title arrives as an offer at the link and
  nothing changes until you accept it (`birta.pasteUnfurl.autoApply` turns that
  into an automatic apply once you trust it). URL embeds *never* write: a card is
  a rendering of the plain link that is already in the file, so turning embeds
  off simply shows the link again and no byte ever moved. Because a card and a
  fetched title are mutually exclusive ways to present the same link, each URL
  has exactly one owner — a link that can render as a card is never retitled.
  **Why it matters:** "will this change my file?" is the only question that
  matters when you are deciding whether to trust a feature, and here it has a
  stable answer per feature rather than depending on timing.

---

## Compatibility with other Markdown tools

We're not building a personal-knowledge-management tool. But because Birta reads
and writes plain Markdown files and preserves what it doesn't interpret, it works
well *on the files* of many tools people already use. Interop is a nice
consequence of fidelity, not a design goal — so this table is about what's safe
to open and edit, not about matching every tool's feature set.

| Tool | Stores plain files? | Birta can open it | Syntax fidelity | Verdict |
|---|---|---|---|---|
| **Obsidian** | ✅ vault of `.md` | ✅ directly | Wikilinks, `==highlights==`, `> [!callouts]`, footnotes, math, and YAML frontmatter render or round-trip; `#tags`, `^block-ids`, `![[embeds]]`, `%%comments%%` stay as preserved text | 🟢 Strong |
| **Foam** | ✅ `.md` (VS Code-native) | ✅ directly | Same wikilink family as Obsidian; its optional CommonMark link-reference-definition shim is preserved, not inlined away | 🟢 Strong |
| **"Second Brain" / PARA** | ✅ (a folder convention, not a format) | ✅ directly | Nothing tool-specific to preserve — it's just folders of Markdown | 🟢 Strong |
| **Logseq** | ✅ `.md` | ✅ opens (round-trip tested) | Logseq is an outliner: every block is a bullet and tab indentation encodes the block tree, so a file renders as one big nested list. Untouched lines — tabs, `key:: value` properties, `((block-refs))`, `TODO`/`DOING`/`[#A]` markers, `CLOCK:` timestamps — are byte-preserved through an edit elsewhere, and an edited line keeps its org tokens unescaped (pinned by a round-trip test suite). The edited line itself re-emits with space indentation at the same depth; block *moves* within a tab-indented outline are not yet held to the strict gate | 🟡 Text-edit safe; structure renders flat |
| **Quarto** (`.qmd`) | ✅ single `.qmd` file | ⚠️ needs a file association (see below) | Pandoc Markdown doesn't subtract from CommonMark, so untouched content round-trips safely; but executable ` ```{r} ` cells, `::: {.callout}` fenced divs, shortcodes, cross-refs, and citations are preserved as inert text/code, not understood | 🟡 Safe, not fluent |
| **MDX** (`.mdx`) | ✅ `.mdx` file | ⚠️ not recommended | MDX *changes* CommonMark rules (`<` and `{` become special, indented code and HTML comments behave differently) and adds JSX/`import`/`export`; re-serializing edited regions risks producing invalid MDX | 🔴 Risky |
| **Roam Research** | ❌ proprietary DB (JSON/EDN) | ❌ only after Markdown export | Moot until exported | 🔴 Not file-based |
| **Bear** | ❌ proprietary SQLite | ❌ only after export | Moot until exported | 🔴 Not file-based |
| **Emacs Org mode** | ✅ `.org` — but not Markdown | ❌ don't — it's a different language | `* headlines`, `:PROPERTIES:` drawers, `#+BEGIN_` blocks aren't Markdown; a Markdown parser would misread them | 🔴 Wrong format |

**How to read this:**

- **Plain-Markdown tools (Obsidian, Foam, PARA setups)** open directly. Birta
  renders the common extensions and preserves the tool-specific bits it doesn't
  render — so a round-trip is safe even where it isn't fully interactive.
  **Logseq** also opens, but it's an outliner: its whole-file structure (not just
  its text) rides on exact bullet indentation. Text edits are round-trip tested —
  untouched lines keep their tab bytes and org tokens exactly, and the edited
  line keeps its tokens unescaped (its own indentation re-emits as spaces at
  the same nesting depth). Dragging blocks around inside a deeply nested
  outline is the one gesture still treated cautiously.
- **Markdown supersets (Quarto, MDX)** are plain files but extend or alter the
  language. Birta registers only `.md` and `.markdown`, so a `.qmd`/`.mdx` file
  won't open in Birta on its own — the reliable way is to rename it to `.md`, or
  point the extension at Birta with a `workbench.editorAssociations` entry (e.g.
  `"*.qmd": "birta.editor"`). Quarto is then safe to round-trip (its extensions
  survive as inert text); **MDX is not recommended**, because it redefines base
  Markdown behavior that a CommonMark editor can't re-serialize faithfully.
- **Proprietary-format tools (Roam, Bear)** don't keep plain Markdown files at
  all — there's nothing on disk for a file-based editor to open until you export.
- **Org mode** is a different markup language, not a Markdown dialect. Opening an
  `.org` file as Markdown would misparse it; it's out of scope by design.

> **A note on confidence:** the claims above are machine-verified. One command —
> `pnpm fidelity` — drives a per-tool fixture corpus (authored from each tool's
> own documentation) through the production save pipeline and asserts the
> table's claims: the 🟢/🟡 rows round-trip byte-identically and keep every
> tool-specific construct named above through an edit (frontmatter, handled
> before the editor ever sees content, is verified by the extension-side
> suites), and the 🔴 rows for MDX
> and Org are encoded as expected-corruption cases — an untouched save is still
> byte-identical even for those, but an edit corrupts the edited construct (and
> for Org, its neighbors too). The fixtures and how to read the suites live in
> `webview/__tests__/fixtures/tools/README.md`; CI runs the same assertions on
> every PR and push to main, so a claim that stops being true fails the build.
