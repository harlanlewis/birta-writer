# Markdown Writer

English | [简体中文](README.zh-CN.md) | [GitHub](https://github.com/harlanlewis/markdown-writer)

> A personal fork of [git-xing/md-wysiwyg-editor](https://github.com/git-xing/md-wysiwyg-editor) (MIT). Not affiliated with or endorsed by the upstream project.

Markdown Writer is a VS Code WYSIWYG Markdown editor extension powered by [Milkdown](https://milkdown.dev/) (ProseMirror). Edit `.md` / `.markdown` files as rich text and save as standard Markdown — fully compatible with any text editor.

***

## Features

### Rich Text Editing

- **Headings** (H1–H6), **bold**, *italic*, ~~strikethrough~~, `inline code`, blockquote, horizontal rule
- **Ordered / Unordered / Task lists** (click checkbox to toggle completion)
- **Links**: hover to show a popup for editing link text and URL inline; supports `@/` workspace paths, `#anchor` in-page jumps, and `file.md#27` line-number links
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

### Custom Themes

- Support for custom color themes via `markdownWriter.customThemes` configuration
- Define themes in `.vscode/settings.json` with custom name and VS Code color IDs
- Select custom themes from the Command Palette: "Select Color Theme"
- See [Custom Theme Configuration](docs/en/custom-themes.md) for details

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

### Auto Save

- Automatically writes to disk **1 second** after editing stops — no need to press `Cmd+S` / `Ctrl+S`
- Can be disabled; manual save shows `●` in the tab title
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
| `markdownWriter.autoSave`           | boolean | `true`      | Automatically save to disk after editing                                                  |
| `markdownWriter.autoSaveDelay`      | number  | `1000`      | Debounce delay in milliseconds for auto-save                                              |
| `markdownWriter.defaultMode`        | string  | `"preview"` | Default mode when opening `.md`: `preview` (WYSIWYG) or `markdown` (text editor)          |
| `markdownWriter.codeBlockMaxHeight` | number  | `600`       | Maximum code block height in pixels                                                       |
| `markdownWriter.editorMaxWidth`     | number  | `900`       | Maximum editor content width in pixels                                                    |
| `markdownWriter.fontFamily`         | string  | `""`        | Editor font family; leave empty to inherit VS Code editor font. Example: `Georgia, serif` |
| `markdownWriter.imageLocalPath`     | string  | `""`        | Relative path (from workspace root) for local image storage                               |
| `markdownWriter.confirmExternalLinks` | boolean | `true`    | Ask for confirmation before opening an external link in your browser; images are always stored locally and never uploaded off your machine |
| `markdownWriter.colorTheme`         | string  | `"auto"`    | Color theme: `auto` follows VS Code, or set a theme ID                                   |
| `markdownWriter.tableWrap`          | string  | `"normal"`  | Table cell text wrapping: `normal`, `aggressive`, or `none`                               |
| `markdownWriter.customThemes`       | array   | `[]`        | Custom color themes array. See [Custom Theme Configuration](docs/en/custom-themes.md)    |

***

## Requirements

- VS Code **1.80.0** or later

***

## Known Limitations

- **Editable inline/block HTML** is not yet supported — embedded HTML renders read-only, and editing it requires switching to the raw text editor
- **Global search navigation**: clicking a search result for a `.md` file may not scroll to the matched line in WYSIWYG mode when multiple `.md` files are open simultaneously
