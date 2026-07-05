# Why this project exists — a survey of Markdown editing in VS Code

*Research compiled 2026-07-05. This document justifies three decisions: (1) why a WYSIWYG Markdown editor for VS Code is worth building at all, (2) why we chose to fork [`git-xing/md-wysiwyg-editor`](https://github.com/git-xing/md-wysiwyg-editor) specifically, and (3) why we **hard** forked it rather than tracking it or contributing upstream.*

> **On the numbers.** Install counts marked *(approx.)* come from cached mirrors (secure.software) or are order-of-magnitude estimates — the VS Code Marketplace, Open VSX, and badge endpoints were unreachable from the research environment (HTTP 403). GitHub stars, commit dates, and issue/PR counts were read live from GitHub on 2026-07-05 and are reliable. Anything unverifiable is flagged inline.

---

## TL;DR

- **The mainstream VS Code Markdown ecosystem is almost entirely non-WYSIWYG.** The ~10M+ install heavyweights (Markdown All in One, markdownlint, Markdown Preview Enhanced) and the long tail of preview-enhancers, linters, exporters, and knowledge bases all keep the same model: **you edit raw Markdown source; formatting appears only in a separate read-only preview.** In-place rich-text editing is a genuine, largely unserved niche.
- **Within the WYSIWYG niche, the field is thin and split by engine.** The two most-installed WYSIWYG editors (`cweijan.vscode-office`, `zaaack.markdown-editor`) are both built on **Vditor** (a Markdown-mode/textarea hybrid). The **ProseMirror** side — a true rich-text document model — is served only by an official-but-early-access demo (`mirone.milkdown`) and a dormant notes app with data-loss history (`unotes`, Toast UI). **No incumbent combines** a true ProseMirror WYSIWYG surface, in-place editing of the real `.md` file with clean minimal diffs, autosave, first-class table/image UX, AI integration, and active English-first maintenance.
- **We forked `git-xing/md-wysiwyg-editor`** because it already occupies the exact architecture we want — VS Code `CustomEditorProvider` + Milkdown (ProseMirror), editing the real file in place with debounced autosave — so it was a stronger starting point than any greenfield build or any Vditor-based alternative.
- **We hard forked** (rebrand, own publisher, own release line, English-only) because upstream is a **single Chinese-speaking maintainer who has merged zero external PRs, leaves English bug reports — including a data-loss bug — unanswered, and develops commit-first in Chinese.** Soft-forking would mean permanently merging and re-translating Chinese commits, pushing against our English-migration goal on every sync. A sibling fork (`peiyucn/epytor`) independently made the same call.

---

## 1. The landscape: three tiers

### Tier 1 — The incumbents everyone actually installs (all non-WYSIWYG)

These define what "editing Markdown in VS Code" means to most users. Every one of them keeps the **plain-text-plus-preview** model: you type literal `**bold**` in the code editor, and rich formatting only ever renders in a **separate, read-only preview pane** (or an export).

| Extension | ID | Installs (approx.) | What it adds | Editing model |
|---|---|---|---|---|
| **Markdown language + Preview** (built in) | Microsoft core | ships in every VS Code | `markdown-it` preview, scroll sync, path IntelliSense, outline, link validation | Raw source + read-only preview pane |
| **Markdown All in One** | `yzhang.markdown-all-in-one` | ~12–14M | Shortcuts (Cmd/Ctrl+B), TOC, list continuation, table formatter | Rewrites the raw source text |
| **markdownlint** | `DavidAnson.vscode-markdownlint` | ~11M | Linter — diagnostics on raw text | No rendering at all |
| **Markdown Preview Enhanced** | `shd101wyy.markdown-preview-enhanced` | ~10M | Supercharged read-only preview (Mermaid, PlantUML, KaTeX, PDF/slide export) | Source edited plain, side-by-side |
| **Markdown Preview Mermaid** | `bierner.markdown-mermaid` | ~4M | Mermaid in the built-in preview | Raw ` ```mermaid ` blocks |
| **Markdown PDF** | `yzane.markdown-pdf` | ~4M | Export to PDF/HTML/PNG | No editing surface |
| **Marp for VS Code** | `marp-team.marp-vscode` | ~1.5M *(est.)* | Slide authoring + read-only slide preview | Directive-driven source |
| **Markdown Table** | `TakumiI.markdowntable` | ~700K–1M *(est.)* | Pipe-table alignment/Tab navigation | Text manipulation on raw pipes |
| **Foam** / **Dendron** | `foam.foam-vscode` / `dendron.dendron` | ~400K / ~200K *(est.)* | PKM: wiki-links, backlinks, graph over plain `.md` (Dendron **archived 2023**) | Raw Markdown in the normal editor |

**Takeaway:** the entire mainstream — heavyweights and long tail alike — differs only in *what it wraps around the same model*: authoring helpers (Markdown All in One), preview enrichers (the `bierner.*` family, Preview Enhanced), linters (markdownlint), exporters (Markdown PDF, Marp), and knowledge bases (Foam, Dendron). **None of them let you see and edit bold, headings, and tables in place as formatted content.** That inline, contenteditable experience — where Markdown is the storage format but never the thing you stare at — is the gap.

*Sources: [VS Code Markdown docs](https://code.visualstudio.com/docs/languages/markdown); marketplace listings for each ID above; counts via [secure.software](https://secure.software/) cached totals.*

### Tier 2 — The WYSIWYG editors (the actual competitors)

Extensions that render Markdown as **editable rich text**. Data from the GitHub API, 2026-07-05. Marketplace install counts could not be retrieved and are described qualitatively.

| Extension (ID) | Engine | Integration | Edits real `.md`? | Stars / open issues | Last commit | Maintenance |
|---|---|---|---|---|---|---|
| **Office Viewer** `cweijan.vscode-office` | **Vditor** | CustomEditor; multi-format bundle (PDF/Word/Excel too) | Yes, in place | 1,516 / 44 | 2026-07-05 | Very active; heaviest installs |
| **Markdown Editor** `zaaack.markdown-editor` | **Vditor** | Webview panel that **syncs** to file | Yes, in place | 589 / **105** | 2026-06-30 | Active but large issue backlog |
| **Milkdown** `mirone.milkdown` | **Milkdown (ProseMirror)** | Custom editor | Yes, in place | 288 / 28 | 2026-07-04 | Repo active but **self-labeled early-access / in-dev** |
| **UNOTES** `ryanmcalister.Unotes` | **Toast UI Editor** | Takes over editor; notes-app sidebar | Yes, **auto-reformats** | 176 / 61 | last release **v1.5.2, Jan 2023** | **Dormant**; data-loss history |
| **md-wysiwyg-editor** `git-xing/…` *(our fork base)* | **Milkdown (ProseMirror)** | `CustomEditorProvider` + WYSIWYG⇄text toggle | Yes, in place, ~1s autosave | 7 / 8 | 2026-06-22 (v0.2.2) | Single maintainer, Chinese-first |
| Minor / negligible | Milkdown or unspecified | various | — | `boundlessdigital/vscode-markdown-viewer` (1★), `shuheilocale/…` (0★, no license, looks abandoned) | — | — |

**What the field looks like once you filter for a serious daily driver:**

- **The popular options are Vditor-based.** `cweijan` and `zaaack` — the two with real install numbers — both use Vditor, a self-contained Markdown-mode/textarea hybrid rather than a native ProseMirror document tree. `cweijan` is a heavyweight *office* bundle (PDF/Word/Excel/PowerPoint viewers) where Markdown is one feature; `zaaack` opens as a **syncing webview panel** (a recurring source of cursor/scroll/large-file complaints, and 105 open issues).
- **The ProseMirror niche is under-served.** The official `mirone.milkdown` still declares itself **early-access and in development** (thin image/table/autosave, no TOC/AI); `unotes` (Toast UI) was **last released January 2023**, carries 61 open issues, reportedly had a version pulled over stability/data-loss concerns, and **reformats your Markdown without warning**.

*Sources: GitHub repos for each ID (`github.com/cweijan/vscode-office`, `github.com/zaaack/vscode-markdown-editor`, `github.com/Milkdown/vscode`, `github.com/ryanmcalister/unotes`, `github.com/git-xing/md-wysiwyg-editor`).*

### Tier 3 — The engines (why the tech choice matters)

The editor engine is the single biggest determinant of Markdown fidelity. The core question for a "save clean `.md` on disk" product: **does the engine round-trip Markdown ↔ document through a real AST, or through a lossy HTML intermediate?**

| Engine | Type | Native MD round-trip? | Stars | Latest release | Notes |
|---|---|---|---|---|---|
| **Milkdown** *(our engine)* | WYSIWYG framework on **ProseMirror + remark** | **Yes** — remark/mdast, no HTML step | 11.7k | v7.21.2 (2026-06) | Plugin-driven; CSS-variable theming; framework-free core |
| ProseMirror | Low-level toolkit | via `prosemirror-markdown` | ~8.7k* | modules independent | Powerful but "assembly required" |
| TipTap | ProseMirror wrapper (React/Vue) | **Yes, as of v3 (2025)** | 37.5k | v3.27 (2026-06) | Headless — you build all UI; some features paid |
| **Vditor** | Standalone editor (Lute engine) | **Yes** (CommonMark+GFM) | 11.1k | v3.11 (2025-09) | Powers `cweijan`/`zaaack`; monolithic, less composable |
| Lexical (Meta) | Editor framework | **Partial** — transformer-based, not AST | 23.6k | v0.46 (2026-06) | Still pre-1.0; weaker GFM round-trip |
| CodeMirror 6 | **Code editor, not WYSIWYG** | N/A (edits raw source) | 7.8k | 6.x | Only for source/split mode |
| Slate | React rich-text (beta) | **No** native MD; community serializers | 31.7k | 0.125 (2026-06) | Documented fidelity gaps |
| Toast UI Editor | Dual MD/WYSIWYG | **Yes** (ToastMark AST) | 18k | 3.2.2 (**Feb 2023**, stale) | Powers `unotes`; low maintenance |

\* *ProseMirror's org repo was archived 2026-04-07 (development relocated, not abandoned); code lives in independently-versioned npm modules, so no single canonical star/version figure exists.*

**Why Milkdown is the right engine for this product:**

1. **remark serialization → clean, diff-friendly Markdown with no HTML detour.** This directly serves the goal of clean `.md` on disk and pairs naturally with a minimal-diff merge on save (see §4).
2. **Everything-is-a-plugin** architecture matches a webview that composes toolbar / TOC / table / code-block / image components as independent modules.
3. **CSS-variable theming** maps cleanly onto VS Code's `--vscode-*` light/dark variables — no theme fork needed.
4. **Framework-free core** (no React/Vue runtime) keeps a plain-TS webview bundle small and suits the esbuild dual-target build.
5. It sits on **ProseMirror**, the most battle-tested rich-text primitive, while sparing us ProseMirror's manual assembly. Trade-off vs. TipTap: smaller community and fewer prebuilt UI pieces, but a stronger default Markdown story out of the box — and TipTap's native Markdown only arrived in v3 (2025).

The universal pitfall across *all* engines is **serialization churn** — serializers happily normalize whitespace, list markers, emphasis style, and table padding, producing noisy diffs. This is the #1 risk for a Markdown-on-disk tool, and the standard mitigation is a minimal-diff merge — which this project implements (§4).

*Sources: [milkdown.dev](https://milkdown.dev/) / [github.com/Milkdown/milkdown](https://github.com/Milkdown/milkdown); [github.com/ueberdosis/tiptap](https://github.com/ueberdosis/tiptap); [github.com/Vanessa219/vditor](https://github.com/Vanessa219/vditor); [github.com/facebook/lexical](https://github.com/facebook/lexical); [github.com/nhn/tui.editor](https://github.com/nhn/tui.editor); [github.com/remarkjs/remark](https://github.com/remarkjs/remark).*

---

## 2. Why this project exists

Putting the three tiers together, the justification is a stack of specific, verifiable gaps:

1. **The dominant experience is non-WYSIWYG.** Tens of millions of installs sit on tools that never render editable rich text — they help you *type Markdown syntax faster* or *preview it better*. A writer who wants to see bold, tables, and headings as formatted content while editing has essentially no mainstream option.
2. **The WYSIWYG niche is thin and engine-split.** The popular entries are Vditor-based (`cweijan` is an office bundle; `zaaack` is a syncing panel with a heavy backlog). The ProseMirror entries are early-access (`mirone.milkdown`) or dormant with data-loss history (`unotes`).
3. **No incumbent combines the full feature set** we consider table stakes: **true ProseMirror WYSIWYG + in-place editing of the real `.md` with minimal diffs + debounced autosave + first-class table/image UX + AI integration + active, English-first maintenance.** Each incumbent has some of these; none has all.
4. **AI-native editing is unserved.** None of the incumbents integrate with in-editor AI assistants. This fork's Send-to-Claude flow (paragraph/selection with precise file line numbers, `Alt+K`) and its instant sync when an external tool (e.g. Claude Code) rewrites the file on disk are differentiators aimed squarely at the AI-assisted authoring workflow.

The product thesis: **be the ProseMirror-quality, git-friendly, AI-native WYSIWYG Markdown editor that keeps your files clean — the combination nobody else ships.**

---

## 3. Why fork `git-xing/md-wysiwyg-editor` specifically

Given the thesis, the base had to already have: a VS Code `CustomEditorProvider` (not a syncing side-panel), a **ProseMirror** engine (not Vditor/Toast UI), and in-place editing of the real file with autosave. Exactly one project matched all three and was small enough to fully own: **`git-xing/md-wysiwyg-editor`**.

- **Architecture is exactly what we want.** Milkdown (ProseMirror) rendered in a webview via `CustomEditorProvider`; WYSIWYG⇄raw-text toggle; debounced autosave; table drag-handles/insert-lines; code blocks; TOC; link popups; image NodeView; dual-target esbuild (`dist/extension.js` + `dist/webview.js`) with a message-passing bridge. Starting here skipped months of foundational work.
- **Better base than the alternatives.** The Vditor editors (`cweijan`, `zaaack`) are the wrong engine and either a heavyweight bundle or a syncing-panel architecture. `mirone.milkdown` is an unfinished official demo. `unotes` is a dormant notes app on a stale engine. A greenfield build would have re-derived precisely git-xing's architecture.
- **MIT-licensed and small.** MIT permits the fork cleanly, and the project is tiny (7 stars, ~47 commits, ~3 months old) — so forking forfeits almost no shared community and there is little practical prospect of upstream collaboration to give up (see §4).

---

## 4. Why we hard forked (and didn't contribute upstream)

Open-source practice treats forking as a step to take deliberately: contributing upstream is the default, and a fork is justified when **goals genuinely diverge, patches aren't landing, or a shared working process is missing** ([Fogel, *Producing OSS* — Forks](https://producingoss.com/en/forks.html); [The New Stack — Why projects fork](https://thenewstack.io/open-source-projects-fork/); [CMU/ICSE'20 on hard forks](https://www.cs.cmu.edu/~ckaestne/pdf/icse20-forks.pdf)). A permanent *soft* fork that keeps merging upstream carries ongoing **"fork drift"** cost ([Preset — fork drift](https://preset.io/blog/stop-forking-around-the-hidden-dangers-of-fork-drift-in-open-source-adoption/)). Measured against that framing, the hard fork is well-justified here:

1. **Upstream is a single maintainer who has never merged an external contribution.** All 4 closed PRs were authored and self-merged by the owner; **zero external PRs have ever landed.** The "contribute upstream first" default is weak when there is no evidence a patch would be reviewed or merged.
2. **Unresponsive to the English-speaking community.** Six open issues (late June–July 2026), all in English from outside users, including **#14 — a data-loss / file-corruption bug — sitting open with no maintainer reply.** ([issue #14](https://github.com/git-xing/md-wysiwyg-editor/issues/14)) Betting our roadmap on that responsiveness is untenable.
3. **The language barrier is structural, not cosmetic.** Upstream develops commit-first in Simplified Chinese (commits and internal PR titles are Chinese; docs are bilingual). Our project's policy is **English-only**, and every change must move the codebase *toward* English. A soft fork that tracks upstream would force us to continuously merge and re-translate Chinese commits — the fork-drift cost above — permanently pushing *against* our own migration goal on every sync. A hard fork lets every change move toward English monotonically.
4. **We want our own product direction, publisher, release cadence, and English-first identity.** That is the textbook "goals diverge" case for a hard fork rather than a tracking soft fork.
5. **There is precedent within this exact lineage.** [`peiyucn/epytor`](https://github.com/peiyucn/epytor) took the same v0.1.6 base and independently **hard-forked** — rebranded, rebuilt on newer Milkdown, restarted versioning at v1.0.1, and switched to English-first docs. Two independent downstreams reaching the same conclusion is evidence this is the natural response to this upstream, not an overreaction.

**Honest caveats we hold ourselves to:**

- **Upstream is not abandoned** — it shipped v0.2.2 on 2026-06-22 after a real June commit burst. So "abandonment" is *not* our argument; **"single unresponsive maintainer + language mismatch + divergent direction"** is.
- **A hard fork means we own the full maintenance burden** and forgo upstream's future fixes unless we cherry-pick them manually. We accept that in exchange for a coherent English-first codebase and independent direction.

---

## 5. What this fork adds — the concrete differentiators

Beyond inheriting git-xing's architecture, the fork's direction is defined by features the incumbents lack *in combination*:

- **Clean, git-friendly Markdown output (the flagship differentiator).** Rather than writing the serializer's output verbatim — which reformats regions the user never touched (table column padding, separator dash widths, blank-line style) — the fork LCS-diffs the serializer's significant lines against the saved file and applies **only the real content changes** (`webview/utils/minimalDiff.ts`). It also strips Milkdown's `remark-preserve-empty-line` plugin so empty paragraphs and cells stay pure Markdown instead of `<br />`, and uses a custom no-alignment table serializer so editing one cell doesn't reflow the whole table (`webview/serialization.ts`). This directly addresses the serialization-churn pitfall that afflicts every WYSIWYG engine, and is what makes the editor safe to use on files under version control. *(Note: `unotes` reformatting files without warning is a top complaint — this is the deliberate opposite.)*
- **AI-native workflow.** Send-to-Claude for the paragraph/selection under the cursor with precise file line numbers (`Alt+K`), plus instant re-sync when an external tool rewrites the file on disk (via `fs.watch` on the parent directory, surviving atomic/rename writes).
- **First-class table & image UX.** Row/column drag-handles and insert-lines; image paste / drag-drop / picker with local MD5-dedup storage or configurable server upload.
- **Editor amenities the minimal competitors lack:** in-editor find (`Cmd/Ctrl+F`, CSS Custom Highlight API), resizable TOC panel, path autocomplete (`@/`, `./`, `../`), custom themes.
- **English-first, tested, actively maintained** — the migration policy, a Vitest test suite with coverage floors, and CI on every push distinguish it from the dormant/early-access ProseMirror alternatives.

---

## Appendix — verification notes

**Read live from GitHub (reliable):** all star counts, open/closed issue and PR counts, last-commit and release dates, fork lists, and repo languages/licenses in §1 (Tier 2), §1 (Tier 3), §3, and §4.

**Approximate or unverified (flagged in-text):** VS Code Marketplace and Open VSX install counts and ratings — the marketplace, Open VSX, and badge endpoints returned HTTP 403 from the research environment. Tier-1 counts come from secure.software's cached totals (six verified: Markdown All in One, markdownlint, Preview Enhanced, Mermaid, Footnotes, Markdown PDF) or are order-of-magnitude estimates. Confirm on the live marketplace before citing exact figures.

**Specifically could not verify:** upstream's marketplace install/rating (item page 403; publisher `chance-liu` = git-xing inferred from matching id/description/topics); `epytor`'s marketplace publication (claimed in its README, not found in search); maintainer non-response is confirmed for issue #14 in full and strongly implied for #10–#15.

**Key sources:**
- VS Code Markdown: <https://code.visualstudio.com/docs/languages/markdown>
- Competitors: `github.com/cweijan/vscode-office`, `github.com/zaaack/vscode-markdown-editor`, `github.com/Milkdown/vscode`, `github.com/ryanmcalister/unotes`
- Engines: <https://milkdown.dev/>, `github.com/ueberdosis/tiptap`, `github.com/Vanessa219/vditor`, `github.com/facebook/lexical`, `github.com/nhn/tui.editor`, `github.com/remarkjs/remark`
- Upstream & forks: `github.com/git-xing/md-wysiwyg-editor` (+ `/issues/14`, `/pulls`, `/forks`), `github.com/peiyucn/epytor`
- Forking guidance: <https://producingoss.com/en/forks.html>, <https://thenewstack.io/open-source-projects-fork/>, <https://www.cs.cmu.edu/~ckaestne/pdf/icse20-forks.pdf>, <https://preset.io/blog/stop-forking-around-the-hidden-dangers-of-fork-drift-in-open-source-adoption/>
