#!/bin/bash
# PreToolUse hook (Bash matcher): block gate commands piped into filters.
#
# `pnpm test 2>&1 | tail -8` exits with tail's code — a red gate reads
# green, and the failure detail is thrown away with it. MAR-141 carried
# this as prose ("Never pipe a gate through tail") and one session broke
# it twice anyway, so the rule is code now, in the repo's changelog-guard
# tradition: the prose is not the control.
#
# Blocks: a known gate/suite invocation (pnpm test / typecheck / perf*,
# vitest, node e2e/perf*) whose own command segment is piped into
# tail/head/grep/sed/awk/tee/wc/cut. Everything else passes untouched.
#
# Sanctioned alternatives (what the pipe was reaching for, minus the
# masking): .claude/skills/grind/scripts/gate.sh --tail N -- <cmd>, or
# redirect to a file and print $? explicitly.
#
# To retire this policy: rm .claude/gate-pipe-guard
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[[ -f "$ROOT/.claude/gate-pipe-guard" ]] || exit 0

# The payload rides an env var, NOT python's stdin: `python3 - <<heredoc`
# makes the heredoc python's stdin, so a json.load(sys.stdin) there reads
# the program's own text stream at EOF and the hook silently never fires.
# Caught by probing this hook with the session's real offender commands.
HOOK_PAYLOAD="$(cat)"
export HOOK_PAYLOAD

python3 - <<'PY'
import json, os, re, sys

try:
    payload = json.loads(os.environ.get("HOOK_PAYLOAD") or "{}")
except Exception:
    sys.exit(0)  # unparseable input is not this hook's problem

cmd = (payload.get("tool_input") or {}).get("command") or ""

# A gate invocation, then a pipe before that segment ends. SEG keeps the
# match inside one command segment — it stops at ; and at && separators so
# `ls | grep x && pnpm test` passes — while still crossing the & inside
# redirects (2>&1, &>), which is where the first version went blind: its
# plain [^|;&]* could not reach the pipe in `pnpm test 2>&1 | tail`.
GATE = r"(?:pnpm(?: run)?\s+(?:test|typecheck|perf)|npx\s+vitest|vitest\s+run|node\s+\S*e2e/perf)"
SEG = r"(?:[^|;&]|>&|&>)*"
FILTER = r"\|\s*(?:tail|head|grep|sed|awk|tee|wc|cut)\b"

if re.search(GATE + SEG + FILTER, cmd):
    print(
        "gate-pipe-guard: this pipes a gate through a filter, which replaces the\n"
        "gate's exit code with the filter's — a red gate reads green (MAR-141).\n"
        "Use .claude/skills/grind/scripts/gate.sh --tail N -- <cmd> for short\n"
        "output with the real exit code, or redirect to a file and print $?.\n"
        "To retire this policy: rm .claude/gate-pipe-guard",
        file=sys.stderr,
    )
    sys.exit(2)
sys.exit(0)
PY
