---
name: grind
description: Autonomous backlog loop — review Linear, prioritize, pick work, and ship it end-to-end with iterative self-critique, tracking, and cleanup. Triggers: /grind, "review the backlog and get after it", "pick something and ship it", "work the backlog autonomously".
version: 1.0.0
---

# Grind — autonomous backlog loop

## Purpose

Turn "review the backlog and get after it" into a disciplined, repeatable loop: orient → pick by principle → understand → implement/test/critique/ship per milestone → track & groom → hand off → clean up. High agency, bounded by principle. Act when you have enough to act; ask only on genuine judgment calls.

Optional `$ARGUMENTS` narrow the scope (e.g. `/grind phase-0 fidelity bugs`, `/grind MAR-120`). With none, work the active queue.

***

## 0. Orient & prioritize (once)

- Pull the backlog from **Linear** (team **Markdown Editor**, `MAR-` prefix) — use the Linear MCP tools or the `/devlog` skill. Read the board's signal: `Todo`/active queue vs `Backlog`, and the `phase-*` / `priority` labels (the roadmap spine — `phase-0-fidelity` is existential and comes first; see `CLAUDE.md` → Issue tracking).
- **Pick by principle, not convenience.** Existential tiers first; prefer well-scoped work with a clear repro over a vague large ticket. Honor `$ARGUMENTS` if given.
- State the pick and *why* in one line, then go. Don't narrate options you won't pursue.
- Set up a task list (`TaskCreate`) for the chosen items; keep it current as you work.

## 1. Understand before acting

- Read the ground truth in order: the failing test / repro → the implementation it exercises → the surrounding architecture and conventions (`CLAUDE.md`, `docs/DESIGN_PRINCIPLES.md`).
- **Push big or noisy reads into subagents** (out-of-context summarization, broad multi-file searches). Relay conclusions, not file dumps.
- **Lanes / parallelism:** fan out subagents for *independent* work (separate files, independent investigation). Do **not** fan out edits that touch shared files — coordinate those yourself and name the coordination point. Send parallel subagents in one message so they run concurrently.

## 2. The work loop (per ticket / milestone)

Repeat for each unit of work. Mark the task `in_progress` when you start it.

1. **Reproduce** — confirm the behavior empirically. A throwaway probe test/script is fine; delete it after (never leave `_dbg`/`_probe` files behind).
2. **Implement** the smallest correct fix that matches the codebase's existing patterns (idioms, comment density, naming — not just "make it pass"). Respect the architecture constraints in `CLAUDE.md`.
3. **Test** — reproduce-then-fix:
   - Add/pin a regression test (for a fidelity repro, promote its `it.fails` and remove the matching gate exclusion).
   - `pnpm test <focused>` → then full `pnpm test`; `pnpm typecheck`; `pnpm build`.
   - For webview runtime behavior beyond jsdom, use the `/verify` skill.
4. **Critique** — run `/constructive-critique` on the change. *Verify against reality*: probe edge cases the tests miss, adversarially. Apply the improvements it surfaces; iterate until clean. (For pure bug-hunting on a diff, `/code-review` instead.)
5. **Commit** at a working milestone. Convention prefix (`fix:`/`feat:`/`refactor:`/`test:`/…), *why* in the body, `Closes MAR-NN`, the Co-Authored-By trailer. **Push.**
6. **Update tracking** — Linear status + task list, as you go.

## 3. Decide wisely (the judgment layer)

- **Multi-dimensional lens:** weigh correctness, fidelity/safety, performance, security, maintainability, test quality & coverage, UX/UI, cohesion/consistency — apply what fits, name the trade-off.
- **Scope honestly:** if part of a ticket is clean and part is hard/risky, **ship the clean part and re-scope the rest** into the ticket (or a new one). Never force a fragile fix into fidelity-critical code for diminishing returns. Say what you're deferring and why.
- **CHANGELOG gate is observability, not effort:** user-visible behavior in (`### Fixed`/`Changed`/…); internal correctness/tooling out (it's in git). Review `docs/BENEFITS.md` and edit in place only if a capability's story changed.
- **Verify against the code, not the CHANGELOG,** before calling anything done.

## 4. Track & discover (keep the backlog honest)

- **File issues for discovered work immediately** — pre-existing bugs, footguns, follow-ups — via `/devlog`. Don't silently absorb or drop them.
- **Groom as you go:** cross-check whether the change *incidentally fixed* another open ticket (same root cause) — verify against the working tree, pin a regression test, close it. This catches silently-shipped work.
- **Close the loop both directions:** `Closes MAR-NN` in the commit; SHA + status comment in the ticket. On a **squash** merge, the branch commits are rewritten — cite the **merge** SHA, not the branch SHAs.

## 5. Land it

- Branch first if on `main` (`lewish/<slug>`). At a solid milestone open a PR (`gh pr create`) with a summary, the tickets, and the verification done.
- **Wait for CI green** (`gh pr checks <n> --watch`), then merge matching the repo convention — **squash** (`gh pr merge <n> --squash --delete-branch`). Pull `main`.
- Move shipped tickets to `Done` with the merge SHA; re-scope partials (update title/description, leave open).

## 6. Hand off & clean up after yourself

- Run the `CLAUDE.md` **end-of-work handoff** whenever `src/`, `webview/`, `shared/`, or `package.json` changed: `pnpm test` green → CHANGELOG → review BENEFITS → `pnpm run package` → install the VSIX + remove any legacy build → tell the user to **reload** (Cmd+Shift+P → "Developer: Reload Window").
- **Leave the tree tidy:** delete merged branches (local + remote), remove stale worktrees, `git fetch --prune`. Before any destructive branch/worktree op:
  - **Classify merged vs unmerged.** `git branch --merged` misses squash-merges — verify via `gh pr list --head <branch>` (a deleted remote + a `MERGED` PR = safe).
  - **Ask before deleting anything that would lose work** (unmerged/closed-unmerged branches). Review the actual content first — is its unique artifact already on `main`? is it superseded? — don't guess.

## Cross-cutting stance

- **Act on sensible defaults; ask only on genuine judgment calls** the code/context can't resolve (deleting unmerged work, a fidelity policy decision, a user-facing trade-off). Note the default you picked when you don't ask.
- **Report faithfully at the end:** what shipped (and where — merge SHA), what's deferred and why, what's still red, tickets created/closed/re-scoped. Distinguish what's in the CHANGELOG (user-observable) from what shipped but is internal by design.
