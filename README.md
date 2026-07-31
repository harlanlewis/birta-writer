# Birta Writer

**A visual editor for Markdown, inside VS Code.** Rich text while you write — headings, tables, images, math, diagrams — and standard Markdown on disk, readable by any tool.

Built on one promise: **editing one part of a file never rewrites another.** Untouched lines keep their exact bytes. Syntax the editor doesn't understand stays visible and intact rather than being silently "corrected" away.

***

## Why you'd want it

**Your file stays yours.** Most WYSIWYG Markdown editors reformat on save — re-wrapping tables, swapping `*` for `_`, dropping syntax they don't recognize. One such surprise sends a writer back to raw text for good. Birta serializes your document and merges only the lines that actually changed, so the formatting you chose survives edits elsewhere in the file.

**Private by default.** Out of the box the extension makes no outbound request at all. Images save into your workspace and are never uploaded, proofreading runs on your machine, and the two features that *can* reach the network sit behind a master switch that ships off. There is no usage tracking to opt out of, because none exists.

**Fast to open, fast to use.** Launch time is treated as a feature and guarded by CI on every change. Heavy things — diagram and math renderers, syntax grammars — load only when a document actually needs them.

**A real editor, not a preview pane.** Slash menu, a grab handle on every block with drag-to-move and a block menu, marquee and keyboard block selection, folding, find and replace with regex, occurrence editing, Go to Symbol, and a table of contents that reorders your document when you drag it.

**The Markdown people actually write.** Not just CommonMark: GitHub callouts, Obsidian wikilinks and highlights, footnotes, YAML frontmatter, KaTeX math, Mermaid diagrams, and full GFM tables with drag-to-reorder rows and columns. Files from Obsidian, Foam, GitHub, and Notion exports open directly.

**It helps you write better.** Offline spelling, grammar, and style checking — including AI-writing tells in vocabulary, punctuation, and sentence construction — with every rule individually toggleable. An inline calculator evaluates arithmetic, variables, and unit conversions in place.

**It's VS Code.** Your theme, your keybindings, your extensions, your diff view, your AI assistant in the sidebar — and a one-keystroke, lossless switch to the raw text editor whenever you'd rather see the source.

***

## Principles

1. **Data fidelity first.** Preserve unexpected syntax rather than "correcting" it. Broad interoperability with other tools is a consequence of that tolerance, not a separate feature.
2. **Support the Markdown people and tools actually write.** CommonMark is a starting point. There are at least three widely-used callout syntaxes and none are in the essential set. Breadth is a virtue.
3. **Ergonomic in every sense.** Fast to open and use, keyboard-first, feature-rich, and out of your way so you can just write.
4. **Fully integrate with VS Code.** Inherit its customizability and existing preferences, while setting calm, opinionated defaults.
5. **Magic is time spent where no one expects it.** As Teller put it: *"Sometimes magic is just someone spending more time on something than anyone else might reasonably expect."*

***

## Getting started

Install the extension and open any `.md` or `.markdown` file — it opens in WYSIWYG mode automatically.

| Keys | Action |
| --- | --- |
| `/` at a block start | Slash menu — insert anything |
| `Cmd+.` | Block menu for the current block |
| `Esc`, then `Shift+↑/↓` | Select blocks; `Alt+↑/↓` moves them |
| `Cmd+F` · `Cmd+Alt+F` | Find · Replace |
| `Cmd+Shift+O` | Go to heading |
| `Cmd+Shift+M` | Toggle WYSIWYG ⇄ raw Markdown |

macOS shown; Ctrl on Windows/Linux, and everything is rebindable in VS Code's Keyboard Shortcuts. The full list is in the toolbar's ⌄ menu under *Show Keyboard Shortcuts*.

Requires VS Code 1.95 or later.

***

## Learn more

- [**Features and settings**](docs/FEATURES.md) — the complete feature reference, every `birta.*` setting, keyboard shortcuts, and known limitations
- [**Why it matters**](docs/BENEFITS.md) — the fidelity and safety guarantees in depth, and per-tool compatibility
- [**Why this fork**](docs/WHY_THIS_FORK.md) — the founding rationale and how investment is ordered
- [**Architecture**](docs/ARCHITECTURE.md) — how the editor is built, and the receipts behind the fidelity claims
- [**Changelog**](CHANGELOG.md) · [**Network posture**](docs/NETWORK_POSTURE.md)

***

## License & attribution

Birta Writer is maintained by [Harlan Lewis](https://www.harlanlewis.com). It began as a personal fork of an MIT-licensed project, is now developed independently, and is not affiliated with or endorsed by it.

Source-available under the [Functional Source License (FSL-1.1-ALv2)](LICENSE); the portions derived from that project remain under the MIT License they were published under, and it is named there — see [NOTICE](NOTICE) and [LICENSE-MIT](LICENSE-MIT).

**In plain English:** you can read, run, modify, and share the source for any purpose — including internal and paid work at your company — *except* using it to build a product or service that competes with Birta Writer. Each release converts to the permissive [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) license two years after it ships, so the code is never permanently locked up. This is not OSI-approved "open source," but the source is fully open to inspection and self-hosting. (The [LICENSE](LICENSE) text governs; this summary doesn't.)
