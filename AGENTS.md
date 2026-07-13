# Repository Guidelines

## Language Policy

The maintainer reads and writes **English only**. This project is being migrated from Chinese to English; every change should move it further in that direction and never add new non-English content. Reply to the user in English. Write all new comments, identifiers, commit messages, docs, and test descriptions in English, and translate any Chinese you touch into English as you go. This supersedes any older instruction in this repo that mandates Chinese.

## Project Structure & Module Organization

This is a VS Code extension for a WYSIWYG Markdown editor. Extension-host code lives in `src/`, including `extension.ts`, `MarkdownDocument.ts`, and utilities under `src/utils/`. Webview/browser code lives in `webview/`, with reusable UI modules in `webview/components/`, shared browser helpers in `webview/ui/`, and i18n helpers in `webview/i18n/`. Cross-boundary message types belong in `shared/`. Tests are colocated in `src/__tests__/` and `webview/__tests__/`; VS Code API mocks are in `__mocks__/`. Localized strings are in `package.nls*.json` and `l10n/`, while static extension assets are in `images/`.

## Build, Test, and Development Commands

Use pnpm, not npm or yarn.

- `pnpm install` installs dependencies using `pnpm-lock.yaml`.
- `pnpm build` bundles the extension and webview via `esbuild.mjs` into `dist/`.
- `pnpm watch` starts an incremental esbuild watcher for development.
- `pnpm test` runs all Vitest suites once.
- `pnpm test:watch` runs Vitest in watch mode.
- `pnpm test:coverage` generates V8 coverage reports.
- `pnpm package` creates a VSIX under `releases/`.

For manual testing, press F5 in VS Code to launch an Extension Development Host.

## Coding Style & Naming Conventions

Write strict TypeScript. Follow `.editorconfig`: UTF-8, LF, spaces, 4-space indentation, final newline, and trimmed trailing whitespace except in Markdown. Use camelCase for variables/functions and PascalCase for classes/providers. Keep webview-to-extension communication routed through `webview/messaging.ts`; update `shared/messages.ts` when payload contracts change. Webview CSS should use `--vscode-*` variables for theme compatibility.

## Testing Guidelines

Vitest is the test runner. Extension tests run in Node; webview tests run in jsdom with `webview/__tests__/setup.ts`. Name files `*.test.ts`, for example `src/__tests__/markdownDocument.test.ts` or `webview/__tests__/slug.test.ts`. Coverage targets `src/utils/**/*.ts`, `src/MarkdownDocument.ts`, and `webview/utils/**/*.ts`, with 70% line and function thresholds.

## Launch Performance

Webview cold-start (open `.md` → editor painted) is a first-class concern. Keep the launch bundle lean: anything not needed for first paint loads lazily the moment the document needs it (mirror `webview/utils/katexLoader.ts` / `mermaidLoader.ts` and the lazy grammar chunk), and keep decoration/analysis work (e.g. proofreading) off the mount path — deferred to `requestIdleCallback`, never synchronous during create, and costing nothing when disabled. Measure with `pnpm perf` (median launch spans) and `pnpm perf:bundle` (eager bytes) against the real production build; the launch A/B is same-session with a warmup discard (absolute ms drift on a laptop). See `e2e/perf/README.md`.

## Commit & Pull Request Guidelines

Git history uses English type prefixes; older commits have Chinese descriptions, but **new commits must use English descriptions** (see the Language Policy). Prefer concise conventional prefixes such as `feat:`, `fix:`, `chore:`, `test:`, and `release:`, e.g. `fix: resolve workflow pnpm version conflict`, `chore: bump version to 0.1.0`, `release: v0.1.6`. Create branches from `dev` when contributing. Pull requests should target `dev`, describe the user-facing change, list verification commands such as `pnpm build` and `pnpm test`, link issues when relevant, and include screenshots or GIFs for webview UI changes.

## Security & Configuration Tips

Do not commit generated VSIX files unless intentionally releasing. Avoid hard-coding image server credentials or local filesystem paths; use `birta.*` settings declared in `package.json` for configurable behavior.
