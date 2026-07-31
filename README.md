Birta Writer is a visual editor for Markdown documents.

It strives to be your favorite place to write:

1. Birta Writer is fast and responsive, with modern ergonomics like `/` slash menus, draggable blocks, and straightforward tables.
2. Offline by default, no tracking of any kind. Your private data stays private.
3. It won't unexpectedly reformat your file, backed by a minimal-diff engine.
4. Embraces the many flavors of Markdown that people (and tools) actually write. Natively supports Obsidian wikilinks and highlights, frontmatter, GitHub callouts, and exports from Confluence and Notion.

It fully integrates with everything you'd expect of a VS Code extension, from a vast theme library to your own AI assistant in the sidebar. Pairs well with the [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), so you can use your Claude subscription instead of API keys.

While Birta Writer's core experience is calm and minimal by default, it has many powerful features when you need them:

- Opt-in interactive Figma embeds, playable Loom and Youtube videos, and rich link previews.
- Renders Mermaid diagrams, LaTeX, images, inline HTML, and more.
- Autocompletes inline and advanced math:
    - 3+7= `10`
    - 3+log(2²+3²\*2.3303)/π^2=> `3.141593`
- Offline proofreading through the [Harper Grammar Library](https://writewithharper.com/docs/rules), extended to highlight common _"AI tells"_. Just because people research and outline with LLMs doesn't mean we have to write like one.
- Editor and revision tools, such as `[TK]`, `TODO`, HTML comments, and user-defined annotation highlighting.
- A large number of display options to customize your space, including page width, size, fonts, line numbers, and a live/editable table of contents. These are all safe to ignore, the defaults are intentional and sophisticated.
- Deeply customizable through VS Code settings.

Birta Writer in VS Code is a drop-in replacement for any PKM vault (Personal Knowledge Management). It traverses local file links and supports file metadata of all kinds.

[As Teller put it](https://www.esquire.com/entertainment/interviews/a15810/teller-magician-interview-1012/): _"Sometimes magic is just someone spending more time on something than anyone else might reasonably expect."_

---

## Getting started

> _**birta**_ (Icelandic)
>
> To publish and make public, to reveal, to make manifest, to brighten.

Install the extension and open any `.md` or `.markdown` file. The first time, you may need to switch from VS Code's editor to Birta Writer manually. After that, Markdown files open automatically. (You can change this behavior in VS Code Settings).

### Basic controls

| Keys                    | Action                                       |
| ----------------------- | -------------------------------------------- |
| `/` at line start       | Slash menu, insert anything                  |
| `Cmd+.`                 | Menu for the current block                   |
| `Esc`, then `Shift+↑/↓` | Select blocks; `Alt+↑/↓` moves them          |
| `Cmd+F`, `Cmd+Alt+F`    | Find, Find & Replace                         |
| `Cmd+Shift+O`           | Go to heading                                |
| `Cmd+Shift+M`           | Toggle Birta Writer ⇄ native editor Markdown |
| _… and many more_       |                                              |

Everything is rebindable in VS Code's Keyboard Shortcuts. See [Features and settings](docs/FEATURES.md) for complete feature reference, settings list, and keyboard shortcuts.

Requires VS Code 1.95 or later.

---

## Support

Run **Birta Writer: Send Feedback** from the VS Code Command Palette to open a GitHub issue in your browser.

You may also [file an issue directly](https://github.com/harlanlewis/birta-writer/issues).

---

## License & attribution

Birta Writer is by [Harlan Lewis](https://www.harlanlewis.com) at [Birta Labs](https://www.birtalabs.com).

Birta Writer is source-available under the Functional Source License (FSL-1.1-ALv2). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Every release is signed. The same `.vsix` goes to the Marketplace and to the [GitHub release](https://github.com/harlanlewis/birta-writer/releases), so you can confirm it was built by this repository, from this source:

```bash
gh release download --repo harlanlewis/birta-writer --pattern '*.vsix'
gh attestation verify birta-writer-*.vsix --repo harlanlewis/birta-writer
```
