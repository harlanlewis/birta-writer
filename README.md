# WYSIWYG Markdown Editor

[GitHub](https://github.com/harlanlewis/md-wysiwyg-editor)

> A personal fork of [git-xing/md-wysiwyg-editor](https://github.com/git-xing/md-wysiwyg-editor) (MIT). Not affiliated with or endorsed by the upstream project.

WYSIWYG Markdown Editor is a VS Code WYSIWYG Markdown editor extension powered by [Milkdown](https://milkdown.dev/) (ProseMirror). Edit `.md` / `.markdown` files as rich text and save as standard Markdown — fully compatible with any text editor.

***

## Why this fork

**North star: never leave WYSIWYG.** A user opens a `.md` file in WYSIWYG mode and never *needs* the raw text editor unless they genuinely prefer it. Every change is judged by one question: *does this remove a reason to pop out?* The pop-out itself stays polished and instant — even the most mature competitors ship a one-keystroke escape hatch as a first-class feature. It's a safety net, not a wall.

Investment follows an ordering the evidence made unambiguous — from a survey of this codebase, upstream, competing VS Code WYSIWYG extensions (vscode-markdown-editor, vscode-office, unotes), Milkdown's own tracker, and capability-diffing against Typora, Obsidian Live Preview, and MarkText:

1. **Fidelity and trust first — it's existential.** The #1 trust-killer in every competitor's tracker is round-trip infidelity: "it reformatted my file", "it lost content". One competitor was un-published from the Marketplace over exactly this ([unotes](https://github.com/ryanmcalister/unotes)); upstream has a live corruption report ([git-xing#14](https://github.com/git-xing/md-wysiwyg-editor/issues/14)); MarkText's most-reacted bug is "document is modified just by opening it" ([marktext#2189](https://github.com/marktext/marktext/issues/2189)). One corruption event sends a user back to raw mode permanently. This fork's minimal-diff serializer, round-trip regression corpus, and destructive-diff save guard exist because of this.
2. **VS Code parity second.** The custom-editor API deliberately provides nothing — no find, no undo integration, no search reveal ("that's all intentionally left up to extensions", [microsoft/vscode#86802](https://github.com/microsoft/vscode/issues/86802)) — so parity users feel daily is hand-built here: find/replace, command palette and context-menu commands, Go-to-Symbol, user-rebindable keybindings, theme fidelity.
3. **Parser and syntax breadth third.** Math, footnotes, frontmatter, reference links — and anything the schema can't represent must degrade to *visible but safe*, never a silent deletion, so the editor is trustworthy on any file.
4. **Interaction patterns last.** Slash commands, smart paste, richer keyboard interaction — the polish that makes the editor *preferred* rather than merely tolerated, worth investing in only once the layers beneath it hold.

***

## Features

### Rich Text Editing

- **Headings** (H1–H6), **bold**, *italic*, ~~strikethrough~~, `inline code`, blockquote, horizontal rule
- **Ordered / Unordered / Task lists** (click checkbox to toggle completion)
- **Links**: hover to show a popup for editing link text and URL inline, with a **format switch** (standard markdown ⇄ `[[wikilink]]`) that converts a link in place; supports `@/` workspace paths, `#anchor` in-page jumps, `file.md#27` line-number links, and `file.md#some-heading` cross-file heading jumps
- **Smart link resolution** (`markdownWysiwyg.smartLinks`, on by default): local links resolve the way your site generator publishes them — workspace-root paths (`/docs/guide`), ancestor content roots (a Hugo file's `/write/uber` finds `content/write/uber/index.md`), `.md`/`index.md`/`_index.md` suffix inference, and a workspace-wide fallback. External links open through VS Code's own trusted-domains prompt — no extra dialog
- **Wikilinks**: `[[target]]`, `[[target|alias]]`, `[[target#heading]]` (Obsidian conventions) parse, render, navigate (bare names match by filename across the workspace), and round-trip byte-identically; typing `[[` opens name autocompletion. Anything the grammar doesn't match stays visible plain text
- **Path autocomplete**: type `@/`, `./`, or `../` inside inline code to get smart path suggestions — browse directories level by level with color-coded file-type icons

### Tables

- Full GFM table support
- Hover row/column borders to show **+ insert lines** — click to insert a row or column anywhere
- **Drag handles** on rows/columns: click to select, drag to reorder
- Insert lines and handles update in real time as the table grows

### Code Blocks

- Syntax highlighting for 20+ languages: Bash, C, C++, C#, CSS, Go, HTML, Java, JavaScript, JSON, Markdown, PHP, Python, Ruby, Rust, SQL, Swift, TypeScript, YAML
- Language picker with search filter
- One-click copy button
- Drag the bottom handle to resize the code block height
- Full-screen editor with syntax highlighting; writes back to document on close

### Mermaid Diagrams

- Flowcharts, sequence diagrams, Gantt charts, class diagrams, and more rendered inline
- Toggle between source code and rendered preview
- Zoom, pan (drag / trackpad pinch), and full-screen lightbox

### Images

- **Paste** an image from the clipboard, **drag-and-drop** a file, or use the **file picker** to insert images
- Local storage with MD5 deduplication — images are always saved to your workspace and are **never uploaded off your machine**
- Click an image to select it; click again to open a lightbox preview
- Toolbar for editing alt text, renaming the file, or deleting the image

### Theming

- The editor follows your active VS Code color theme automatically — everything (text, code, callouts, tables, Mermaid diagrams) recolors from the theme's own palette
- Theme changes apply live, with no reload — including switching workbench theme and OS-driven light/dark switching
- Nothing to configure: there is no separate per-editor theme, so the rendered document always matches the rest of your editor

### Table of Contents (TOC)

- Auto-generated from document headings
- Auto-opens when the window is wide enough; toggle manually via the side tab
- Click an entry to smooth-scroll to the heading

### Toolbars

- **Top toolbar**: heading level, bold, italic, strikethrough, ordered/unordered list, task list, blockquote, code block, table
- **Floating selection toolbar**: appears on text selection; supports quick formatting
- **Table toolbar**: appears on row/column selection; supports alignment and delete operations

### In-Editor Search

- **`Cmd+F`** (macOS) / **`Ctrl+F`** (Windows): opens the FindBar to search within the document
- Matches highlighted in real time using the CSS Custom Highlight API
- Navigate matches with `Enter` / `Shift+Enter`, dismiss with `Esc`

### Saving

- The editor is backed by a native text document, so saving follows VS Code's built-in **`files.autoSave`** (set it to `afterDelay` to write automatically after editing stops). Unsaved edits show `●` in the tab title, just like any editor
- Switching between the rendered editor and Raw Markdown with unsaved edits prompts to Save / Don't Save / Cancel (Cancel keeps you where you are); it never opens a duplicate tab
- External file changes (e.g. `git checkout`, other editors) sync automatically to the editor

***

## Getting Started

After installing the extension, open any `.md` / `.markdown` file in VS Code — it opens in WYSIWYG mode automatically.

| Action                   | How                                                            |
| ------------------------ | -------------------------------------------------------------- |
| Switch to text editor    | Click the 👁 icon in the title bar, or right-click → Open With |
| Switch back to WYSIWYG   | Click the 👁 icon in the title bar                             |
| Insert row/column        | Hover a table row/column border, click **+**                   |
| Reorder rows/columns     | Hover the **⠿** handle, then drag                              |
| Select entire row/column | Click the **⠿** handle                                         |
| Path autocomplete        | Type `@/`, `./`, or `../` inside inline code                   |
| Search in document       | `Cmd+F` (macOS) / `Ctrl+F` (Windows)                           |
| Manual save              | `Cmd+S` (macOS) / `Ctrl+S` (Windows)                           |

***

## Settings

| Setting                              | Type    | Default     | Description                                                                               |
| ------------------------------------ | ------- | ----------- | ----------------------------------------------------------------------------------------- |
| `markdownWysiwyg.defaultMode`        | string  | `"preview"` | Default mode when opening `.md`: `preview` (WYSIWYG) or `markdown` (text editor)          |
| `markdownWysiwyg.codeBlockMaxHeight` | number  | `600`       | Maximum code block height in pixels                                                       |
| `markdownWysiwyg.contentWidth`       | string  | `"full"`    | Content width: `full` (fill the pane) or `fixed` (cap at Max Content Width); also in the toolbar A menu |
| `markdownWysiwyg.maxContentWidth`    | number  | `100`       | Max content width in ch when Content Width is `fixed` (scales with the content font size)              |
| `markdownWysiwyg.fontPreset`         | string  | `"editor"`  | Content font: `editor` (follow the VS Code editor font), `sans`, `serif`, or `mono`; also switchable from the toolbar font picker |
| `markdownWysiwyg.fontFamilySans`     | string  | system sans stack | Font-family stack used by the Sans serif preset                                     |
| `markdownWysiwyg.fontFamilySerif`    | string  | serif stack | Font-family stack used by the Serif preset                                                |
| `markdownWysiwyg.fontFamilyMono`     | string  | mono stack  | Font-family stack used by the Monospace preset                                            |
| `markdownWysiwyg.fontSize`           | number  | `100`       | Content font size as a percentage of the VS Code editor font size (50–200)                |
| `markdownWysiwyg.imageLocalPath`     | string  | `""`        | Relative path (from workspace root) for local image storage                               |
| `markdownWysiwyg.smartLinks`         | boolean | `true`      | Resolve local links the way your site generator does: workspace-root paths, ancestor content roots, `.md`/`index.md` suffixes, and `[[wikilink]]` targets |
| `markdownWysiwyg.tableWrap`          | string  | `"normal"`  | Table cell text wrapping: `normal`, `aggressive`, or `none`                               |

***

## Requirements

- VS Code **1.80.0** or later

***

## Known Limitations

- **Editable inline/block HTML** is not yet supported — embedded HTML renders read-only, and editing it requires switching to the raw text editor
- **Global search navigation**: clicking a search result for a `.md` file may not scroll to the matched line in WYSIWYG mode when multiple `.md` files are open simultaneously
