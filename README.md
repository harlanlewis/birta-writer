Birta Writer is a visual editor for Markdown documents.

It strives to be your favorite place to write.

> _**birta**_ (Icelandic)
>
> To publish and make public, to reveal, to make manifest, to brighten.

1. Birta Writer is fast and responsive, with modern ergonomics like `/` slash menus and draggable blocks.
2. Embraces the many flavors of Markdown that people (and tools) actually write. Natively supports Obsidian wikilinks and highlights, frontmatter, Github callouts, and the Confluence Frankenstein. Tables are easy to edit. It even handles Logseq.
3. Fully integrates with and supports everything you'd expect of a VS Code extension, including a huge theme library and your own AI assistant in the sidebar.
4. Pairs well with your own AI assistant, such as the [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) (so you can use your Claude subscription instead of API keys).
5. Offline by default, no tracking of any kind. Your private data stays private.

While Birta Writer's core experience is calm and minimal by default, it has many powerful features when you need them:

- Opt-in interactive Figma embeds, playable Loom and Youtube videos, and rich link previews.
- Renders Mermaid diagrams, LaTeX, images, inline HTML, and more.
- Autocompletes inline and advanced math:
    - 3+7= 10
    - 3+log(2²+3²\*2.3303)/π^2=> 3.141593
- Offline proofreading through the [Harper Grammar Library](https://writewithharper.com/docs/rules), extended to highlight common _"AI tells"_. Just because people research and outline with LLMs doesn't mean we have to write like one.
- Editor and revision tools, like lists of `[TK]` and `TODO` annotations and inventories of all links in a document.
- A large number of display options to customize your space, including page width, size, fonts, line numbers, and a live/editable table of contents. These are all safe to ignore, the defaults are intentional and sophisticated.

Everything above is deeply customizable through VS Code settings and is downstream of existing keyboard shortcuts where applicable.

Birta Writer in VS Code is a drop-in replacement for any PKM vault (Personal Knowledge Management). It traverses local file links and supports file metadata of all kinds. It will never inadvertently lose data by trying to "correct" or reformat Markdown.

Data fidelity is the foundation for supporting Markdown-like content written by any tool.

Birta Writer is source-available under the Functional Source License (FSL-1.1-ALv2). Every release is signed, so you can check the extension matches the source repository. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

[As Teller put it](https://www.esquire.com/entertainment/interviews/a15810/teller-magician-interview-1012/): _"Sometimes magic is just someone spending more time on something than anyone else might reasonably expect."_

---

## Getting started

Install the extension and open any `.md` or `.markdown` file. The first time, you may need to open it in Birta Writer manually. After that, Markdown files open automatically. (You can change this behavior in VS Code Settings).

### Basic controls

| Keys                    | Action                                       |
| ----------------------- | -------------------------------------------- |
| `/` at line start       | Slash menu, insert anything                  |
| `Cmd+.`                 | Menu for the current block                   |
| `Esc`, then `Shift+↑/↓` | Select blocks; `Alt+↑/↓` moves them          |
| `Cmd+F`, `Cmd+Alt+F`    | Find, Find & Replace                         |
| `Cmd+Shift+O`           | Go to heading                                |
| `Cmd+Shift+M`           | Toggle Birta Writer ⇄ native editor Markdown |

Everything is rebindable in VS Code's Keyboard Shortcuts. See [Features and settings](docs/FEATURES.md) for complete feature reference, settings list, and keyboard shortcuts.

Requires VS Code 1.95 or later.

### Development history

[Changelog](CHANGELOG.md)

---

## License & attribution

Birta Writer is maintained by [Harlan Lewis](https://www.harlanlewis.com). It began as a personal fork of an MIT-licensed project, is now developed independently, and is not affiliated with or endorsed by it.

Source-available under the [Functional Source License (FSL-1.1-ALv2)](LICENSE); the portions derived from that project remain under the MIT License they were published under, and it is named there — see [NOTICE](NOTICE) and [LICENSE-MIT](LICENSE-MIT).
