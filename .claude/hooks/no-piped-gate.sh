#!/bin/bash
# PreToolUse hook (Bash matcher): block gate commands whose exit code is
# replaced by a filter's.
#
# `pnpm test 2>&1 | tail -8` exits with tail's code — a red gate reads
# green, and the failure detail is thrown away with it. MAR-141 carried
# this as prose ("Never pipe a gate through tail") and one session broke
# it twice anyway, so the rule is code now, in the repo's changelog-guard
# tradition: the prose is not the control.
#
# Two shapes of the same masking are blocked, because the code the caller
# reads is the LAST command's either way:
#
#   1. the pipe   — a gate piped into a filter
#   2. the chain  — a command that ENDS in a filter, a gate earlier in it
#
# The second was found the way the first was. A full e2e sweep passed with
# 1269 checks and exit 0, and was reported as FAILED, because the trailing
# filter looking for failures correctly found none and exited 1.
#
# Gates recognized: pnpm test / typecheck / perf*, vitest, node e2e/*.
# Filters: tail head grep sed awk tee wc cut sort uniq.
#
# Sanctioned alternatives (what the pipe was reaching for, minus the
# masking): the grind skill's own scripts/gate.sh, invoked as
# `gate.sh --tail N -- <cmd>`, or redirect to a file, keep $? in a
# variable, and exit on it. The skill ships in the harlanlewis plugin,
# whose install path is content-hashed and changes on every update, so
# resolve it from the skill's base directory rather than writing a path
# here.
#
# KNOWN FALSE POSITIVE: the payload is the raw command string, so a
# heredoc that merely QUOTES one of these shapes (this file's own docs,
# for one) trips it. Write such a file with an editor tool instead of a
# heredoc. Widening the parser to understand heredocs would cost more
# than the workaround.
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
GATE = r"(?:pnpm(?: run)?\s+(?:test|typecheck|perf)|npx\s+vitest|vitest\s+run|node\s+\S*e2e/)"
SEG = r"(?:[^|;&]|>&|&>)*"
FILTER_WORD = r"(?:tail|head|grep|sed|awk|tee|wc|cut|sort|uniq)"
FILTER = r"\|\s*" + FILTER_WORD + r"\b"

ALTERNATIVES = (
    "Use the grind skill's scripts/gate.sh (--tail N -- <cmd>), or keep the\n"
    "status and exit on it:\n"
    "  <gate> > /tmp/out.log 2>&1; code=$?; <filter> /tmp/out.log; exit $code\n"
    "To retire this policy: rm .claude/gate-pipe-guard"
)

if re.search(GATE + SEG + FILTER, cmd):
    print(
        "gate-pipe-guard: this pipes a gate through a filter, which replaces the\n"
        "gate's exit code with the filter's — a red gate reads green (MAR-141).\n"
        + ALTERNATIVES,
        file=sys.stderr,
    )
    sys.exit(2)

# Shape 2: the whole command ENDS in a filter, so the shell reports that
# filter's status. A pipeline's status is its last stage's, so look at the
# final segment's last pipe stage rather than the segment's first word —
# which is what a trailing `cat log | grep FAIL` needs.
if re.search(GATE, cmd):
    segments = [seg for seg in re.split(r";|&&|\|\|", cmd) if seg.strip()]
    if segments:
        last_stage = segments[-1].split("|")[-1].strip()
        if re.match(r"^" + FILTER_WORD + r"\b", last_stage):
            print(
                "gate-chain-guard: this command ENDS in a filter, so the shell reports\n"
                "the filter's exit code and not the gate's — the same masking as a piped\n"
                "gate, one separator over. A passing 1269-check sweep was reported as\n"
                "FAILED this way, because its trailing failure-grep correctly found none.\n"
                + ALTERNATIVES,
                file=sys.stderr,
            )
            sys.exit(2)
sys.exit(0)
PY
