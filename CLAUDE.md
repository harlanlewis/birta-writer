# Claude project instructions — md-wysiwyg-editor

## Language policy

The maintainer reads and writes **English only**. This project is being migrated from Chinese to English, and every change should move it further in that direction — never back.

- **Reply to the user in English.** Never reply in Chinese, Korean, or any other language.
- **Every edit must move the codebase toward English, never away from it:**
  - Write all new code comments, identifiers, commit messages, docs, test descriptions, and log/`console` strings in English.
  - When you touch a file that still contains Chinese (comments, strings, docs), translate the parts you touch into English as you go. Leave the rest rather than doing unrelated mass rewrites, but never add new non-English content.
  - For user-facing UI text, keep the i18n system intact but treat English as the source/base language.
- This policy **supersedes any older instruction in this repo that mandates Chinese**, including earlier versions of this file.

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
2. **Update `CHANGELOG.md`** if the change added, altered, or removed any user-visible behavior or setting: add or amend an entry under `## [Unreleased]`, in the correct Keep a Changelog section (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed`). Write it for a user of the editor — describe the observable behavior and any setting keys, not the internal plugins or APIs involved. Skip only for changes with no user-facing effect (refactors, tests, tooling, comments). This is the one step you can't reconstruct later, so do it while the change is fresh.
3. `pnpm run package`
4. `cursor --install-extension releases/md-wysiwyg-editor-<version>.vsix --force`
5. End your reply by telling the user to reload: Cmd+Shift+P → "Developer: Reload Window".

Do this by default, without being asked, before handing control back. Bump the patch version when it helps the user confirm they're on the new build.

### Trying changes in the user's editor (Cursor)

`pnpm build` only rebuilds `dist/`; the user's editor runs an **installed copy** of the extension, so a window reload alone never picks up source changes. When the user wants to try changes in their own Cursor window (rather than F5 debugging):

1. `pnpm test` — must pass first.
2. `pnpm run package` — writes `releases/md-wysiwyg-editor-<version>.vsix`.
3. `cursor --install-extension releases/md-wysiwyg-editor-<version>.vsix --force` (`--force` allows reinstalling the same version).
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

- WebView ↔ Extension communication goes **only through** the wrappers in `webview/messaging.ts`.
- The webview side never `import`s the VS Code API directly; it gets a handle via `acquireVsCodeApi()`.
- CSS must use `--vscode-*` variables so light/dark themes both work.
- Don't keep global state outside modules (singletons like the editor view are the exception).

## Issue tracking

All bugs and planned work live in **Linear** (team "Markdown Editor", `MAR-` prefix) — never GitHub Issues, and never local files.

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

Project intent and ordering principles live in `README.md` ("Why this fork").

---

## Testing

### Stack
| Layer | Framework | Scope |
|-------|-----------|-------|
| Extension unit tests | **Vitest 2.x** (Node env) | `src/utils/`, `src/MarkdownEditorProvider.ts` |
| WebView unit tests | **Vitest 2.x + jsdom 24.x** | `webview/utils/`, `webview/messaging.ts` |
| Integration tests (planned) | **@vscode/test-electron + Mocha** | needs a real VS Code Extension Host |

The `vscode` module is mocked centrally via `__mocks__/vscode.ts`, injected by `resolve.alias` in `vitest.config.ts`. Do not `vi.mock("vscode")` in individual test files.

### Test commands

```bash
pnpm test              # run all unit tests once
pnpm test:watch        # watch mode (during development)
pnpm test:coverage     # run tests + coverage report (coverage/)
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

## Autosave settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdownWysiwyg.autoSave` | boolean | `true` | Write to disk automatically after edits |
| `markdownWysiwyg.autoSaveDelay` | number | `1000` | Debounce delay (ms) |
