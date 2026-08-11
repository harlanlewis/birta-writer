# Grind config: birta-writer

Bindings for the shared `/grind` loop (harlanlewis plugin). Deltas only.

## Tracker

- Linear team `MAR`.
- Board guide: `MAR-141`. Verify against `git log` and the tree; work its do-inline ledger when a session touches a line's area, and prune lines sessions have worked past.
- Maintainer-only kinds: none.

## Gates

- Per commit: `pnpm test`, `pnpm typecheck`, `pnpm build`, plus `pnpm test:e2e` if `webview/` was touched. One harness at a time.
- Merge gate: `pnpm test && pnpm typecheck`
- Visual pass: /verify for runtime behavior beyond jsdom.

## Landing

- One PR per session with the tickets and the verification done; wait for CI, squash, delete branch, pull `main`.
- Merging deploys: no.

## Lanes

- The default shape; ceiling 2, because the harness lock is machine-wide, refuses rather than queues (the loser exits 2 naming the holder), and a lane's gates are the bulk of its wall clock: a third lane spends its time failing gates and retrying. The ceiling prices the machine, not the session, so a live peer session's lanes (`ListAgents`) count against it. Integration branch `lewish/<slug>`.
- Hot files: `webview/editor.ts`, `serialization.ts`, `utils/minimalDiff.ts`, the fold plugins.
- Orchestrator-only files: `CHANGELOG.md`, `docs/BENEFITS.md`, written once over the reconciled diff, plus BENEFITS only if a capability's story changed.
- Exclusive resources: browser perf captures (`perf:*`). The machine is idle exactly twice, at the start and at reconciliation; `perf:bundle` is browser-free and fine, node-level micro-measurement survives.
- The repo pre-commit guard trips when the orchestrator commits in the primary checkout while lanes are live; `--no-verify` is its documented override after `git status --short` confirms disjoint paths.

## Priority doctrine

First High-or-Urgent down the spine: `phase-0-fidelity` → `phase-1-performance` → `phase-2-syntax` → `phase-3-interaction` → `phase-4-differentiators`, then by priority. `phase-5-surfaces` never ranks (D8). With no High anywhere, the spine's top by priority. Holding the machine for one perf ticket blocks every other measurement-bound one, however highly it ranks.

## Repo law

Read before touching code: `AGENTS.md`, `docs/DESIGN_PRINCIPLES.md`.

## Repo lore

- On a perf ticket: four phase-1 tickets named a mechanism nobody profiled, and all four were wrong. Take a CDP sampling profile and fold native self-time into the nearest JS caller, or the top frames name no code you own.
- Restore a before from `git show main:<file>`, never `git checkout <file>`: once your fix is committed the latter restores the NEW code, both columns agree, and it reads as a null result. Assert the old code is loaded before believing the number. The same trap voids an A/B and a revert-to-attribute alike.
- A mutation run expires on your next edit: a branch added afterwards can leave a proven test unreachable, with nothing red. Re-run mutations in the final state; a late-added gate is the usual culprit.
- On an integration-suite red, A/B two axes before triage: the tree (base vs branch) and the VS Code build (`BIRTA_ITEST_VSCODE`). Four runs isolated MAR-353 to a stable-channel change; either axis alone would have misattributed it. The census lesson ("evidence only about what it enumerated") lives in MAR-141.
- Vitest: read the `Errors:` line of a passing run, not just `Tests:`. Unhandled errors exit non-zero with every test green. `pnpm typecheck` excludes `**/__tests__/**` by design, so a changed export signature stays green through typecheck and build and surfaces only as whatever the wrong value does at runtime, which on a fidelity gate reads as a corruption regression.
- A simulation can reproduce a ticket's numbers exactly and still describe a state no gesture reaches. MAR-344's filed measurement forced a fallback on an unedited document, and a fallback only happens because an edit damaged the merge.
- A contended machine FABRICATES failures; MAR-141 carries the full shape. The short form: `[vitest-worker]: Timeout calling ...` voids the run, and reds scattered across suites your diff cannot reach are the tell. Check `uptime` first.
- A lane that adds dependencies reds the merge gate for a phantom reason: `merge-lane.sh` gates before anyone runs `pnpm install`, so the incoming import fails to resolve in the integration worktree. Install there, merge by hand, gate again. The durable fix belongs in the plugin's `merge-lane.sh`.
- `cd` persists between Bash calls, so inspecting a lane's worktree silently moves later commands, `git commit` included.
