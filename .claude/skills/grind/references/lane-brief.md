# The lane brief

Load this when you are about to dispatch or refill a lane. Same skeleton every time; fill the angle brackets and delete nothing.

It is deliberately constraint-shaped rather than step-shaped — the agent already knows how to write code and run tests. What it cannot know is what the *other* lanes own, that its worktree may have been created from a stale HEAD, and that its job ends at a commit on its own branch.

```
You are lane <N> of a /grind session, working <MAR-NN>: "<title>"

<ticket description, verbatim>

## Belief, not instruction
I believe <cause / approach>. That is a belief, not a finding. Measure it before
you build on it. If your measurement contradicts this brief, report the
contradiction — that is the expected return on this instruction, not a problem.

## Scope
This lane owns: <predicted file paths>. A file outside that list is a finding to
report, not a change to make quietly — another lane may own it right now.
MUST NOT edit CHANGELOG.md or docs/BENEFITS.md. The orchestrator writes those
once, at reconciliation; three lanes editing them is the known conflict.

## Method — the /grind work loop (§3)
Reproduce empirically → implement the smallest correct fix in the codebase's
existing idiom → critique the first cut BEFORE hardening it → test (prove every
new test can fail by reverting the exact line it pins) → critique the diff →
disposition every finding by value, fixing by default (§3.6). Delete throwaway
probes. Gates before each commit: pnpm test, pnpm typecheck, pnpm build — plus
pnpm test:e2e if you touched webview/. Run one harness at a time.

## Worktree
You are in an isolated git worktree, possibly created from a stale HEAD.
BEFORE reading any source file, run: git merge lewish/<session-slug> --no-edit
("Already up to date" is fine; conflicts get resolved before you start.)
MUST NOT call EnterWorktree — a nested worktree breaks orchestrator cleanup.
MUST NOT push, open a PR, or touch main. Commit on this worktree's branch only,
with the repo's convention prefix and a `Closes MAR-NN` line.
Stage the paths you touched by name. NEVER `git add -A` / `git add .` / `git
commit -a`: your worktree is isolated from other lanes, not from the harness,
hooks, or the user, and a blanket stage commits their in-flight work under your
message. Read `git status --short` before committing — a path you did not touch
is exactly what you are looking for.

## Handoff — end your output with this section
- Files touched: the verbatim output of `git diff --name-only lewish/<slug>`
- Deviations: how the implementation differed from the ticket (or "None")
- Concerns: fragile areas, anything that might break
- Assumptions: decisions made without explicit guidance
- Reachability: for each user-facing claim, the gesture you actually drove
- Lane suggestions: what the next ticket in this lane needs to know
- Discovered work: each with a reproduction you ran — or say plainly that you
  could not run one
```

## Why the sync line is not boilerplate

The Agent tool can create a worktree from a **cached HEAD** rather than the live one. Without `git merge <integration-branch> --no-edit` as the first action, a refilled lane starts from a tree that predates its predecessor's merge and re-solves solved problems — silently, with a green suite. This is the same workaround `tri-work` carries in every prompt it sends.

## Refill additions

When a lane's predecessor produced concerns or lane suggestions, append this section after **Scope** and before **Method**:

```
## Prior task context
The previous ticket in this lane (<MAR-NN>: "<title>") reported:
**Concerns**: <concerns, or "None">
**Lane suggestions**: <suggestions, or "None">
Treat these as observations from someone who just read this code — verify, don't
assume.
```
