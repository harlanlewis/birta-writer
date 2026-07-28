# Provenance — how much of the origin project remains

Birta Writer is a hard fork of [`git-xing/md-wysiwyg-editor`](https://github.com/git-xing/md-wysiwyg-editor).
`README.md` ("Why this fork") covers **why** the fork happened. This file covers a different
question — **how much of the origin project is still here** — and answers it with measurements
rather than assertions.

**This is an append-only log, not a refined document.** It is the `CHANGELOG.md` kind of file, not
the `docs/BENEFITS.md` kind: entries are **never revised in place**. Each snapshot is stamped with
its date and pinned to exact commit SHAs, so it stays true forever as a statement about that moment.
To report a newer figure, **add a snapshot** above the previous one — do not edit an older one, even
if its number is now wrong. An old snapshot going stale is the point; the series is the signal.

For the same reason, **other documents should link here rather than quote a figure.** A percentage
copied into `README.md` or `AGENTS.md` decays in place with every commit and nothing will ever flag
it — the exact failure mode `AGENTS.md` records for `bundle-baseline.json` ("records a measurement;
it is not one"), where a stale number still read as current and produced a 3× error.

---

## Lineage (immutable)

These facts are fixed by history and will not change:

| Date | Commit | Event |
|------|--------|-------|
| 2026-03-24 | `21797b9` | Origin project's root commit (`init`) |
| 2026-06-21 | `68d7263` | **Fork base** — last commit authored upstream |
| *11-day gap* | | |
| 2026-07-02 | `d877c3e` | **First Birta Writer commit** — `fix: harden webview HTML rendering against XSS` |

The fork is a clean linear continuation: `d877c3e` has `68d7263` as its **sole parent** — no merge,
no squash, no re-init, and the origin project's full history is present in this repository rather
than discarded. This is verifiable in one command, which is what substantiates the MIT attribution
in `NOTICE`:

```sh
git log -1 --format='%P' d877c3e     # -> 68d72635a42a90802625145a9b46a0744d2e8a76
git merge-base --is-ancestor 68d7263 HEAD && echo "origin history is an ancestor"
```

Upstream contributed 47 commits (authors `刘耀明` / `like`) between 2026-03-24 and the fork base.
No upstream commit has been merged since; per `AGENTS.md`, the `upstream` remote is removed on
purpose and must not be re-added.

---

## Snapshot — 2026-07-25

Measured at `d9b179f` against fork base `68d7263`. 513 fork commits over 23 days.

### Surviving origin code

| Scope | Origin lines surviving | Total | Share |
|-------|------------------------|-------|-------|
| Whole tracked tree | 12,611 | 147,588 | **8.5%** |
| Product source (`src`/`webview`/`shared`/`packages`, excluding `__tests__`) | 11,053 | 69,692 | **15.9%** |
| Tests | 629 | 60,129 | 1.0% |

Read the other way: the origin project's product source was ~17,614 lines at the fork base, and
~11,053 of those lines are still present — roughly **63% of what upstream wrote survives**. Its code
was not deleted; it was surrounded. It went from being the codebase to being a minority substrate.

### Structural change

| | Fork base | This snapshot |
|---|---|---|
| Tracked files | 117 | 682 |
| — surviving by path | | 93 |
| — deleted/renamed | | 24 |
| — new | | 589 |
| `webview/plugins/` | 14 | 69 |
| `webview/components/` | 10 | 21 |
| Test files | 7 | 256 |
| Test LOC | 1,096 | 60,129 |

Upstream had no e2e harness, no integration suite, and no performance harness; all three exist now,
along with blocking CI perf gates on launch and typing.

### The survival is stratified, not uniform

The 15.9% is concentrated almost entirely in the DOM/chrome layer — the code where a rewrite would
buy nothing. Sampling the surviving lines confirms it: import blocks, `document.createElement`
boilerplate, `--vscode-*` declarations, `box-sizing: border-box`.

| Chrome — substantially still upstream | Share |
|---|---|
| `webview/plugins/horizontalRule.ts` | 95% |
| `src/utils/imageService.ts` | 92% |
| `webview/plugins/tableCellClickFix.ts` | 83% |
| `webview/eventManager.ts` | 75% |
| `webview/plugins/headingSticky.ts` | 67% |
| `webview/components/codeBlock/codeBlock.css` | 66% |
| `webview/components/codeBlock/index.ts` | 62% |
| `webview/components/imageView/index.ts` | 61% |
| `webview/components/selectionToolbar/index.ts` | 58% |

| Spine — effectively none | Share |
|---|---|
| `src/saveFlushController.ts` | 0% (new file) |
| `webview/syncScheduler.ts` | 0% (new file) |
| `webview/pm.ts` | 1% |
| `webview/serialization.ts` | 4% |
| `webview/editor.ts` | 14% |
| `src/MarkdownEditorProvider.ts` | 27% (of a file that tripled in size) |

Upstream's `src/MarkdownDocument.ts` and `src/themeManager.ts` were deleted outright. The entire
view→document sync contract — seq ordering, save flush, the debounce-as-crash-safety-window — has no
upstream ancestor; there was no equivalent to rewrite.

### Dependencies

The substrate is unchanged: Milkdown, ProseMirror, refractor, mermaid, dompurify, prosemirror-tables.

- **Added**: `katex`, `mathjs`, `harper.js`, `remark-math`, `unist-util-visit`, `@milkdown/plugin-diff`,
  and the in-repo `@birta/minimal-diff` workspace package.
- **Removed**: `@milkdown/plugin-listener` — architectural, not cosmetic; its unconditional trailing
  `debounce` sat in the sync path (MAR-145).

### Character of the divergence

Upstream is a WYSIWYG Markdown editor for VS Code — a Milkdown webview with good chrome, ~22k lines,
built feature-first. This fork kept that shell and rebuilt underneath it around two commitments with
no trace in the pre-fork tree:

1. **Round-trip fidelity** — `contentGuard`, `fidelitySerializer`, `reparseHazard`, `fingerprints`,
   and a format-agnostic minimal-diff engine extracted into a package behind an injected
   `FormatProfile` (markdown deliberately framed as "format #1").
2. **Measured performance** — blocking CI gates, an eager-bytes budget, lazy-load seams for every
   heavy dependency.

Plus a feature surface with no upstream ancestor at all: the calc engine, proofreading, heading fold,
block menu with drag/marquee, slash menu, callouts and directives, footnotes, wiki links, math,
embeds. And the Chinese→English migration and rebrand, which touch nearly every file.

### Method, and how to reproduce

```sh
SHA=d9b179f   # the commit being measured
BASE=68d7263  # fork base
# d9b179f is the head of PR #130's branch, which was SQUASH-merged — so the SHA is
# not on `main` and `git blame` will not find it in a fresh clone. It stays
# reachable through the PR ref:
#   git fetch origin refs/pull/130/head
# The fork base and the method below are unaffected; only this snapshot's SHA
# needs the fetch. Later snapshots should stamp a commit that is on `main`.

git ls-tree -r --name-only $SHA \
  | grep -E '\.(ts|js|mjs|css|json|md|yml|yaml)$' | grep -v pnpm-lock \
  | while read -r f; do
      git blame --line-porcelain -w -M -C $SHA -- "$f" 2>/dev/null | grep '^author '
    done | sort | uniq -c | sort -rn
```

Origin lines are those authored by `刘耀明` or `like`; everything else is fork work.

Three caveats that belong with any figure produced this way:

- **Measure a committed SHA, not the working tree.** `git blame $SHA -- <file>` pins it. A dirty tree
  silently measures uncommitted work.
- **`-w -M -C` is deliberately generous to upstream.** It ignores whitespace and follows moved and
  copied code, so origin lines are credited wherever they ended up. Every share above is therefore an
  **upper bound** on what is genuinely upstream's.
- **The figure only moves one direction.** It falls with every commit. That is why this file appends
  rather than updates, and why nothing else in the repo should quote a number from it.

### Not measured

This snapshot compares against upstream **as of the fork base (2026-06-21)**, which is the only
version of it present in this repository. `AGENTS.md` bars contacting `git-xing/md-wysiwyg-editor`,
so upstream's development since that date was not examined and the divergence in that direction is
unquantified. Upstream's pre-fork cadence was 47 commits over three months, but that is inference,
not evidence.
