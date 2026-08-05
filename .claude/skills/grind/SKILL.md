---
name: grind
description: 'Autonomous backlog loop — groom Linear so the queue holds the right work, prioritize, then fill parallel worktree lanes and ship them end-to-end with iterative self-critique, reconciliation, tracking, and cleanup. Triggers: /grind, "review the backlog and get after it", "pick something and ship it", "work the backlog autonomously".'
compatibility: Requires git, jq, pnpm, and the Linear MCP tools. Bundled scripts are bash (macOS /bin/bash 3.2 compatible).
metadata:
  version: '2.0.0'
---

# Grind — autonomous backlog loop

Groom → pick → plan lanes → work → reconcile → land → clean up.

Lanes are the default shape: concurrent worktree-isolated agents, reconciled through one integration branch. Serial is the degenerate case — one groomed item, or everything landing in the spine item's files.

`$ARGUMENTS` narrow scope (`/grind MAR-120`). Without them, groom the active queue.

***

## 0. Groom

- **Read `MAR-141`** (board guide). It goes stale the moment anything ships — verify against `git log` and the tree, and fix it as part of grooming.
- **Pull `Todo` + `In Progress` + `Backlog`.** Prioritize over that union, not the `Todo` view. Fetch Backlog inline with minimal `fields` (`title`, `priority`, `labels`) — that fits; a subagent for it is waste.
- **Reconcile:** close silently-shipped work (verify in the tree, not the CHANGELOG; cite the SHA), re-scope tickets the code outgrew, un-stick stale `In Progress`.
- **Check `Closes MAR-NN` against ancestry** — `git merge-base --is-ancestor <sha> main`. A ticket closed on a pushed branch rather than a merged PR leaves no signal anywhere.
- **Pick: first High-or-Urgent down the spine** — `phase-0-fidelity` → `phase-1-performance` → `phase-2-syntax` → `phase-3-interaction` → `phase-4-differentiators`, then by `priority`. `phase-5-surfaces` never ranks (D8). With no High anywhere, take the spine's top by priority.
  - **Readiness is not a filter.** Unscoped and unreproduced is what existential work looks like; making it ready IS the work. Only *blocked* — needing something outside the session — releases it, and name the blocker in the ticket. The spine item is the session's opener, not its leftover.
- **Burn down deferred residue** (follow-ups, cleanups, polish batches): absorb, merge, or close with a reason — "below the value bar" is one. Never close maintainer-authored ideas to hit a count, and never manufacture phase-0 tickets so the spine has something to point at.
- **Work MAR-141's do-inline ledger** when a session touches a line's area. Prune lines sessions have worked past.
- If grooming finds nothing open, say so and ask.

## 1. Plan the lanes

- State the pick and why in one line. Passing over a higher-spine item is a claim that it's blocked — put it in the reply and the ticket. Holding the machine for one perf ticket blocks every other measurement-bound one, however highly it ranks.
- **Lane 1 is the spine item, and it's yours.** Fill remaining lanes behind it in queue order. Three lanes is the ceiling; prefer two clean seams to three ambiguous ones.
- **Plan by file ownership, measured.** Grep the symbols each ticket names. Tickets sharing a hot file (`webview/editor.ts`, `serialization.ts`, `utils/minimalDiff.ts`, the fold plugins) share a lane and run in sequence — that's the answer to a collision, not collapsing to one lane.
- **`CHANGELOG.md` is never a lane's** — the orchestrator writes it once at §6. It is the observed conflict, because the handoff rules tell every lane to touch it.
- Holding lane 1 trips the repo pre-commit guard (`$CLAUDECODE` + primary checkout + live worktree). `--no-verify` is its documented override — read `git status --short` first and confirm your paths are disjoint from every lane.
- `TaskCreate` covering every lane's tickets.

### Dispatch

Cut the integration branch first: `git checkout main && git pull && git checkout -b lewish/<slug>`.

If another live session owns the primary checkout, don't check anything out — `git branch lewish/<slug> main`, take a dedicated worktree, merge by hand. `merge-lane.sh` would check that session's branch out from under it.

Send the filled-in brief from [references/lane-brief.md](references/lane-brief.md). Per lane, in order:

1. Set the ticket `In Progress` before the agent starts.
2. Launch `isolation: "worktree"`, `run_in_background: true`, **one agent per message** (the creation race is in user-level `CLAUDE.md`).
3. Verify isolation before reporting it, passing the Agent result's values verbatim:
   ```bash
   .claude/skills/grind/scripts/check-isolation.sh --path "<worktreePath>" --branch "<worktreeBranch>"
   ```

Your shell's cwd is the worktree base, so `cd`-ing into a worktree nests the next agent's inside it, where `cleanup-worktrees.sh` never finds it. `cd` back to the primary before every dispatch.

**Measurement is exclusive, so lanes cannot share it.** Worktrees isolate files, not cores: concurrent `perf:*` captures are not evidence and concurrent suites go red for nothing. On a perf session forbid every browser capture in the brief and say the orchestrator runs the A/B idle at reconciliation (`perf:bundle` is browser-free and fine; node-level micro-measurement survives). Lanes then report *what they want measured and what would falsify it* — a better handoff than a number they could not trust, and naming the span makes a win landing in a different one a finding rather than a footnote. Their headlines stay unverified until you re-run them: one lane's −27.2% was −23.8% idle.

### On completion

1. Read the handoff. **A lane's report is a description, not a result** — reproduce anything you'll relay, file, or changelog, its tracking claims included ("filed separately" is an intention as often as an outcome; one `list_issues` settles it).
2. Measure what it actually touched against the plan:
   ```bash
   .claude/skills/grind/scripts/file-overlap.sh --base lewish/<slug> \
     --actual <lane-branch> --expected "path,path"
   ```
   An overlap here is a queued-lane rebrief, and far cheaper than finding it in the merge.
3. Merge (§6). 4. Refill. 5. File its discovered work now, while the repro still runs.

**Refill** after the predecessor merged, so the stale-HEAD sync lands on a reconciled tree. One refill per message — two lanes draining at once relaunch into the same race.

**On failure:** ticket back to `Todo` with what broke; don't re-dispatch this session. Already failed a previous session → it's a grooming problem, not a lane.

**Transport death is not work failure.** Read the worktree's `git log` / `git status --short` before assuming nothing landed, resume with `SendMessage`, and lead with "commit what you have, first" — uncommitted work is the only thing these deaths cost. A silent lane is not a working lane: check mtimes and last commit rather than blocking on a ping.

Feed each handoff forward into briefs not yet sent. A handoff that invalidates a queued ticket's premise re-plans that lane now.

## 2. Understand

Read the repro → the implementation → `AGENTS.md` / `docs/DESIGN_PRINCIPLES.md`.

**Treat a ticket's account of itself as hypothesis, not brief.** Its *symptom* is usually right; its *cause*, *plan*, *scope* and *severity* fail routinely — scope toward too small, which ships a fix leaving the worse half of the bug in place under a green suite, and severity in both directions. **Re-derive severity from your own repro before letting it set the queue.** Before implementing, name the observation that would falsify the stated cause and make it. Ask what other gesture reaches the same broken state. Enumerate the space rather than sampling it.

- **Bytes outrank accounts.** When a ticket names both a mechanism and an output, check the output first — one print can convict the mechanism before you understand it.
- **On a perf ticket, profile before you ablate.** Ablation confirms a suspect; it cannot generate one. Four phase-1 tickets running have named a mechanism nobody profiled, and all four were wrong. Take a CDP sampling profile and fold native self-time into the nearest *JS caller* — unfolded, the top frames are `querySelectorAll` and the engine's internals, which name no code you own.
- **An ablation bounds one caller and is blind to a second**, so a residue the ticket wrote off as unattributed is the next finding, and the first suspect is the same hot function reached from elsewhere. MAR-316 ablated one scroll listener, attributed 660 ms, shelved the other 1170 ms: the table of contents, calling the identical function once per heading above the viewport. Grep the hot function's callers before believing any attribution.
- **Verify semantics, not shape.** A grep that matches feels like confirmation and isn't. Ask what the claim predicts that you can run.
- **Brief subagents to measure, and give them standing to contradict you** — a brief that hands down conclusions buys obedience, and obedience propagates your errors with a green suite. Push broad or noisy reads to them and relay conclusions, weighting by whether they *ran* something.

## 3. Work loop (per ticket, and what each lane runs)

1. **Reproduce.** Throwaway probes are fine; delete them. A probe is code you just wrote — assert it hit what you aimed at. A result surprising in a *boring* way (a count of 0, an element you never named) means the probe missed; one that reads far WORSE than the ticket it reproduces means the probe caught more than the gesture. Reproducing the ticket's own number is the check that you are both measuring the same thing.
2. **Implement** the smallest correct fix in the surrounding idiom. Grep for the mechanism that already exists before building one — if you're citing a function to justify your design, call it instead. Prefer observing the result to predicting it.
3. **Critique the design before hardening it.** Is there less of it? Churn is the tell: a predicate written, reverted, rewritten means the design isn't settled. Act on findings here — carried to step 5 they cost a test suite.
4. **Test.** Pin a regression test; promote a fidelity `it.fails`. **Prove each new test can fail by reverting the exact line it pins.** Assert what the user would lose, not the state your fix sets — and watch for assertions satisfied by something else in the fixture. Then `pnpm test`, `pnpm typecheck`, `pnpm build`; `/verify` for runtime behavior beyond jsdom.
   - **Read the `Errors:` line of a passing vitest run, not just `Tests:`.** Unhandled errors exit non-zero with every test green. Contention explains *varying* failures across *different* suites; it does not explain the same error from the same file every time.
5. **Critique the diff** — `/constructive-critique` (`/code-review` for pure bug-hunting). A reviewer that runs its own probes finds more than one reading the diff.
6. **Disposition every finding where it was raised**, by value, never effort:
   - **Fixed** — the default for anything that matters. Cheapest now.
   - **Filed** — only when genuinely outside the session: blocked on a decision, a design fork, upstream, or pre-existing in untouched territory. Big-but-unblocked is fixed.
   - **Declined, out loud** — cosmetic, speculative, taste. Don't file it. Never file a leftovers bundle. There is no "noted".
   - Two cosmetic-only passes in a row over unchanged scope → stop and ship.
7. **Commit** at a working milestone. Convention prefix, why in the body, `Closes MAR-NN`. **Stage paths by name — never `git add -A`**; you're not the only writer in the tree. In a lane: lane branch only, no PR, no `main`, no CHANGELOG.
8. Update Linear and the task list as you go.

## 4. Judgment

- **Scope honestly.** Ship the clean part, re-scope the rest into the ticket. Never force a fragile fix into fidelity-critical code for diminishing returns.
- **Every user-facing claim is one you checked.** The CHANGELOG describes the product to someone who can't read the diff, so an unverified sentence there is a defect. Reachability claims are the usual offender — drive the gesture, don't infer it.
- **A recorded number is a description.** Re-measure before quoting a baseline or snapshot.

## 5. Tracking

- **Never file a repro you haven't run.** Paste observed output, not expected. If it can't be reproduced in-session, say so in the ticket.
- Watch the filing ratio — more created than closed is a deficit worth justifying.

## 6. Reconcile and land

Lanes merge into the integration branch as they finish — never into `main`, never into each other. Merging early is what makes the next lane's brief honest.

```bash
.claude/skills/grind/scripts/merge-lane.sh --branch <lane-branch> \
  --into lewish/<slug> --ticket MAR-NN --gate "pnpm test && pnpm typecheck"
```

| `status` | exit | do |
|---|---|---|
| `merged` | 0 | Refill the lane. |
| `conflict` | 1 | Tree untouched, `conflict_files` listed. Resolve by hand or rebrief the lane. Either way it's a lane-plan finding: rebrief every queued lane sharing those files. |
| `merge_failed` | 1 | Refused *without* conflicts — usually an untracked file, named in `reason`. Clear it, re-run. |
| `gate_failed` | 2 | Reverted. Belongs to the lane that caused it — rebrief with `gate_output`. **First check `uptime`:** a gate run while lanes still hold the machine fails with every test passing, `Errors: N` worker timeouts, and 2–3× normal duration. Re-run idle before blaming a lane. **A contention red reproduces, including across branches**, so reproducibility is not evidence the failure is real. Re-run idle first, then bisect. |
| `dirty` / `refused` | 3 | Your own uncommitted work, or a bad HEAD/branch. `reason` says which. |
| `empty` | 4 | The lane committed nothing, whatever it reported. |

**`merged` is not `shippable`.** Neither git nor the gate can tell you the change is correct. Reverting a green lane is legitimate: a `revert:` commit keeping the diagnosis, the branch pushed somewhere durable, the ticket re-scoped. **A lane's own "what is still exposed" note is your next probe, not a severity to accept** — the author who just chose to accept a risk is the worst-placed person to price it.

### Critique the seam

- **`/constructive-critique` over `git diff main...<integration-branch>`** — the whole session as one change. Only here are the seams visible: two lanes solving the same thing, an abstraction duplicated, a test one lane deleted and another relied on, a premise a later lane invalidated, **a lane's fix undone downstream by a layer it did not own** — each lane stopped at its own scope, so nobody drove the whole path. Ask what the user's bytes pass through *after* each fix, and drive that. `/simplify` belongs in this pass; re-run gates after it.
- **The critique is a description too — reproduce a finding before fixing it.** One reasoned from control flow named four shapes, none of which reproduced; the mechanism was real and reached by a fifth it never guessed.
- §3.6's buckets bind here — "a different lane wrote it" is not a reason to file instead of fix.
- **Write the CHANGELOG once, now**, over the reconciled diff, plus `docs/BENEFITS.md` if a capability's story changed. Verify each claim yourself.
- **One PR** with the tickets and the verification done. Wait for CI, squash, delete branch, pull `main`. **A red on an ADVISORY gate is a measurement — reproduce it idle before accepting or ignoring it.** Accepting a regression that isn't there is as false a record as ignoring one that is, and an unstable gate diagnosed with a reproduction is worth more than the lane that tripped it.
- Move shipped tickets to `Done` with the merge SHA; re-scope partials. A failed lane doesn't hold the session.

## 7. Hand off and clean up

- Run `AGENTS.md`'s end-of-work handoff whenever `src/`, `webview/`, `shared/`, or `package.json` changed. End by telling the user to reload.
- **Push any lane work a ticket cites before cleaning up**, and cite the remote ref — a local worktree branch dies with the worktree and the citation points at nothing.
- Remove this session's worktrees only once every lane merged, preserving any still running:
  ```bash
  .claude/skills/grind/scripts/cleanup-worktrees.sh --preserve agent-abc --delete-branches
  git fetch --prune
  ```
  A squash merge rewrites SHAs, so every lane branch reports `branches_kept: unmerged` even when it shipped. Verify the CONTENT reached `main` — grep a distinctive line from each lane — before deleting, and ask before deleting anything that would lose work.
- **Improve this skill — last step of every lane session.** Fold back only what would change a future session's behavior, and **amend or replace rather than append**: this file loads on every invocation, so a bullet costs every future session while its own value falls. **Adding net words owes a deletion — `wc -w` before and after, both figures in the commit.** Prefer the rule to its story: keep an incident only where the rule reads as arbitrary without it.

## Stance

- Act on sensible defaults; ask only on genuine judgment calls (deleting unmerged work, a fidelity policy call, a user-facing trade-off). Note the default you picked.
- **Report faithfully:** what shipped and where, what's deferred and why, what's still red, tickets created/closed/re-scoped, how the lanes ran, what the seam critique changed. A lane that silently produced nothing reads as capacity never spent.
