# Grind config: birta-writer

Bindings for the shared `/grind` loop (harlanlewis plugin). Deltas only.

## Tracker

- Linear team `MAR`.
- No board guide. Derive the queue from Linear at the start of every session: the groomed union of `Todo`, `In Progress` and `Backlog`, ordered by the doctrine below. A stored ordering is a cache, and a stale one reads exactly like a considered one.
- Maintainer-only kinds: none.

## Findings

A durable finding goes to exactly one of three places, chosen by what would catch the mistake next time: a line in `AGENTS.md`, a guard test, or a comment at the seam it constrains. Each of those is read or run on its own schedule, so a wrong one gets found.

Nothing goes into a shared session narrative, and this file is not one. A document only sessions append to has no bound. Every line in it is true, every line describes something that really happened, and no session will delete another session's true sentence, so it grows until nobody reads it and its errors outlive the code they describe.

A war story is not a finding. The finding is the sentence that changes what the next session does; if it cannot be written as that sentence, it belongs to the PR body and `git log`.

## Gates

- Per commit: `pnpm test`, `pnpm typecheck`, `pnpm build`, plus `pnpm test:e2e` if `webview/` was touched. One harness at a time.
- Merge gate: `pnpm test && pnpm typecheck`
- Visual pass: /verify for runtime behavior beyond jsdom.

## Landing

- One PR per session with the tickets and the verification done. The session completes the merge: wait for CI, squash, delete branch, pull `main`, and end there.
- Merging deploys: no.
- `pnpm run install:local` is the LAST act, after the pull, and then tell the user to reload. `AGENTS.md`'s end-of-work handoff already requires it and does not say when, which reads as "some time during the session": run it before the merge and the user reloads into whatever the tree held at that moment. A session that keeps working afterwards, as every session does, hands them a build its own later commits contradict. Install from the merged default branch or the install is a lie about what shipped.

## Lanes

- The default shape; ceiling 2, because the harness lock is machine-wide, refuses rather than queues (the loser exits 2 naming the holder), and a lane's gates are the bulk of its wall clock: a third lane spends its time failing gates and retrying. The ceiling prices the machine, not the session, so a live peer session's lanes (`ListAgents`) count against it. Integration branch `lewish/<slug>`.
- Session target: 7 to 9 tickets. The ceiling is on concurrency, never throughput: two lanes refilled four times is the shape of a session, not a budget of two tickets.
- Hot files: `webview/editor.ts`, `serialization.ts`, `utils/minimalDiff.ts`, the fold plugins.
- Orchestrator-only files: `CHANGELOG.md`, `docs/BENEFITS.md`, written once over the reconciled diff, plus BENEFITS only if a capability's story changed.
- Exclusive resources: browser perf captures (`perf:*`). The machine is idle exactly twice, at the start and at reconciliation; `perf:bundle` is browser-free and fine, node-level micro-measurement survives.
- The repo pre-commit guard trips when the orchestrator commits in the primary checkout while lanes are live; `--no-verify` is its documented override after `git status --short` confirms disjoint paths.

## Priority doctrine

`AGENTS.md`, "Sequencing", carries the doctrine and it is not restated here. One binding that section does not carry: holding the machine for one perf ticket blocks every other measurement-bound one, however highly it ranks.

## Repo law

Read before touching code: `AGENTS.md`, `docs/DESIGN_PRINCIPLES.md`.

## Repo lore

Procedures a session cannot derive from the tree. Anything that reads as an account of how a bug was found belongs in `git log`, not here.

- On a perf ticket: take a CDP sampling profile and fold native self-time into the nearest JS caller, or the top frames name no code you own. Calibrate a CI gate from a CI run rather than from a laptop, whose spans are steadier than a runner's.
- The variable under test must be the only difference between the two reads. Restore a before from `git show main:<file>`, never `git checkout <file>`, which restores the new code once your fix is committed so both columns agree and it reads as a null result. For a UI count the contaminant is leftover state rather than the tree: run the after-gesture once before taking the baseline.
- A mutation run expires on your next edit: a branch added afterwards can leave a proven test unreachable, with nothing red. Re-run mutations in the final state; a late-added gate is the usual culprit.
- On an integration-suite red, A/B two axes before triage: the tree (base vs branch) and the VS Code build (`BIRTA_ITEST_VSCODE`). Either axis alone misattributes an upstream channel change (MAR-353).
- Vitest: read the `Errors:` line of a passing run, not just `Tests:`. Unhandled errors exit non-zero with every test green. `pnpm typecheck` excludes `**/__tests__/**` by design, so a changed export signature stays green through typecheck and build and surfaces only as whatever the wrong value does at runtime.
- Exit 2 is ambiguous. The harness lock refuses with it, and `pnpm perf:bundle` also exits 2 when the metafile is absent, so a lane retrying "only on exit 2" can loop on a failure no wait will clear. Read the message rather than the code, and build with `node esbuild.mjs --production --metafile` first.
- `cd` persists between Bash calls, so inspecting a lane's worktree silently moves later commands. The worktree hook does NOT cover this: it refuses git aimed elsewhere (`-C`, a path argument) and any command too compound to verify, so multi-step shell splits into plain calls, but a bare `cd` passes it and every later command runs in the new directory.
- A lane that adds dependencies reds the merge gate for a phantom reason: `merge-lane.sh` gates before anyone runs `pnpm install`, so the incoming import fails to resolve in the integration worktree. Install there, merge by hand, gate again. The durable fix belongs in the plugin's `merge-lane.sh`.
