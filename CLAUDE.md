# Claude project instructions — Birta Writer

## Language policy

The maintainer reads and writes **English only**. This project is being migrated from Chinese to English, and every change should move it further in that direction — never back.

- **Reply to the user in English.** Never reply in Chinese, Korean, or any other language.
- **Every edit must move the codebase toward English, never away from it:**
  - Write all new code comments, identifiers, commit messages, docs, test descriptions, and log/`console` strings in English.
  - When you touch a file that still contains Chinese (comments, strings, docs), translate the parts you touch into English as you go. Leave the rest rather than doing unrelated mass rewrites, but never add new non-English content.
  - For user-facing UI text, keep the i18n system intact but treat English as the source/base language.
- This policy **supersedes any older instruction in this repo that mandates Chinese**, including earlier versions of this file.

## Relationship to the origin project

Birta Writer is a **hard fork** of [git-xing/md-wysiwyg-editor](https://github.com/git-xing/md-wysiwyg-editor) and is now developed fully independently. The `upstream` git remote has been **removed on purpose** — the only live remote is `origin` (`harlanlewis/birta-writer`).

- **Never re-add an `upstream` remote, and never fetch, merge, cherry-pick, or push to `git-xing/md-wysiwyg-editor`.** The fork diverged long ago (hundreds of commits, plus the Chinese→English migration and the rebrand); pulling from it would drag back exactly what this project is moving away from.
- The original is retained as a reference for **attribution and licensing only** — see `README.md` ("Why this fork"), `NOTICE`, and `LICENSE-MIT`. That is the sole reason its name still appears anywhere in the repo (the brand-guard test in `shared/__tests__/noLegacyBrand.test.ts` deliberately allows the `git-xing/...` slug while banning our own former one).

## Project basics

- **Package manager**: use `pnpm` only. No npm/yarn.
- **Build**: run `pnpm build` after changing code to confirm it compiles.
- **Debug**: press F5 to launch an Extension Development Host (`.vscode/launch.json`).
- **Language/tooling**: all TypeScript. Extension side uses `tsconfig.json`; webview side uses `tsconfig.webview.json`.
- **Dual-target build**: `dist/extension.js` (Node.js) + `dist/webview.js` (browser), produced by `esbuild.mjs`.
- **Syntax level**: modern JS/CSS is fine (native CSS nesting, `:has()`, optional chaining, top-level `await`, etc.). No need to down-level for old browsers/runtimes — the only runtimes are Electron (VS Code) and Node 18, and esbuild (`target: es2020`) transpiles as needed at build time. Prefer concise modern syntax such as nesting.
- **Packaging/release**: the VSIX must be written to `releases/`. Command: `pnpm run package`.
- **Git commit convention**: keep the English type prefix (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `release:`) and write the description in **English**. e.g. `feat: add image upload`, `fix: correct table drag offset`.
  - **Cite the Linear issue when a commit closes tracked work.** End the commit body with a `Closes MAR-NN` line (one per issue; use `Closes MAR-NN, MAR-MM` or several lines for a commit that lands more than one). This is the commit→issue link that keeps the backlog honest — without it a shipped fix can sit `In Progress` indefinitely because nothing points from the code back to the ticket. **Never bury a tracked fix inside a large omnibus commit without naming its issue** — that is exactly how MAR-36's already-shipped DnD rewrite went unnoticed for days inside a multi-feature `feat:` commit.

### End-of-work handoff (ALWAYS)

Whenever a work session changes extension or webview source (`src/`, `webview/`, `shared/`, `package.json`), finish by making the build testable in the user's own editor with zero extra steps for them:

1. `pnpm test` — all green.
2. **Update `CHANGELOG.md`** if the change is **observable by a user** — a new capability, a changed or removed behavior/setting, or a user-visible bug fix. Add or amend an entry under `## [Unreleased]` in the correct Keep a Changelog section (`Added` / `Changed` / `Removed` / `Fixed`; `Deprecated` / `Security` when they apply), written for a user of the editor — the observable behavior and any `birta.*` setting keys, not the internal plugins or APIs. **The gate is observability, not effort**: a speed-up a user can feel is `Changed`; an invisible refactor, internal perf change, tooling, test, or dependency bump is omitted (it's in git). Order entries by significance within a section, and flag a breaking change inline — but **don't add a Highlights section yourself**; the release-notes generator lifts the top items into Highlights (full taxonomy: `docs/RELEASING.md` → *What goes in*). This is the one step you can't reconstruct later, so do it while the change is fresh.
3. **Review `docs/BENEFITS.md`** and, if appropriate, edit it. Unlike the CHANGELOG (an append-only log), this is a refined document — if the change altered a capability the doc describes, its fidelity/safety story, or the tool-compatibility table, revise the relevant entry *in place* to keep it accurate; don't append a new one. Most changes won't touch it — skip it when the benefits/compatibility story is unchanged. Keep the tone matter-of-fact: state what the capability is and *why* it matters, never marketing copy.
4. `pnpm run package` — local packaging always writes `releases/birta-writer-0.0.0.vsix` (`package.json` is pinned at `0.0.0`; real CalVer versions are stamped only by the CI `Release` job — see [`docs/RELEASING.md`](docs/RELEASING.md)).
5. Install into VS Code so it's on the new build, and make sure Birta is the **only** copy of this editor installed:
   - `code --install-extension releases/birta-writer-0.0.0.vsix --force`
   - Remove any pre-rebrand build so VS Code never runs two copies over the same `.md` files: `code --uninstall-extension harlanlewis.md-wysiwyg-editor` (ignore a "not installed" message — it just means the cleanup already happened). Then confirm exactly one remains: `code --list-extensions | grep -iE 'birta|wysiwyg'` should print only `harlanlewis.birta-writer`.

   Both `--force`-installing `harlanlewis.birta-writer` and uninstalling the old `harlanlewis.md-wysiwyg-editor` id leave the user's `settings.json` untouched, so their Birta config (`birta.*` keys) carries across every reinstall — never edit or delete their settings as part of an install. `--force` allows reinstalling the same version. The VS Code `code` CLI is often not on `PATH` on this machine even though VS Code is installed — fall back to the app-bundle binary `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension … --force` (and `… --uninstall-extension …`). Only if VS Code truly isn't installed, skip it and say so rather than failing the handoff.
6. End your reply by telling the user to reload: Cmd+Shift+P → "Developer: Reload Window".

Do this by default, without being asked, before handing control back. Don't touch `package.json`'s version to mark a build — it stays `0.0.0`; the window reload is what confirms the new build is live.

### Trying changes in the user's editor (VS Code)

`pnpm build` only rebuilds `dist/`; the user's editor runs an **installed copy** of the extension, so a window reload alone never picks up source changes. When the user wants to try changes in their own VS Code window (rather than F5 debugging):

1. `pnpm test` — must pass first.
2. `pnpm run package` — writes `releases/birta-writer-0.0.0.vsix` (local builds are always `0.0.0`; see the handoff note above).
3. Install into VS Code (`--force` allows reinstalling the same version), and clear out any legacy build so only one copy runs:
   - `code --install-extension releases/birta-writer-0.0.0.vsix --force`
   - `code --uninstall-extension harlanlewis.md-wysiwyg-editor` (ignore "not installed"). Neither step touches the user's `settings.json`, so their `birta.*` config persists.
4. Tell the user to reload: Cmd+Shift+P → "Developer: Reload Window".

For iterative debugging, F5 (Extension Development Host) is still faster — no packaging step.

---

## Key file map

```
src/extension.ts                              — Extension entry; registers CustomEditorProvider
src/MarkdownEditorProvider.ts                 — Provider core (message routing, autosave, revert)
src/utils/getNonce.ts                         — CSP nonce generation
src/utils/imageService.ts                     — Local image save (MD5 dedup) + server upload
webview/index.ts                              — WebView entry
webview/editor.ts                             — Milkdown editor init (incl. keymap plugins)
webview/serialization.ts                      — Serializer config (stringify options, table handler, pure-markdown preset)
webview/utils/minimalDiff.ts                  — Minimal-diff merge of serializer output into the saved file
webview/messaging.ts                          — WebView ↔ Extension message protocol (the only comms layer)
webview/style.css                             — VS Code theming (--vscode-* CSS variables)
webview/i18n/index.ts                         — t() / kbd() translation functions
webview/ui/icons.ts                           — SVG icons
webview/ui/tooltip.ts                         — Tooltip component
webview/components/toolbar/index.ts           — Top main toolbar
webview/components/selectionToolbar/index.ts  — Floating selection toolbar
webview/components/table/tableView.ts         — Table NodeView (overlay chrome: grips, insert bars, drag-reorder)
webview/components/table/reorder.ts           — Pure row/column block-reorder + drop-index helpers
webview/components/codeBlock/index.ts         — Code block UI
webview/components/toc/index.ts               — Table of contents (TOC) panel
webview/components/linkPopup/index.ts         — Link hover popup
webview/components/imageView/index.ts         — Image NodeView (selection/lightbox/toolbar)
```

---

## Architecture constraints

- **UI/UX principles live in `docs/DESIGN_PRINCIPLES.md`** — decoration semantics (strikethrough = "delete this", dotted underline = "reconsider", color = source), the "annotation is advisory, reversible, and quiet" rules, and gutter/theming conventions. Check a new affordance against it before adding a visual channel.
- WebView ↔ Extension communication goes **only through** the wrappers in `webview/messaging.ts`.
- The webview side never `import`s the VS Code API directly; it gets a handle via `acquireVsCodeApi()`.
- CSS must use `--vscode-*` variables so light/dark themes both work. **No custom colors**: accents (selection, focus, drag chrome) use `var(--vscode-focusBorder)` with **no literal fallback** — inside VS Code the variable always exists (pinned/custom themes only *override* the native set, never remove it). Literal fallbacks for other `--vscode-*` variables are legacy; don't add new ones (repo-wide removal is tracked in Linear).
- Don't keep global state outside modules (singletons like the editor view are the exception).

## Launch performance

Webview cold-start (open `.md` → editor painted) is a first-class concern — it's also the cost of switching back from the raw editor, since VS Code disposes the webview on switch-away. Keep it fast:

- **Keep the launch bundle lean.** Anything not needed to render the *first paint* loads lazily, the moment the document actually needs it — mirror `webview/utils/katexLoader.ts` / `mermaidLoader.ts` (cached dynamic `import()`) and the lazy grammar chunk (`webview/highlighterLanguages.ts`). Don't add a static `import` of a heavy dependency into the eager graph.
- **Keep decoration/analysis work off the mount path.** Proofreading, and anything like it, is decoration only: it must never block the editor becoming interactive, and it should settle in *after* first paint (`requestIdleCallback`), never synchronously during create and never as a reaction to the user's first touch. A feature the user has disabled must cost nothing — no scan, no lazy dependency loaded.
- **Resolve bundled sibling assets against the entry `<script>`, not `import.meta.url`** — esbuild chunk splitting shifts modules between `dist/` and `dist/chunks/`, which silently breaks relative URLs (see `katexCssHref` in `katexLoader.ts`).

**Measure before and after — don't guess.** The harness (`e2e/perf/`, see its README) drives the real production bundle in headless Chromium and reads the `mdw:` User-Timing marks (`webview/perf.ts`):

- `pnpm perf` — median-of-9 launch spans per fixture (build `node esbuild.mjs --production --metafile` first).
- `pnpm perf:bundle` — zero-variance eager-bytes metric (the deterministic gate).
- The launch A/B is **same-session** (`pnpm perf --compare before.json after.json`) with a warmup run discarded — absolute ms drift on a laptop, so a `before.json` captured earlier is untrustworthy; stash the change, rebuild, capture `before`, restore, capture `after`. Treat a delta under ~3% (the noise floor) as neutral and lean on the eager-bytes metric instead.

## Issue tracking

All bugs and planned work live in **Linear** (team "Birta Writer", `MAR-` prefix) — never GitHub Issues, and never local files. The `MAR-` prefix predates the rebrand and is unchanged; the team name is what the Linear tools take, and querying a wrong one returns an empty list that reads exactly like an empty queue.

- **Known bug**: `#Bug` label; only for issues still unfixed after development.
- **Feature request**: `#Improvement` label; record maturity, implementation approach, and affected files.
- Filed via the `/devlog` skill (`.claude/skills/devlog/SKILL.md`), which also covers **closing, updating, and auditing** issues — triggers: "record a bug", "record a feature request", "close an issue", "audit the backlog", `/devlog`.

### Lifecycle (not just filing)

Keeping the backlog honest is as important as filing it. Close the loop when work ships:

- **When a commit ships tracked work, move its issue to `Done`** and leave a one-line comment citing the commit SHA(s). Never leave completed work sitting in `In Progress` or `Backlog`. Put a `Closes MAR-NN` line in the commit body too (see the Git commit convention above), so the link exists in both directions — the SHA in Linear, the issue id in git.
- **Audit for silently-shipped work.** When reviewing the backlog or picking up an `In Progress` issue, first check whether it already shipped — cross-reference recent large `feat:`/omnibus commits against open tickets (`git log --oneline` + read the diff, not just the subject). A tracked fix bundled into an unrelated commit is the classic way work gets done but never closed.
- **Verify against the code before closing — not the CHANGELOG alone.** A feature can ship with a different implementation than the ticket described; confirm the actual behavior/settings/files exist in the working tree.
- **The CHANGELOG and Linear are complementary, not a single source of truth.** The CHANGELOG records what *shipped* (including untracked work); Linear tracks *planned* work and bugs. When you ship a tracked feature, do both: close the issue **and** add the CHANGELOG entry. "Not in Linear" never means "not shipped."
- **Sequencing signal**: the `phase-*` labels are the roadmap spine (`phase-0-fidelity` is existential — round-trip trust — and comes first; then `phase-2-syntax`, `phase-3-interaction`, `phase-4-differentiators`). Within a phase, order by `priority`. `phase-1-vscode-parity` is largely retired (shipped in 0.2.3).
- **Periodically reconcile**: when asked what's next or to review the backlog, cross-check open issues against the CHANGELOG and git history, close anything already shipped, and re-scope tickets whose premise the code has outgrown.

Project intent and ordering principles live in `README.md` ("Why this fork"); the brand brief and the Birta Writer naming decision are recorded in `docs/POSITIONING.md` (full candidate/rejection record in Linear MAR-134).

---

## Testing

### Stack
| Layer | Framework | Scope |
|-------|-----------|-------|
| Extension unit tests | **Vitest 2.x** (Node env) | `src/utils/`, `src/MarkdownEditorProvider.ts` |
| WebView unit tests | **Vitest 2.x + jsdom 24.x** | `webview/utils/`, `webview/messaging.ts` |
| Integration tests | **@vscode/test-electron + Mocha** | `src/test/` — real Extension Host: activation, `onWillSaveTextDocument`/`waitUntil` reaching disk, the custom-editor save cycle with a live webview |

The `vscode` module is mocked centrally via `__mocks__/vscode.ts`, injected by `resolve.alias` in `vitest.config.ts`. Do not `vi.mock("vscode")` in individual test files.

**Integration vs unit boundary:** unit tests mock `vscode` and cover the flush *protocol* logic (seq ordering, stale rejection, timeout) against a controllable fake webview; integration tests run in a downloaded VS Code and verify the behaviors a mock can't — that VS Code fires our will-save participant and applies its `TextEdit[]` to disk, and, driving the **real Milkdown editor**, that an edit living only in the webview is carried to disk by the save flush (the original data-loss bug, end-to-end). That last test uses `birta._test.insertText` — an **invisible, uncontributed, test-only** command that posts `__testInsertText` to the active webview; it is inert in production (no product code path invokes it). Webview *behavior* is otherwise exercised by the `e2e/` Chromium harness. The integration suite (`src/test/**`) compiles via `tsconfig.integration.json` to `out/` and is excluded from Vitest and the perf harness; it downloads VS Code on first run (cached in `.vscode-test/`, gitignored) and is **not** part of `pnpm test` — run it explicitly.

### Test commands

```bash
pnpm test              # run all unit tests once (Vitest)
pnpm test:watch        # watch mode (during development)
pnpm test:coverage     # run tests + coverage report (coverage/)
pnpm test:integration  # build + compile + run the real-VS-Code suite (downloads VS Code first run)
```

### Layout & naming

```
src/__tests__/              — Extension-side unit tests (Node env)
webview/__tests__/          — WebView-side unit tests (jsdom env)
webview/__tests__/setup.ts  — jsdom global setup (injects acquireVsCodeApi)
shared/__tests__/           — Shared-type tests
__mocks__/vscode.ts         — Central vscode API mock
```

- Test files are named `<module>.test.ts`, matching the module under test.
- Follow **AAA** (Arrange / Act / Assert), with two levels: `describe` → `it`.
- `it` descriptions use the form: `<input condition> should <expected result>` (in English).

### Coverage floors

| Module | Min line coverage |
|--------|-------------------|
| `src/utils/imageService.ts` | ≥ 85% |
| `src/utils/getNonce.ts` | 100% |
| `src/utils/textEdit.ts` | ≥ 90% |
| `src/utils/contentTransform.ts` | ≥ 90% |
| `src/utils/lineMap.ts` | ≥ 90% |
| `webview/utils/slug.ts` | ≥ 90% |
| **Overall** | ≥ 70% |

### Required workflow

#### After feature work
1. Write unit tests (at least one case each for core logic, boundary values, and error paths).
2. Run `pnpm test` and confirm all pass.
3. Run `pnpm build` and confirm it compiles.
4. Only then `git commit`.

#### After a bug fix
1. First add a **test that reproduces the bug** (in the same commit as the fix).
2. Confirm it fails before the fix and passes after.
3. Run `pnpm test` and confirm the whole suite passes before committing.

#### Before `git push`
- You **must** run `pnpm test`; push only if everything passes.
- CI's `unit-test` job runs on every push/PR (`.github/workflows/ci.yml`); a failure blocks the build.

### Handling test failures

```
Test fails
  │
  ├─ Newly introduced failure?      → locate the code change, fix, re-run
  │
  ├─ Test expectation no longer     → update the test (only if the change was intentional)
  │   matches intended behavior?
  │
  └─ Environment/dependency issue?  → check jsdom version, verify the vscode mock is complete
```

**Prohibited:**
- Do not skip (`it.skip`) or comment out failing tests to make CI pass.
- Do not change expected values to mask a bug (unless the implementation changed intentionally and was reviewed).
- Do not push to `main` or `dev` without running tests.

### Mock rules

- Call `vi.clearAllMocks()` in `beforeEach` for each `describe` block.
- Mock filesystem operations via `vscode.workspace.fs` (never write to the real disk).
- For time-dependent logic use `vi.useFakeTimers()` / `vi.useRealTimers()`; never wait on a real `setTimeout`.
- Don't test `private` methods; verify behavior through the public interface.

---

## Autosave

The editor is `CustomTextEditorProvider`-backed, so the backing `TextDocument`
carries native dirty state. **Saving is governed entirely by VS Code's built-in
`files.autoSave` / `files.autoSaveDelay`** — there is no extension-specific
autosave. (The former `markdownWysiwyg.autoSave` / `autoSaveDelay` settings
were removed before the rename; the custom timer only ever fired in configurations where it was
redundant or actively fought the user's `files.autoSave` choice.) With the VS
Code default (`files.autoSave: "off"`), edits stay dirty until Cmd+S / hot exit,
exactly like any text editor.

### View→document sync invariant (never lose an edit on save)

The edit lives in the webview (Milkdown); the `TextDocument` is what VS Code
saves. The pipeline that carries edits webview→document must satisfy, in order of
priority:

1. **A save never persists content older than the editor state.** The extension
   registers `onWillSaveTextDocument` and, via `waitUntil`, asks the webview to
   serialize the live document *now* and returns those bytes as the save's edits
   (`_flushWebviewEdits` / `flushPendingEdit`). A save is bounded by a ~1s timeout
   so a wedged webview degrades to "save current document" rather than hanging.
2. **An edit is save-capturable the moment the user perceives it.** The first
   edit after a save dirties the `TextDocument` within an IPC hop (leading-edge
   sync in `webview/editor.ts`) — `onWillSaveTextDocument` only fires for a dirty
   document, so this is what makes a fast Cmd+S actually save.
3. **Ordering is total.** Every outbound content message carries a monotonic
   `seq`; the extension drops any `update` a flush has superseded, so a slow
   in-flight sync can never revert a newer save (`_appliedSeq`).

The webview→document **debounce is load-bearing for crash-safety, not
performance**: it bounds how far the `TextDocument` (which hot exit backs up)
trails the editor. Serialization is O(document size); it runs off the keystroke
path (on typing pause / max-wait / save), never per keystroke. Do not lengthen
the debounce toward "save less often" or move serialization back onto the
keystroke — the first breaks the crash-safety window, the second reintroduces
per-keystroke O(n) cost. (Note: on very large documents typing itself is still
bounded by ProseMirror's per-keystroke view reconciliation — a separate,
document-size-scaling cost unrelated to this sync pipeline.)

**`webview/syncScheduler.ts` must be the ONLY delay in this pipeline.** Its
trigger is `webview/plugins/docChange.ts`, which reports every doc-changing
transaction synchronously. Never put a debounce/throttle upstream of it, and
never route the trigger through one — Milkdown's `@milkdown/plugin-listener`
(unconditional trailing `debounce(fn, 200)`) used to sit there and broke two of
the three invariants above at once: the first keystroke took ~208 ms to dirty
the document (#2), and because a *trailing* debounce resets on every keystroke,
continuous typing never fired it at all, so the scheduler was never asked, its
max-wait never engaged, and the document stayed clean for the whole burst — a
Cmd+S mid-burst was a no-op and hot exit backed up stale bytes (MAR-145). The
scheduler already implements leading edge + trailing + max-wait together; a
second timer upstream can only starve it. Pinned by `e2e/syncLatency`.
