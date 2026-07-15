---
name: grind
description: Autonomous backlog loop — groom Linear so the queue holds the right work, prioritize, pick, and ship it end-to-end with iterative self-critique, tracking, and cleanup. Triggers: /grind, "review the backlog and get after it", "pick something and ship it", "work the backlog autonomously".
version: 1.2.0
---

# Grind — autonomous backlog loop

## Purpose

Turn "review the backlog and get after it" into a disciplined, repeatable loop: groom → orient → pick by principle → understand → implement/test/critique/ship per milestone → track & groom → hand off → clean up. High agency, bounded by principle. Act when you have enough to act; ask only on genuine judgment calls.

Optional `$ARGUMENTS` narrow the scope (e.g. `/grind phase-0 fidelity bugs`, `/grind MAR-120`). With none, groom, then work the active queue.

***

## 0. Groom the queue first (before picking anything)

**A starved queue is the failure mode this step exists to prevent.** If `Todo` holds only two or three items, a pick "by principle" degrades into picking the only thing that's there, lanes sit idle, and real priorities stay invisible in `Backlog`. Never start from a thin queue — refill it, *then* prioritize.

- **Read the board guide first** (`MAR-141` — 📌 START HERE, current working order). Its stated ordering outranks your inference from labels — but **it is an artifact, not an oracle: verify it, and fix it when it has drifted.** It goes stale the moment a session ships anything, and it is written in the confident voice of a plan either way. (2026-07-15: it listed a five-item queue of which four had already shipped.) Leaving it wrong silently mis-sequences the *next* session too, so updating it is part of grooming, not a nicety.
- **Pull wider than `Todo`**: `Todo` + `In Progress` + `Backlog`. The queue you prioritize over is the *groomed* union, not the default view. **Pull the Backlog inside a subagent** and have it return a compact table (id, title, priority, labels, updated) — a real backlog exceeds the tool-output limit and will blow up in your face mid-groom if you fetch it inline (2026-07-15: 54 issues, 74k chars, hard error). `Todo`/`In Progress` are small enough to fetch directly, in parallel.
- **Reconcile against reality — this is what makes the queue trustworthy:**
  - **Close silently-shipped work.** Cross-reference open tickets against `git log --oneline` (read diffs of recent omnibus `feat:`/`fix:` commits, not just subjects) and `CHANGELOG.md`. Verify against the working tree, never the CHANGELOG alone. Move to `Done` with the SHA.
  - **Re-scope tickets the code has outgrown** — a premise that no longer holds, or a partial fix already landed. Rewrite the title/description to what's actually left.
  - **Un-stick `In Progress`** items that aren't being worked: finished → `Done`; abandoned → back to `Todo`/`Backlog`.
- **Promote until the pick is a real choice.** Move ready work from `Backlog` → `Todo` until the top of the queue is genuinely the most important thing available — rule of thumb: **at least 3–5 ready items**. "Ready" means a clear repro or acceptance criterion and a known blast radius; promote by the roadmap spine (`phase-*`, then `priority`), not by what looks easy. The payoff is *sequencing*, not throughput: a queue of one makes "pick by principle" a fiction.
- **Note which promoted items are independent** — disjoint files can run as parallel lanes (§2); items sharing a file must be coordinated serially. Be honest that in this repo the answer is usually *serial*: the fidelity work concentrates in a few shared files (`editor.ts`, `serialization.ts`, `minimalDiff.ts`, the fold plugins). Don't inflate the promote count chasing lanes that won't exist — the reliable parallelism here is **investigation** (fan-out subagents to read/audit/critique), not concurrent edits.
- **File discovered work as you groom** (`/devlog`) rather than holding it in your head.
- **Push the reconciliation reads into subagents** — the git-log/CHANGELOG cross-reference is exactly the broad, noisy read §2 says to delegate. Relay conclusions.
- **If grooming genuinely finds nothing ready**, say so and ask — don't manufacture work to have something to do. `$ARGUMENTS` naming a specific ticket (e.g. `/grind MAR-120`) narrows grooming to that item's neighborhood; it doesn't skip the reconcile.

## 1. Orient & prioritize (once)

- Prioritize over the **groomed** queue from §0 — never the raw `Todo` view. Read the board's signal: the `phase-*` / `priority` labels are the roadmap spine (`phase-0-fidelity` is existential and comes first; see `CLAUDE.md` → Issue tracking).
- **Pick by principle, not convenience.** Existential tiers first; prefer well-scoped work with a clear repro over a vague large ticket. Honor `$ARGUMENTS` if given.
- State the pick and *why* in one line, then go. Don't narrate options you won't pursue.
- Set up a task list (`TaskCreate`) for the chosen items; keep it current as you work.

## 2. Understand before acting

- Read the ground truth in order: the failing test / repro → the implementation it exercises → the surrounding architecture and conventions (`CLAUDE.md`, `docs/DESIGN_PRINCIPLES.md`).
- **Push big or noisy reads into subagents** (out-of-context summarization, broad multi-file searches). Relay conclusions, not file dumps.
- **Lanes / parallelism:** fan out subagents for *independent* work (separate files, independent investigation). Do **not** fan out edits that touch shared files — coordinate those yourself and name the coordination point. Send parallel subagents in one message so they run concurrently.

## 3. The work loop (per ticket / milestone)

Repeat for each unit of work. Mark the task `in_progress` when you start it.

1. **Reproduce** — confirm the behavior empirically. A throwaway probe test/script is fine; delete it after (never leave `_dbg`/`_probe` files behind).
2. **Implement** the smallest correct fix that matches the codebase's existing patterns (idioms, comment density, naming — not just "make it pass"). Respect the architecture constraints in `CLAUDE.md`.
3. **Test** — reproduce-then-fix:
   - Add/pin a regression test (for a fidelity repro, promote its `it.fails` and remove the matching gate exclusion).
   - **Prove every new test can fail — revert the exact line it pins, not the whole change, and watch it go red.** A test that passes either way is worse than none: it reads as coverage forever. Watch for a test that asserts a *downstream* observable some other mechanism already guarantees — it will pass for the wrong reason. (2026-07-15: an external-sync test asserted "no bytes posted", which a serializer early-return satisfied on its own; the guard it claimed to pin could be deleted with the suite green. The honest observable was "no serialize happened at all".) If a claim's only observable is work that *doesn't* happen, count the work.
   - Re-read the numbers a passing check prints, and ask what they'd be if the thing were broken. (Same session: a max-wait check passed at `2ms` — that was the leading edge firing, not the 2000ms cap it claimed to prove.)
   - `pnpm test <focused>` → then full `pnpm test`; `pnpm typecheck`; `pnpm build`.
   - For webview runtime behavior beyond jsdom, use the `/verify` skill.
4. **Critique** — run `/constructive-critique` on the change. *Verify against reality*: probe edge cases the tests miss, adversarially. Apply the improvements it surfaces; iterate until clean. (For pure bug-hunting on a diff, `/code-review` instead.)
5. **Commit** at a working milestone. Convention prefix (`fix:`/`feat:`/`refactor:`/`test:`/…), *why* in the body, `Closes MAR-NN`, the Co-Authored-By trailer. **Push.**
6. **Update tracking** — Linear status + task list, as you go.

## 4. Decide wisely (the judgment layer)

- **Multi-dimensional lens:** weigh correctness, fidelity/safety, performance, security, maintainability, test quality & coverage, UX/UI, cohesion/consistency — apply what fits, name the trade-off.
- **Scope honestly:** if part of a ticket is clean and part is hard/risky, **ship the clean part and re-scope the rest** into the ticket (or a new one). Never force a fragile fix into fidelity-critical code for diminishing returns. Say what you're deferring and why.
- **CHANGELOG gate is observability, not effort:** user-visible behavior in (`### Fixed`/`Changed`/…); internal correctness/tooling out (it's in git). Review `docs/BENEFITS.md` and edit in place only if a capability's story changed.
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
