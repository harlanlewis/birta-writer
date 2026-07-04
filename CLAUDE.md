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

### End-of-work handoff (ALWAYS)

Whenever a work session changes extension or webview source (`src/`, `webview/`, `shared/`, `package.json`), finish by making the build testable in the user's own editor with zero extra steps for them:

1. `pnpm test` — all green.
2. `pnpm run package`
3. `cursor --install-extension releases/md-wysiwyg-editor-<version>.vsix --force`
4. End your reply by telling the user to reload: Cmd+Shift+P → "Developer: Reload Window".

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
src/i18n/webviewTranslations.ts               — WebView translation data
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
webview/components/table/addButtons.ts        — Table insert lines
webview/components/table/handles.ts           — Table row/column drag handles
webview/components/table/toolbar.ts           — Table toolbar
webview/components/codeBlock/index.ts         — Code block UI
webview/components/toc/index.ts               — Table of contents (TOC) panel
webview/components/linkPopup/index.ts         — Link hover popup
webview/components/imageView/index.ts         — Image NodeView (selection/lightbox/toolbar)
docs/roadmap.md                               — Project roadmap
```

---

## Architecture constraints

- WebView ↔ Extension communication goes **only through** the wrappers in `webview/messaging.ts`.
- The webview side never `import`s the VS Code API directly; it gets a handle via `acquireVsCodeApi()`.
- CSS must use `--vscode-*` variables so light/dark themes both work.
- Don't keep global state outside modules (singletons like the editor view are the exception).

## Issue tracking

Known bugs and feature requests are filed as GitHub Issues via the `/devlog` skill rather than local files.

- **Known bug**: `bug` + `known-limitation` labels; only for issues still unfixed after development.
- **Feature request**: `enhancement` + `roadmap` labels; record maturity, implementation approach, and affected files.
- Skill definition: `.claude/skills/devlog/SKILL.md`.
- Triggers: the user says "record a bug", "record a feature request", or invokes `/devlog`.

Keep `docs/roadmap.md` in sync when phase progress changes.

---

## Testing

### Stack
| Layer | Framework | Scope |
|-------|-----------|-------|
| Extension unit tests | **Vitest 2.x** (Node env) | `src/utils/`, `src/MarkdownDocument.ts` |
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
| `src/MarkdownDocument.ts` | ≥ 80% |
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
