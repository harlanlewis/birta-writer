# Roadmap — "Never leave WYSIWYG"

> Synthesized 2026-07-03 from a deep-research pass combining: (a) a full audit of this
> codebase, (b) every open/closed issue on upstream (`git-xing/md-wysiwyg-editor`) and this
> fork, (c) issue-tracker mining of competing VS Code WYSIWYG extensions
> (zaaack/vscode-markdown-editor, cweijan/vscode-office, unotes) and Milkdown itself, and
> (d) capability diffing against Typora, Obsidian Live Preview, Notion, MarkText, and
> milkdown/crepe.

## Status (updated 2026-07-04, shipped in v0.2.3)

Tracked as Linear issues MAR-1…MAR-33. **Landed:**

- **Phase 0 — round-trip fidelity**: MAR-1 (regression corpus + destructive-diff guard), MAR-2 (preserve unknown syntax), MAR-3/4/5/6 (shortcut leak-through, Remote-SSH, overlay undo, lossless frontmatter), MAR-33 (formatted-link splitting).
- **Phase 1 — VS Code parity**: MAR-7 (CustomTextEditorProvider migration), MAR-8 (source-based find/replace), MAR-9 (command palette + context menu), MAR-10 (toolbar overflow), MAR-11 (i18n sweep + CJK guard), MAR-12 (heading outline / Go-to-Symbol).
- **Phase 2 — syntax breadth**: MAR-13 (KaTeX math), MAR-15 (footnotes), MAR-16 (source-style preservation), MAR-17 (table-cell line breaks).

**Deferred:** MAR-14 (editable HTML) — the one remaining Phase 2 item; embedded HTML stays read-only for now, protected byte-for-byte by the round-trip layer.

The per-phase detail below is the original plan; items above have shipped.

## North star

A user opens a `.md` file in WYSIWYG mode and **never needs the raw text editor** unless
they genuinely prefer it. Every roadmap item is judged by one question: *does this remove a
reason to pop out?*

Research caveat that shapes everything below: even the most mature competitor
(vscode-office) still ships a one-keystroke "Edit in VS Code" escape hatch as a first-class
feature. The pop-out should stay polished and instant — a safety net, not a wall.

## Ordering principle

The evidence is unambiguous about sequencing:

1. **Trust before features.** The #1 trust-killer across every tracker studied is
   round-trip infidelity ("it reformatted my file", "it lost content"). Unotes — a direct
   competitor — was *un-published from the Marketplace* over exactly this
   ([unotes README](https://github.com/ryanmcalister/unotes)). Upstream has a live
   corruption report ([#14](https://github.com/git-xing/md-wysiwyg-editor/issues/14)), and
   MarkText's most-reacted bug is "document is modified just by opening it"
   (marktext#2189, +48). One corruption event sends a user back to raw mode permanently.
2. **Parity before delight.** VS Code's custom-editor API deliberately provides nothing —
   no find, no undo integration, no search reveal
   ([microsoft/vscode#86802](https://github.com/microsoft/vscode/issues/86802), API owner:
   "that's all intentionally left up to extensions"). Users feel these losses daily;
   upstream's only open feature request is find/replace
   ([#12](https://github.com/git-xing/md-wysiwyg-editor/issues/12)).
3. **Syntax coverage kills the remaining forced pop-outs.** Math, HTML, footnotes,
   frontmatter, reference links.
4. **Interaction polish** (slash commands, source-peek, drag handles) is what makes the
   editor *preferred*, not merely tolerated.

---

## Phase 0 — Fidelity & trust (existential, do first)

### 0.1 Round-trip regression corpus + save-time safety check
- **What**: A test corpus of real-world markdown (frontmatter-heavy, HTML-bearing,
  ref-links, footnotes, math, huge tables, CJK) with an invariant test: *open → no edit →
  no diff*, and *edit one line → diff touches only that line*. Add a save-time guard: if
  `applyMinimalChanges` would delete lines the user never touched, block the write and
  surface a warning instead of silently dropping content.
- **Why**: The minimal-diff serializer (`webview/utils/minimalDiff.ts`) is this project's
  moat — the exact mechanism whose absence killed unotes and plagues upstream (#14).
  Milkdown has serializer round-trip corruption bugs of its own (autolink backslash
  doubling, [Milkdown#2349](https://github.com/Milkdown/milkdown/issues/2349)) that a
  guard layer must catch.
- **Files**: `webview/utils/minimalDiff.ts`, `webview/serialization.ts`,
  `webview/__tests__/`.

### 0.2 Preserve-unknown-syntax nodes (opaque raw blocks)
- **What**: Model constructs the schema can't represent — footnote definitions,
  reference-link definitions (`[ref]: url`), math blocks, multi-line HTML, comments — as
  opaque "raw markdown" ProseMirror nodes that render as a dimmed read-only chip/block but
  serialize byte-for-byte. Today they are dropped by the schema and become **silent
  deletions** on the next edit.
- **Why**: This single change converts every "unsupported syntax = data-loss risk" trigger
  into "unsupported syntax = visible but safe", making WYSIWYG mode *safe by default* on
  any file. It also de-risks every Phase 2 item (each later becomes "upgrade an opaque
  node to a rich node").
- **Files**: `webview/plugins/` (new node + remark passthrough), `webview/serialization.ts`,
  `webview/editor.ts:42-56` (existing read-only `html` NodeView is the pattern to extend).

### 0.3 Frontmatter that can't destroy YAML
- **What**: The current panel splits lines on the first colon and rewrites the block as
  flat `key: value` (`webview/components/frontmatter/index.ts:21-43`) — nested maps,
  lists, block scalars, comments, and quoting are destroyed on first commit. Fix: parse
  with a real YAML parser; if the document uses anything beyond flat scalars, switch the
  panel to a raw YAML text editor (monospace, highlighted) instead of the table; only
  offer the table view when it can round-trip losslessly. Preserve untouched keys verbatim.
- **Why**: "Destroys YAML front matter" is a named competitor failure (unotes#67); Milkdown
  has no frontmatter node ([Milkdown#1712](https://github.com/Milkdown/milkdown/issues/1712)),
  so this stays our responsibility. Anyone using static-site or Obsidian-style metadata
  pops out today.
- **Files**: `webview/components/frontmatter/index.ts`, `src/utils/contentTransform.ts`.

### 0.4 Fix the architectural bugs users already filed
- **Keybinding leak-through** (upstream #15): Cmd+B/Cmd+I first press both styles text
  *and* toggles the VS Code sidebar. Consume handled keys in the webview
  (`preventDefault` + `stopPropagation` at capture) and audit every shortcut in
  `webview/keyboardShortcuts.ts` / `webview/plugins/formatKeymap.ts`.
- **Remote/WSL/Codespaces support** (upstream #10): `"extensionKind": ["ui"]` strands the
  editor on the local host. Switch to `["workspace", "ui"]` and verify image paths/fs
  access through `vscode.workspace.fs`. Table stakes for remote-dev and agentic users;
  same failure class killed zaaack in code-server (zaaack#87).
- **Undo inside popup inputs** (upstream #4, README known limitation): Electron intercepts
  Cmd+Z before the input sees it. Implement a small input-history fallback (or
  `document.execCommand("undo")`) for link popup / image toolbar fields.
- **Document-level undo/redo stubs**: `MarkdownEditorProvider.ts:627-628` has
  `undo/redo /* TODO */`. Superseded by Phase 1.1 if adopted; otherwise wire them to
  ProseMirror history via messages.
- **Files**: `package.json`, `webview/keyboardShortcuts.ts`,
  `webview/components/linkPopup/index.ts`, `src/MarkdownEditorProvider.ts`.

---

## Phase 1 — VS Code parity (the webview should not cost you your editor)

### 1.1 Migrate to `CustomTextEditorProvider` (architecture keystone)
- **What**: Replace the hand-rolled `MarkdownDocument` + `fs.watch` + stub-undo custom
  document (`src/MarkdownEditorProvider.ts:28-29`, `src/MarkdownDocument.ts`) with a
  `TextDocument`-backed `CustomTextEditorProvider`: webview posts minimal-diff edits as
  `WorkspaceEdit`s; `onDidChangeTextDocument` pushes external changes back into Milkdown
  with cursor preservation via block-level doc diffing (recipe in
  [Milkdown#2396](https://github.com/Milkdown/milkdown/issues/2396), `@milkdown/plugin-diff`).
- **Why**: This is the [officially recommended architecture](https://code.visualstudio.com/api/extension-guides/custom-editors)
  for text formats and buys, *for free*: native save/hot-exit/backup, real dirty state,
  working document-level undo/redo, git integration, and live propagation of edits made by
  other extensions, source control, or a side-by-side raw editor. It also fixes
  global-search reveal (upstream #5) properly, enables Phase 1.4 providers, and makes
  "WYSIWYG + raw split view" possible later. zaaack proves the sync loop in production
  (guarded by `panel.active` against feedback loops); our minimal-diff writes are already
  finer-grained than their whole-document replace.
- **Files**: `src/MarkdownEditorProvider.ts` (major), `src/MarkdownDocument.ts` (retire),
  `src/extension.ts`, `webview/messaging.ts`, `shared/messages.ts`.
- **Effort**: the one large refactor on this roadmap; everything else stays incremental.

### 1.2 Real find & replace (search the *source*, not the rendered DOM)
- **What**: Rebuild the find bar to search the markdown source text and map hits to
  ProseMirror positions (the line map used by scroll sync and reveal already does most of
  this mapping), instead of `TreeWalker` over rendered text
  (`webview/components/findBar/index.ts:175-191`). Add regex and whole-word toggles; let
  matches land inside link URLs, image paths, alt text, and code fence info strings.
- **Why**: Find/replace is upstream's only open enhancement (#12), and today any
  syntax-level search (`**`, a URL, `#`) finds nothing — a guaranteed pop-out. Replace
  already exists and is well built (reverse-order, single undo step); it just searches the
  wrong haystack.
- **Files**: `webview/components/findBar/index.ts`, `src/utils/lineMap.ts`.

### 1.3 Command palette + context menu surface
- **What**: Contribute the editor's actions as real VS Code commands gated on
  `activeCustomEditorId == 'markdownWriter.editor'` — insert table/code block/image,
  toggle bold/heading/list, open find, edit frontmatter, toggle TOC — plus `webview/context`
  menu items (right-click: cut/copy/paste, insert row/column, edit link, copy as HTML).
  Today `package.json` contributes **zero** editing commands and no context menu at all.
- **Why**: Restores muscle memory (Cmd+Shift+P works everywhere else) and
  discoverability; keyboard-only users currently have ~8 shortcuts and no other path to
  most features. Cheap: each command is one message on the existing protocol.
- **Files**: `package.json` (contributes), `src/extension.ts`, `shared/messages.ts`,
  `webview/messageHandlers.ts`.

### 1.4 Outline, breadcrumbs, and link providers
- **What**: Register `DocumentSymbolProvider` (headings → Outline view + breadcrumbs +
  Cmd+Shift+O), `DocumentLinkProvider`, and `FoldingRangeProvider` for markdown documents
  backed by the custom editor. Trivial once 1.1 lands (the `TextDocument` exists); before
  that, approximate via the TOC data the webview already computes.
- **Why**: None are registered today (`src/extension.ts`), so Outline/breadcrumbs/symbol
  navigation are dead in WYSIWYG mode — a listed pop-out trigger, and a top competitor ask
  (zaaack#24).
- **Files**: `src/extension.ts` (new providers), reuse `webview/headingIds.ts` slug logic.

### 1.5 Toolbar overflow menu
- **What**: Responsive overflow menu for narrow panes (upstream #13).
- **Files**: `webview/components/toolbar/index.ts`.
- **Note**: The i18n-hygiene half of this item (upstream #11 — sweeping hardcoded
  Chinese strings into `t("<key>")`) is complete. The Chinese-to-English migration
  is done and now enforced by the CJK guard (`shared/__tests__/noCjkLiterals.test.ts`),
  so no source string may contain CJK. English is the source/base language: `t()`
  falls back to its key, and there is no longer a translation-data module.

---

## Phase 2 — Syntax coverage (eliminate each forced pop-out)

### 2.1 Math (KaTeX) — highest-value gap, first-party fix available
- **What**: Inline `$...$` and block `$$` math, rendered with KaTeX, edited in place
  (Typora pattern: `$$` + Enter opens a block math editor; click a rendered formula to
  edit its source in a popover). Crepe — Milkdown's own distribution — ships this as its
  `Latex` feature (katex ≥0.16 + remark-math 6.0, default-on since v7.6.0), so this is
  integration work on our exact stack, not greenfield.
- **Why**: README-acknowledged gap; any math-bearing document forces raw mode today. The
  Vditor-based competitors all render KaTeX.
- **Files**: `webview/editor.ts` (plugin), new `webview/components/math/`,
  `webview/serialization.ts` (round-trip), `package.json` (katex dep).

### 2.2 Editable HTML (per-block source/output toggle, Typora pattern)
- **What**: Upgrade the read-only sanitized `html` atom (`webview/editor.ts:42-56`) to an
  *editable* node: rendered output by default, with a click/Cmd+Enter toggle to edit the
  raw HTML in a small highlighted source panel per block ("just like math blocks" —
  Typora). Keep DOMPurify for the rendered side; never execute scripts. Render common
  inline tags (`<u>`, `<sub>`, `<sup>`, `<kbd>`, `<br>`, `<img width=...>`) live.
- **Why**: Milkdown upstream has left this open for ~2.5 years
  ([Milkdown#1249](https://github.com/Milkdown/milkdown/issues/1249) — its most-commented
  open feature request), so we must own it. Today *any* embedded HTML edit forces raw
  mode, and HTML comments are invisible (DOMPurify strips them — render them as dimmed
  editable comment chips instead).
- **Files**: `webview/editor.ts`, new `webview/components/htmlBlock/`,
  `webview/serialization.ts`.

### 2.3 Footnotes
- **What**: `[^1]` references + definitions with insert command, hover preview of the
  definition, and click-to-jump both ways. Via `remark-gfm`'s footnote support /
  `remark-footnotes` + custom nodes on top of the Phase 0.2 opaque-node fallback.
- **Why**: README-acknowledged gap. Note from verification: claims of an off-the-shelf
  Milkdown footnote plugin did **not** check out — budget for custom node work and do a
  fresh spike first.
- **Files**: new `webview/plugins/footnotes.ts`, `webview/components/`,
  `webview/serialization.ts`.

### 2.4 Source-style preservation (don't canonicalize untouched constructs)
- **What**: Extend the minimal-diff normalizer set so first-edit-of-a-line doesn't rewrite
  unrelated style: preserve setext headings, `***` rules, reference-style links (keep the
  definition block via 0.2 and emit reference form for existing links), and existing
  emphasis markers (`_` vs `*`) where feasible. Optionally: a "respect markdownlint
  config" mode — unotes' most-commented issue (unotes#15) was reformatting that fights
  linters.
- **Files**: `webview/utils/minimalDiff.ts` normalizers, `webview/serialization.ts`
  stringify options.

### 2.5 Table cell line breaks
- **What**: Support `<br>` inside GFM table cells (Shift+Enter in a cell → `<br>`),
  blocked at the preset level upstream ([Milkdown#2078](https://github.com/Milkdown/milkdown/issues/2078),
  same complaint zaaack#41).
- **Files**: `webview/serialization.ts` (`serializeTableNoAlign`), table schema patch.

---

## Phase 3 — Interaction patterns that make it *preferred*

### 3.1 Slash command menu
- **What**: Type `/` for a filterable insert menu (heading, table, code block, image,
  math, mermaid, task list, HR, footnote…). Crepe's `BlockEdit` feature bundles a
  first-party slash menu + drag handle (`@milkdown/crepe/feature/block-edit`, built on
  `@milkdown/plugin-block` + slash plugin) — adoptable individually.
- **Why**: The signature Notion-class interaction; keeps hands on the keyboard and makes
  every insertable discoverable without toolbar hunting.
- **Files**: `webview/editor.ts`, new `webview/components/slashMenu/`, theme CSS in
  `webview/style.css`.

### 3.2 Block drag handles
- **What**: Hover gutter handle to drag-reorder blocks (paragraphs, list items, tables,
  code blocks); same Crepe `BlockEdit` foundation as 3.1. The table components already
  prove the drag-overlay pattern in this codebase.
- **Files**: `webview/editor.ts`, `webview/components/` (new), reuse patterns from
  `webview/components/table/handles.ts`.

### 3.3 Source-peek: per-block "edit as markdown"
- **What**: Cmd+/ (or a block-menu action) flips the current block into a raw-markdown
  micro-editor inline (monospace textarea + highlight, like the existing fullscreen code
  editor in `webview/components/codeBlock/index.ts:1012-1038`), committed back through the
  parser on blur/Enter. This is the ProseMirror-appropriate approximation of Obsidian
  Live Preview's cursor-reveal (Obsidian can do true syntax-reveal only because it's
  CodeMirror-source-with-decorations underneath).
- **Why**: The ultimate escape-hatch killer — precise syntax control *without leaving the
  editor or losing your place*. Whatever Phases 0–2 miss, this catches.
- **Files**: new `webview/components/blockSource/`, `webview/serialization.ts` (block-level
  parse/serialize helpers).

### 3.4 Smart paste
- **What**: Paste URL onto selected text → link; paste rich HTML → converted markdown
  (with a "paste as plain text" alternative, Cmd+Shift+V); paste markdown source → parsed;
  paste image → existing upload pipeline (already good). Add an upload-progress indicator
  (Milkdown#1554) and guard special-character paste (Milkdown#2400).
- **Why**: Copy/paste correctness is recurring-theme #3 across all competitor trackers;
  paste-without-format is a named ask (unotes#114). Upstream #14 specifically mentions
  paste as a corruption vector — pair this with the Phase 0.1 corpus.
- **Files**: new `webview/plugins/paste.ts`, `webview/imageUpload.ts`.

### 3.5 Keyboard completeness
- **What**: `Shift-Tab` outdent (missing today — `webview/plugins/tabKeymap.ts` has no
  binding); Cmd+K = link on selection; Cmd+Shift+7/8 list toggles; Alt+↑/↓ move
  block/list-item (vscode-office ships this); Cmd+D select-next-occurrence *within* find
  (precursor to multi-cursor); heading level up/down. Publish a shortcuts cheatsheet in
  the settings/help menu.
- **Files**: `webview/plugins/tabKeymap.ts`, `webview/plugins/formatKeymap.ts`,
  `webview/keyboardShortcuts.ts`, `package.json` keybindings.

### 3.6 Default-open polish
- **What**: We already register as an optional custom editor with `defaultMode` switching —
  the single most-duplicated ask on zaaack's tracker (≈8 filings) and a moat. Polish it:
  first-run prompt offering `workbench.editorAssociations`, per-workspace opt-out, and keep
  the Cmd+Shift+M raw-mode round-trip instant and cursor-preserving (both directions).
- **Files**: `src/extension.ts`, `package.json`.

---

## Phase 4 — Ambitious / differentiators

- **4.1 Multi-cursor editing** — ProseMirror has no native multi-selection; a
  decorations-based multi-caret for the common cases (find-all-and-edit, column-ish edits
  in lists/tables) is research-grade. Pragmatic first step: regex replace-all (1.2) +
  Cmd+D cycling (3.5). Full multi-cursor only if demand shows up.
- **4.2 Vim mode** — the most-reacted request on both Typora (#187, +299) and MarkText
  (#596, +135) trackers; no credible ProseMirror vim layer exists, so scope to a
  navigation subset (j/k/gg/G//) behind a setting, or rely on the instant pop-out.
- **4.3 Spell/grammar check** — cSpell works on the `TextDocument` after 1.1; surface
  squiggles in-webview via line-map decorations. (Typora's #3 request: Grammarly, +207.)
- **4.4 Callouts/admonitions** (`> [!note]`) — render Obsidian/GitHub-style alerts richly
  (MarkText #2115); degrade gracefully to blockquote.
- **4.5 Wiki links** `[[...]]` — behind a setting (Typora #1765, +112); pairs with the
  existing `pathLink` and slug logic.
- **4.6 Word count / reading time** — status bar + selection count (MarkText #2791).
- **4.7 Diagram breadth** — Graphviz/PlantUML rendering (languages already in the picker,
  render pipeline exists for Mermaid); ECharts/abc.js only if asked.
- **4.8 Sticky-scroll heading context** — heading-sticky plugin already exists; extend to
  breadcrumb trail at top of viewport.
- **4.9 Print / export** — PDF/HTML export via the existing rendered DOM (vscode-office's
  headline feature; zaaack #141).

---

## Explicit pop-out trigger → fix map

| Forces raw mode today | Fixed by |
|---|---|
| Footnotes dropped/at-risk | 0.2 (safe) → 2.3 (rich) |
| Math unrendered/uneditable | 0.2 → 2.1 |
| Frontmatter beyond flat keys destroyed | 0.3 |
| Raw HTML read-only; comments invisible | 0.2 → 2.2 |
| Reference links flattened; setext/`***` canonicalized | 0.2 → 2.4 |
| Constructs silently deleted on edit | 0.2 + 0.1 guard |
| Find can't match syntax/URLs; no regex | 1.2 |
| No Outline/breadcrumbs/Cmd+Shift+O | 1.4 |
| Global search won't reveal the line (#5) | 1.1 |
| Document undo/redo stubs; popup undo dead (#4) | 1.1 + 0.4 |
| Cmd+B leaks to workbench (#15) | 0.4 |
| Remote/WSL broken (#10) | 0.4 |
| No command palette / right-click actions | 1.3 |
| Precise syntax control ("let me just see the markdown") | 3.3 source-peek |
| Table cells can't hold line breaks | 2.5 |
| Paste corruption / no plain-paste | 3.4 + 0.1 |

## Key sources

- Upstream issues: [#4](https://github.com/git-xing/md-wysiwyg-editor/issues/4),
  [#5](https://github.com/git-xing/md-wysiwyg-editor/issues/5),
  [#10](https://github.com/git-xing/md-wysiwyg-editor/issues/10),
  [#11](https://github.com/git-xing/md-wysiwyg-editor/issues/11),
  [#12](https://github.com/git-xing/md-wysiwyg-editor/issues/12),
  [#13](https://github.com/git-xing/md-wysiwyg-editor/issues/13),
  [#14](https://github.com/git-xing/md-wysiwyg-editor/issues/14),
  [#15](https://github.com/git-xing/md-wysiwyg-editor/issues/15); fork
  [#1](https://github.com/harlanlewis/markdown-writer/issues/1)
- VS Code custom editor API: [guide](https://code.visualstudio.com/api/extension-guides/custom-editors),
  [microsoft/vscode#86802](https://github.com/microsoft/vscode/issues/86802)
- Milkdown constraints: [#1249 HTML](https://github.com/Milkdown/milkdown/issues/1249),
  [#1712 frontmatter](https://github.com/Milkdown/milkdown/issues/1712),
  [#2078 table `<br>`](https://github.com/Milkdown/milkdown/issues/2078),
  [#2349 backslash doubling](https://github.com/Milkdown/milkdown/issues/2349),
  [#2396 cursor-preserving patch](https://github.com/Milkdown/milkdown/issues/2396)
- Prior art: [Crepe features](https://milkdown.dev/docs/guide/using-crepe) (Latex,
  BlockEdit), [Typora HTML/math](https://support.typora.io/HTML/),
  [Obsidian Live Preview](https://help.obsidian.md/Live+preview+update),
  [zaaack/vscode-markdown-editor](https://github.com/zaaack/vscode-markdown-editor),
  [cweijan/vscode-office](https://github.com/cweijan/vscode-office),
  [unotes cautionary tale](https://github.com/ryanmcalister/unotes)
