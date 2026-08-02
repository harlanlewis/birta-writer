#!/bin/bash
# Per-worktree setup, run by the harlanlewis plugin's WorktreeCreate hook after
# it has created the worktree and run `pnpm install`.
#
# Env provided by the caller: WORKTREE_PATH, REPO_ROOT, WORKTREE_NAME,
# WORKTREE_BRANCH, WORKTREE_DESCRIPTION. CWD is the new worktree.
#
# Failure here is non-fatal — the caller warns and still returns the worktree.
#
# THIS FILE MUST BE COMMITTED AND PUSHED to take effect. A worktree is a fresh
# checkout, and `worktree.baseRef` defaults to "fresh" — branching from the
# default branch ON THE REMOTE — so an uncommitted or unpushed version of this
# script simply is not present in the worktree and silently never runs.
set -uo pipefail

log() { printf '[birta-writer setup] %s\n' "$*" >&2; }

# .vscode-test is a 1.0 GB download of VS Code used by the integration suite
# (`pnpm test:integration`). It is gitignored, so a fresh worktree has none, and
# re-downloading it per worktree is the single most expensive thing about
# parallel sessions here. Link it instead — the suite only reads it.
#
# Safe to symlink INSIDE a worktree: Claude Code refuses worktree creation only
# when `.claude`, `.claude/worktrees`, or the worktree directory itself is a
# symlink (docs/en/worktrees, v2.1.212), not for contents.
if [[ -d "$REPO_ROOT/.vscode-test" && ! -e "$WORKTREE_PATH/.vscode-test" ]]; then
  ln -s "$REPO_ROOT/.vscode-test" "$WORKTREE_PATH/.vscode-test" \
    && log "linked .vscode-test from the main checkout" \
    || log "WARNING: could not link .vscode-test"
fi

# Unit tests (vitest) run straight off the TypeScript sources and need no build.
# The e2e Chromium harness and the integration suite both require dist/:
# e2e/run.mjs documents "pnpm build && pnpm test:e2e". Build once here so an
# agent that reaches for /verify isn't blocked.
if command -v pnpm >/dev/null 2>&1; then
  log "pnpm build"
  pnpm build >&2 || log "WARNING: pnpm build failed — dist/ is missing, so e2e and packaging will not run"
else
  log "WARNING: pnpm not found; skipped build"
fi

# Playwright browsers live in ~/Library/Caches/ms-playwright, which is
# machine-global and already shared across every worktree. Nothing to do.
