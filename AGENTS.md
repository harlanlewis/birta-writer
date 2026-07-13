# Repository Guidelines

The authoritative agent and contributor instructions for this repository live in
[`CLAUDE.md`](CLAUDE.md). Read it first — it is kept current; this file is only a
pointer so tools that look for `AGENTS.md` find their way there.

`CLAUDE.md` covers, in depth:

- **Language policy** — English only; every change moves the codebase further
  from its Chinese origins, never back.
- **Project basics & build** — `pnpm` only, dual-target esbuild, the
  build/install/reload handoff, and the `docs/BENEFITS.md` review step.
- **Key file map** — where the extension host (`src/`) and webview (`webview/`)
  modules live.
- **Architecture constraints** — the `webview/messaging.ts` boundary, `--vscode-*`
  theming, no stray global state.
- **Launch performance** — keeping cold-start fast, and how to measure it
  (`e2e/perf/README.md`).
- **Issue tracking** — bugs and planned work live in Linear (`MAR-` prefix), via
  the `/devlog` skill.
- **Testing** — Vitest layout, the central `vscode` mock, coverage floors, and
  the required after-feature / after-bug-fix workflows.

Design and UX conventions live in [`docs/DESIGN_PRINCIPLES.md`](docs/DESIGN_PRINCIPLES.md);
product intent and the tool-compatibility picture live in [`README.md`](README.md)
and [`docs/BENEFITS.md`](docs/BENEFITS.md).
