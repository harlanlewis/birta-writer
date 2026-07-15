---
name: grind
description: Autonomous backlog loop — groom Linear so the queue holds the right work, prioritize, pick, and ship it end-to-end with iterative self-critique, tracking, and cleanup. Triggers: /grind, "review the backlog and get after it", "pick something and ship it", "work the backlog autonomously".
version: 1.4.0
---

# Grind — autonomous backlog loop

## Purpose

Turn "review the backlog and get after it" into a disciplined, repeatable loop: groom → orient → pick by principle → understand → implement/critique/test/critique/ship per milestone → track & groom → hand off → clean up. High agency, bounded by principle. Act when you have enough to act; ask only on genuine judgment calls.

**Critique early and often, and act on it.** The loop below critiques three times — at the design, at the first working cut, and at the finished diff — because a critique's leverage collapses as the work hardens around it. The last one can fix a bug; only the first two can tell you the design is bigger than the problem. And a finding is only addressed when it is fixed, filed, or declined out loud (§3.6).

Optional `$ARGUMENTS` narrow the scope (e.g. `/grind phase-0 fidelity bugs`, `/grind MAR-120`). With none, groom, then work the active queue.

***

## 0. Groom the queue first (before picking anything)

**A starved queue isn't the only way this fails — nor the worse way.** A thin `Todo` reduces "pick by principle" to picking whatever's there; a *full* one fails more quietly, letting a ready, cheap item sit beside the existential one and win on readiness alone. Grooming owes the pick depth **and** an honest top — depth is the easy half.

- **Read the board guide first** (`MAR-141` — 📌 START HERE, current working order). Its stated ordering outranks your inference from labels — but **it is an artifact, not an oracle: verify it, and fix it when it has drifted.** It goes stale the moment a session ships anything, and it is written in the confident voice of a plan either way. (2026-07-15: it listed a five-item queue of which four had already shipped.) Leaving it wrong silently mis-sequences the *next* session too, so updating it is part of grooming, not a nicety. The same skepticism is owed to the tickets it points at — §2.
- **Pull wider than `Todo`**: `Todo` + `In Progress` + `Backlog`. The queue you prioritize over is the *groomed* union, not the default view. **Pull the Backlog inside a subagent** and have it return a compact table (id, title, priority, labels, updated) — a real backlog exceeds the tool-output limit and will blow up in your face mid-groom if you fetch it inline (2026-07-15: 54 issues, 74k chars, hard error). `Todo`/`In Progress` are small enough to fetch directly, in parallel.
- **Reconcile against reality — this is what makes the queue trustworthy:**
  - **Close silently-shipped work.** Cross-reference open tickets against `git log --oneline` (read diffs of recent omnibus `feat:`/`fix:` commits, not just subjects) and `CHANGELOG.md`. Verify against the working tree, never the CHANGELOG alone. Move to `Done` with the SHA.
  - **Re-scope tickets the code has outgrown** — a premise that no longer holds, or a partial fix already landed. Rewrite the title/description to what's actually left.
  - **Un-stick `In Progress`** items that aren't being worked: finished → `Done`; abandoned → back to `Todo`/`Backlog`.
- **Spine quota — the binding rule. Readiness is not a filter on the pick.** The pick is the **first High-or-Urgent item down the spine** (`phase-0-fidelity` first, then `phase-2-syntax`, `phase-3-interaction`, `phase-4-differentiators`; within a phase, by `priority` — `CLAUDE.md` → Issue tracking) — and **if it isn't ready, making it ready IS the work**: scope it, build the repro, bound the blast radius. If bounding it is all a session buys, that is the session's deliverable — write it into the ticket and say so. Below High the spine stops compelling (fidelity's long tail always has open Mediums; letting those compel would freeze every other phase forever); with no High anywhere, take the spine's top by `priority`.
  - Readiness is **anti-correlated** with the spine, which is why it can't be the gate: a clear repro and a known blast radius are what existential work *lacks* — not knowing MAR-120's blast radius is *why* it's phase-0, not a reason to pass over it. (2026-07-15 15:17: MAR-107 (phase-3, Low) and MAR-29 (phase-4, Low) were promoted in the same minute and both shipped by 15:59 — while MAR-120 (phase-0, **High**, #Bug, open since 07-13) sat in `Todo` untouched all day. Note the board had *already* encoded the answer in `priority`; the readiness gate overrode it. A filter that outranks both spine and priority isn't a tiebreak — it's the whole sort.)
- **The spine item is the session's opener, not its leftover.** Cheap wins aren't banned — they're what you do *after* it has had your first and best hours (MAR-107 and MAR-29 took 42 minutes between them; the day had room for both *and* MAR-120). A session ending with the spine item untouched has answered "was it of value?" with "it was easy."
- **Only *blocked* releases the quota — never *hard*.** Blocked means you can't proceed without something outside the session: an upstream decision, a fork, a user judgment call. Name the blocker in the ticket and take the next item. Vague, large, or intimidating is not blocked — that's the work, and §4's *scope honestly* is how you land part of it.
- **Promote depth behind it** — a few more items so a genuinely-blocked top has a successor. Depth is for continuity, never for choosing.
- **File discovered work as you groom** (`/devlog`) rather than holding it in your head.
- **Push the reconciliation reads into subagents** — the git-log/CHANGELOG cross-reference is exactly the broad, noisy read §2 says to delegate. Relay conclusions.
- **If grooming genuinely finds nothing open**, say so and ask — don't manufacture work to have something to do. ("Nothing *ready*" is not that case; see the quota.) `$ARGUMENTS` naming a specific ticket (e.g. `/grind MAR-120`) narrows grooming to that item's neighborhood; it doesn't skip the reconcile.

## 1. Orient & prioritize (once)

- Prioritize over the **groomed** queue from §0 — never the raw `Todo` view.
- **The spine quota names the pick; convenience is not a tiebreak.** "Well-scoped, with a clear repro" describes the *runner-up* on almost every board, because the least-scoped work is usually the most existential — reaching for it is the pathology, not the principle. Honor `$ARGUMENTS` if given.
- State the pick and *why* in one line, then go. Don't narrate options you won't pursue. **If you're about to pass over a higher-spine item, that's not a preference — it's a claim that it's blocked, and it belongs in the reply and the ticket.**
- Set up a task list (`TaskCreate`) for the chosen items; keep it current as you work.

## 2. Understand before acting

- Read the ground truth in order: the failing test / repro → the implementation it exercises → the surrounding architecture and conventions (`CLAUDE.md`, `docs/DESIGN_PRINCIPLES.md`).
- **A ticket's prescribed approach is evidence, not instruction** — the same rule §0 applies to the board guide. Its description records what someone believed when they filed it; you have the code in front of you and they didn't. Take its *problem* as the brief and its *plan* as a hypothesis. **A ticket that flags its own approach as unverifiable is naming the experiment to run first, not the thing to build.** (2026-07-15, MAR-144: the description prescribed a contributed keybinding in five numbered steps; its own "Verification note" warned the failing path was host-specific and couldn't be reproduced headlessly. The prescription was built in full — then reality rejected it: on macOS the native Option+Arrow caret-nav fires *before* an async contributed command can, so the move faithfully preserved a corrupted caret. The same PR reverted to a hardcoded chord, `c535203`.) Fidelity to a plan reality has already contradicted is not diligence.
- **Push big or noisy reads into subagents** (out-of-context summarization, broad multi-file searches). Relay conclusions, not file dumps.
- **Lanes / parallelism:** fan out subagents for *independent* work (separate files, independent investigation). Do **not** fan out edits that touch shared files — coordinate those yourself and name the coordination point. Send parallel subagents in one message so they run concurrently. Be honest that in this repo the answer is usually *serial* — the fidelity work concentrates in a few shared files (`editor.ts`, `serialization.ts`, `minimalDiff.ts`, the fold plugins), so the reliable parallelism here is **investigation**, not concurrent edits.

## 3. The work loop (per ticket / milestone)

Repeat for each unit of work. Mark the task `in_progress` when you start it.

1. **Reproduce** — confirm the behavior empirically. A throwaway probe test/script is fine; delete it after (never leave `_dbg`/`_probe` files behind).
2. **Implement** the smallest correct fix that matches the codebase's existing patterns (idioms, comment density, naming — not just "make it pass"). Respect the architecture constraints in `CLAUDE.md`.
   - **Before building a mechanism, grep for the one that exists.** Name the behavior you need and search for it. If you find yourself *citing* an existing function to justify your design, you have found your implementation — call it. (2026-07-15, MAR-146: the fix cited `revealPosition`'s explicit-entry-intent semantics in its own comments *while reimplementing them predictively* in ~60 lines across three new exports. `revealPosition(view, insertAt)` after the move was the whole job: −105 lines, every test and e2e check passing untouched.)
   - **Prefer observing the result to predicting it.** If a check can run *after* the operation and read the real state, it should. Predicting what a document *would* look like is strictly harder than looking at the one you just made — the predictive cut above needed the leading heading rank, a terminating-rank rule, the post-relevel fragment, and position mapping: four independent chances to be wrong, all replaced by one question asked of the real doc. Prediction also invents ordering hazards (commit-before-verify) that observation cannot have.
3. **Critique the first cut — BEFORE you harden it.** The moment it works, stop and attack the *design*, not the diff: is there less of it? does it duplicate something? is it predicting what it could observe? what would a reviewer say the shape should be? This step exists because the end-of-loop critique (step 5) is too late to change a design — by then the approach is wearing 60 lines of doc comments, a test suite, and mutation proofs, and every one of those is sunk cost arguing for it. **Churn is the tell:** if you have written a predicate, reverted it, and written another (or edited the same file's semantics twice), the design is not settled — stop adding tests and re-ask what question the code is answering. (Same session: a doc-end special case → a content-aware predicate across four files → reverted → a narrower predicate → shipped → *then* found the one-liner.)
4. **Test** — reproduce-then-fix:
   - Add/pin a regression test (for a fidelity repro, promote its `it.fails` and remove the matching gate exclusion).
   - **Prove every new test can fail — revert the exact line it pins, not the whole change, and watch it go red.** A test that passes either way is worse than none: it reads as coverage forever. Watch for a test that asserts a *downstream* observable some other mechanism already guarantees — it will pass for the wrong reason. (2026-07-15: an external-sync test asserted "no bytes posted", which a serializer early-return satisfied on its own; the guard it claimed to pin could be deleted with the suite green. The honest observable was "no serialize happened at all".) If a claim's only observable is work that *doesn't* happen, count the work.
   - Re-read the numbers a passing check prints, and ask what they'd be if the thing were broken. (Same session: a max-wait check passed at `2ms` — that was the leading edge firing, not the 2000ms cap it claimed to prove.)
   - **Assert what the user would lose, not the state your fix manipulates.** Asserting the thing you just set restates the mechanism and re-passes for free; assert the independent observable downstream of it. (2026-07-15, MAR-146: the fix cleared a fold entry, so checking `folded` — or `foldedHiddenRanges`, derived from it — proved nothing. The honest observable was the decoration class that actually drives `display:none`.) The payoff is concrete: those tests then survived swapping the entire mechanism out in a later refactor, unchanged, and *that* is what made the refactor safe to ship. A test that must be rewritten whenever the implementation changes was testing the implementation.
   - `pnpm test <focused>` → then full `pnpm test`; `pnpm typecheck`; `pnpm build`.
   - For webview runtime behavior beyond jsdom, use the `/verify` skill.
5. **Critique the diff** — run `/constructive-critique` on the change. *Verify against reality*: probe edge cases the tests miss, adversarially. (For pure bug-hunting on a diff, `/code-review` instead.) A subagent reviewer that can run its own probes finds more than one reading the diff.
6. **Address every finding — explicitly.** Each one lands in exactly one bucket: **fixed**, **filed** (a ticket id, not a promise), or **declined with a stated reason**. There is no "noted". A finding you neither fix nor file will ship, and the write-up will still list it as if it were handled. (2026-07-15, MAR-146: a reviewer flagged two predicate branches as unreachable from the only caller while their doc comments presented them as live semantics. It was acknowledged as "defensive purity, noting only" — and the dead code shipped to `main`; it died in a follow-up PR the next hour. "Low severity" is a reason to file it, not to skip it.) When you decline, say so in the reply — an unmentioned finding reads as one that didn't exist.
7. **Commit** at a working milestone. Convention prefix (`fix:`/`feat:`/`refactor:`/`test:`/…), *why* in the body, `Closes MAR-NN`, the Co-Authored-By trailer. **Push.**
8. **Update tracking** — Linear status + task list, as you go.

**Critique cadence, in one line:** at the design (step 2), at the first working cut (step 3), and at the finished diff (step 5) — cheapest first, because each later one can only change smaller things.

## 4. Decide wisely (the judgment layer)

- **Multi-dimensional lens:** weigh correctness, fidelity/safety, performance, security, maintainability, test quality & coverage, UX/UI, cohesion/consistency — apply what fits, name the trade-off.
- **Scope honestly:** if part of a ticket is clean and part is hard/risky, **ship the clean part and re-scope the rest** into the ticket (or a new one). Never force a fragile fix into fidelity-critical code for diminishing returns. Say what you're deferring and why.
- **CHANGELOG gate is observability, not effort:** user-visible behavior in (`### Fixed`/`Changed`/…); internal correctness/tooling out (it's in git). Review `docs/BENEFITS.md` and edit in place only if a capability's story changed.
- **Every user-facing claim must be one you checked** — the CHANGELOG describes the product to someone who can't read the diff, so a plausible-but-unverified sentence there is a defect, not prose. Reachability claims are the usual offender: "gesture X does this too" needs the gesture actually driven, not inferred from the code you happened to touch. (2026-07-15, MAR-146: a CHANGELOG line claimed outline reordering hit the same bug. It was true — but only via a *terminal gap* slot nobody had probed, and it was written before anyone checked; the obvious "into" path is withheld and would have made the sentence false.)
- **Verify against the code, not the CHANGELOG,** before calling anything done.

## 5. Track & discover (keep the backlog honest)

- **File issues for discovered work immediately** — pre-existing bugs, footguns, follow-ups — via `/devlog`. Don't silently absorb or drop them.
- **Groom as you go:** cross-check whether the change *incidentally fixed* another open ticket (same root cause) — verify against the working tree, pin a regression test, close it. This catches silently-shipped work.
- **Close the loop both directions:** `Closes MAR-NN` in the commit; SHA + status comment in the ticket. On a **squash** merge, the branch commits are rewritten — cite the **merge** SHA, not the branch SHAs.

## 6. Land it

- Branch first if on `main` (`lewish/<slug>`). At a solid milestone open a PR (`gh pr create`) with a summary, the tickets, and the verification done.
- **Wait for CI green** (`gh pr checks <n> --watch`), then merge matching the repo convention — **squash** (`gh pr merge <n> --squash --delete-branch`). Pull `main`.
- Move shipped tickets to `Done` with the merge SHA; re-scope partials (update title/description, leave open).

## 7. Hand off & clean up after yourself

- Run the `CLAUDE.md` **end-of-work handoff** whenever `src/`, `webview/`, `shared/`, or `package.json` changed: `pnpm test` green → CHANGELOG → review BENEFITS → `pnpm run package` → install the VSIX + remove any legacy build → tell the user to **reload** (Cmd+Shift+P → "Developer: Reload Window").
- **Leave the tree tidy:** delete merged branches (local + remote), remove stale worktrees, `git fetch --prune`. Before any destructive branch/worktree op:
  - **Classify merged vs unmerged.** `git branch --merged` misses squash-merges — verify via `gh pr list --head <branch>` (a deleted remote + a `MERGED` PR = safe).
  - **Ask before deleting anything that would lose work** (unmerged/closed-unmerged branches). Review the actual content first — is its unique artifact already on `main`? is it superseded? — don't guess.

## Cross-cutting stance

- **Act on sensible defaults; ask only on genuine judgment calls** the code/context can't resolve (deleting unmerged work, a fidelity policy decision, a user-facing trade-off). Note the default you picked when you don't ask.
- **Report faithfully at the end:** what shipped (and where — merge SHA), what's deferred and why, what's still red, tickets created/closed/re-scoped. Distinguish what's in the CHANGELOG (user-observable) from what shipped but is internal by design.
