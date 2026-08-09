# Grind config: birta-writer

Bindings for the shared `/grind` loop (harlanlewis plugin). Deltas only.

## Tracker

- Linear team `MAR`.
- Board guide: `MAR-141`. Verify against `git log` and the tree; work its do-inline ledger when a session touches a line's area, and prune lines sessions have worked past.
- Maintainer-only kinds: none. Never close maintainer-authored ideas to hit a quota.

## Gates

- Per commit: `pnpm test`, `pnpm typecheck`, `pnpm build`, plus `pnpm test:e2e` if `webview/` was touched. One harness at a time.
- Merge gate: `pnpm test && pnpm typecheck`
- Visual pass: /verify for runtime behavior beyond jsdom.

## Landing

- One PR per session with the tickets and the verification done; wait for CI, squash, delete branch, pull `main`.
- Merging deploys: no.

## Lanes

- The default shape; ceiling 2, because the harness lock serializes every lane at every gate. A lane's gates are the bulk of its wall clock (`pnpm test` plus `pnpm test:e2e`), the lock is machine-wide rather than per worktree, and it refuses rather than queues: the loser exits 2 naming the holder, so a third lane spends its time failing gates and retrying them rather than waiting politely. Integration branch `lewish/<slug>`.
- Hot files: `webview/editor.ts`, `serialization.ts`, `utils/minimalDiff.ts`, the fold plugins.
- Orchestrator-only files: `CHANGELOG.md`, `docs/BENEFITS.md`, written once over the reconciled diff, plus BENEFITS only if a capability's story changed.
- Exclusive resources: browser perf captures (`perf:*`). The machine is idle exactly twice, at the start and at reconciliation; `perf:bundle` is browser-free and fine, node-level micro-measurement survives.
- The repo pre-commit guard trips when the orchestrator commits in the primary checkout while lanes are live; `--no-verify` is its documented override after `git status --short` confirms disjoint paths.

## Priority doctrine

First High-or-Urgent down the spine: `phase-0-fidelity` → `phase-1-performance` → `phase-2-syntax` → `phase-3-interaction` → `phase-4-differentiators`, then by priority. `phase-5-surfaces` never ranks (D8). With no High anywhere, the spine's top by priority. Holding the machine for one perf ticket blocks every other measurement-bound one, however highly it ranks.

## Repo law

Read before touching code: `AGENTS.md`, `docs/DESIGN_PRINCIPLES.md`.

## Repo lore

- Every CHANGELOG sentence is one you checked; it describes the product to someone who can't read the diff.
- On a perf ticket: four phase-1 tickets named a mechanism nobody profiled, and all four were wrong. Take a CDP sampling profile and fold native self-time into the nearest JS caller, or the top frames name no code you own.
- Restore a before from `git show main:<file>`, never `git checkout <file>`: once your fix is committed the latter restores the NEW code, both columns agree, and it reads as a null result. Assert the old code is loaded before believing the number. The same trap voids an A/B and a revert-to-attribute alike.
- Vitest: read the `Errors:` line of a passing run, not just `Tests:`. Unhandled errors exit non-zero with every test green.
- A contended machine FABRICATES failures. The tell is shape: one red each across unrelated suites, moving between runs, in files your diff cannot reach. `[vitest-worker]: Timeout calling ...` is a runner RPC timeout, not a result, so treat that run as void. Check `uptime` before believing a red; AGENTS.md carries the measured spread.
- `cd` persists between Bash calls, so inspecting a lane's worktree silently moves later commands, `git commit` included.
