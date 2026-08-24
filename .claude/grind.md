# Grind config: birta-writer

Bindings for the shared `/grind` loop (harlanlewis plugin). Deltas only.

## Tracker

- Linear team `MAR`.
- Derive the queue from Linear at the start of every session: the groomed union of `Todo`, `In Progress` and `Backlog`, ordered by the doctrine below. A stored ordering is a cache, and a stale one reads exactly like a considered one.
- `git fetch` BEFORE you groom, not just before you open the PR. Grooming reads the tree to decide what has silently shipped, and an unfetched `main` answers that question about a tree hours old; `git log` looks authoritative and is local.
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
- `gh pr merge --squash --delete-branch` exits NONZERO from a worktree, with `fatal: 'main' is already used by worktree at ...`, and the merge has already happened on GitHub. The failure is its local checkout step, not the merge. Read `gh pr view <n> --json state --jq .state` before believing the error; re-running it is what a session does next if it does not, and there is nothing left to merge.
- Merging deploys: no.
- `pnpm run install:local` is the LAST act, after the pull, and then tell the user to reload. Run it before the merge and the user reloads into whatever the tree held at that moment; a session that keeps working afterwards hands them a build its own later commits contradict. Install from the merged default branch or the install is a lie about what shipped.
- Before opening the PR, `git fetch` and diff `origin/main`'s `CHANGELOG.md` against the branch base. The nightly Release job stamps `[Unreleased]` into a version heading at 11:35 UTC, and a squash merge of a branch based before the stamp resolves the file by placing the session's new entries under that released heading, not the empty `[Unreleased]` above it (2026-08-17b, repaired in #341). Merge `main` in and re-seat the entries first.

## Lanes

- The default shape; ceiling 2, because the harness lock is machine-wide, refuses rather than queues (the loser exits 2 naming the holder), and a lane's gates are the bulk of its wall clock: a third lane spends its time failing gates and retrying. The ceiling prices the machine, not the session, so a live peer session's lanes (`ListAgents`) count against it. Integration branch `lewish/<slug>`.
- Brief a lane to commit BEFORE its `pnpm test:e2e` sweep, not after: the sweep is a seven-minute call and a lane that stops mid-sweep leaves nothing on its branch.
- Session target: 7 to 9 tickets.
- Hot files: `webview/editor.ts`, `serialization.ts`, `utils/minimalDiff.ts`, the fold plugins.
- Orchestrator-only files: `CHANGELOG.md`, `docs/BENEFITS.md`, written once over the reconciled diff, plus BENEFITS only if a capability's story changed.
- Exclusive resources: browser perf captures (`perf:*`). The machine is idle exactly twice, at the start and at reconciliation; `perf:bundle` is browser-free and fine, node-level micro-measurement survives.
- With peer sessions live, the harness lock refuses more often than it is free, and `merge-lane.sh --gate` runs its gate once. Pass `--gate` only while `$TMPDIR/birta-writer-harness.lock` is absent; otherwise merge bare and gate in a separate call that loops on the lock's refusal message (not on exit 2, which is ambiguous): a tool call dies at ten minutes, and a merge still waiting on the lock then lands without its verdict. A `gate_failed` on a lock refusal or a timed-out test is a contention red; re-run the failing file alone before blaming the lane.

## Priority doctrine

`AGENTS.md`, "Sequencing", carries the doctrine and it is not restated here. One binding that section does not carry: holding the machine for one perf ticket blocks every other measurement-bound one, however highly it ranks.

## Repo law

Read before touching code: `AGENTS.md`, `docs/DESIGN_PRINCIPLES.md`.

## Repo lore

Procedures a session cannot derive from the tree. Anything that reads as an account of how a bug was found belongs in `git log`, not here.

- On a perf ticket, take a CDP sampling profile and fold native self-time into the nearest JS caller, or the top frames name no code you own. Calibrate a CI gate from a CI run, not a laptop.
- The variable under test must be the only difference between the two reads (AGENTS.md, "Required workflow", holds the `git show main:<file>` rule). For a UI count the contaminant is leftover state rather than the tree: run the after-gesture once before taking the baseline.
- A mutation run expires on your next edit; re-run mutations in the final state, a late-added gate is the usual culprit.
- On an integration-suite red, A/B two axes before triage: the tree (base vs branch) and the VS Code build (`BIRTA_ITEST_VSCODE`). Either axis alone misattributes an upstream channel change (MAR-353). A red that repeats alone on `main` while the Release job is green is this machine's; `diskDrift`'s external-write case is the known one.
- Vitest: read the `Errors:` line of a passing run, not just `Tests:`; unhandled errors exit non-zero with every test green. `pnpm typecheck` excludes `**/__tests__/**` by design, so a changed export signature stays green through typecheck and build and surfaces only as whatever the wrong value does at runtime.
- Exit 2 is ambiguous: the harness lock and a metafile-less `pnpm perf:bundle` both use it. Retry on the lock's message, never the code, and build with `node esbuild.mjs --production --metafile` first.
- The lane scripts take COMMA-separated lists, not repeated flags (`--only a,b`). A repeated flag silently keeps the last, so `file-overlap.sh` prints an `expected` set you did not pass and reads authoritative while covering one path.
- A squash merge leaves every lane branch a non-ancestor of `main`, so `cleanup-worktrees.sh` refuses to delete them and is right to. Ancestry cannot answer whether they landed: diff trees instead, over the files each branch touched. Empty means landed, and a branch the orchestrator built on afterwards differs, where the question is only whether it holds anything `main` lacks.
- `cd` persists between Bash calls, so inspecting a lane's worktree silently moves later commands, and the worktree hook does not catch it: it refuses git aimed elsewhere (`-C`, a path argument) and any command too compound to verify (a heredoc, a chain of three), but a bare `cd` passes. Write a multi-line edit as a scratchpad script run by path, or use the Edit tool.
- A lane that adds dependencies reds the merge gate for a phantom reason: `merge-lane.sh` gates before anyone runs `pnpm install`, so the incoming import fails to resolve in the integration worktree. Install there, merge by hand, gate again.
