# Coding-agent bridge

How Birta lets AI coding agents see what the user has open and selected in the
WYSIWYG editor. Source: `src/agentBridge/`, `shared/agentContext.ts`,
`webview/agentContext.ts`.

## The problem

Every coding agent reads the same VS Code APIs for implicit context —
`window.activeTextEditor`, its `.selection`, and `onDidChangeTextEditorSelection`.
VS Code **deliberately** leaves `activeTextEditor` `undefined` while a custom
editor is focused ([microsoft/vscode#102110](https://github.com/microsoft/vscode/issues/102110),
closed *as-designed*). So while the user is in Birta, an agent — Copilot,
Cursor, the Claude/Codex sidebars — sees no file, no caret, no selection. This
is structural, not a bug we can fix in Birta; the active-editor path is closed
to us. Bridges are required.

## The shape: one neutral core, many thin adapters

```
webview selection ──(pull, on request only)──▶ ContextStore (provider)
   sourceCaretAt()                                  │ getActiveEditorContext()
   → EditorSelectionContext                         ▼
                        ┌───────────────┬───────────────┬────────────────┐
                        │ Reference     │ LanguageModel │ Public API     │
                        │ commands      │ Tool          │ (activate())   │
                        │ (any agent)   │ (Copilot)     │ (any extension)│
                        └───────────────┴───────────────┴────────────────┘
```

- **The core** is `EditorSelectionContext` (`shared/agentContext.ts`): the file
  selection in document coordinates. It is produced in exactly one place
  (`webview/agentContext.ts`, reusing the block-level `sourceCaretAt` mapping)
  and resolved on the extension side by
  `MarkdownEditorProvider.getActiveEditorContext()`.
- **Adapters** (`src/agentBridge/*`) each project that one core onto a different
  agent-ingestion surface. Reaching a new agent means adding an adapter; the
  core never changes. This is the forward-looking property — the agent
  ecosystem is young and churning (even Codex's own `/ide` selection context
  ships broken today), so nothing is bet on one vendor's protocol.

## Reachability — implicit vs explicit

The honest constraint: a Family-A agent that runs *inside* VS Code and reads
`activeTextEditor` cannot be fed **implicit** context by another extension —
VS Code has no such API yet ([microsoft/vscode#252481](https://github.com/microsoft/vscode/issues/252481)).
So the shipped adapters are all **explicit or pull-based**:

| Adapter | Reaches | Trigger |
|---|---|---|
| `referenceCommand` | every agent | user picks it from the right-click Copy menu (or palette), pastes the reference |
| `languageModelTool` | Copilot agent mode, any LM-tool client | the model calls `#birtaSelection` |
| `publicApi` | any cooperating extension | caller invokes `getActiveEditorContext()` |

**Implicit** (automatic) context needs a *Family-B* wire adapter — where the
editor hosts the agent over a socket/stdio protocol and pushes selection changes:
the Claude Code IDE protocol (localhost WebSocket + MCP), the Codex `/ide`
context, and Zed's [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol).
**Family-B is deliberately not built.** A Claude Code IDE endpoint (loopback
WebSocket + MCP, lockfile discovery, the pull tool set) was implemented, merged
(#150, 2026-07-28), live-tested against the real CLI, and **removed the same
day by owner decision** (the revert commit this sentence shipped in): the
maintainer judged the surface a liability — a second discovery entry
masquerading as an "IDE", an authenticated local socket to maintain, and an
experience that stays inert without a further `selection_changed` push half —
and chose to prune it rather than carry it. Do not reintroduce a wire adapter
without an explicit owner request. Two facts from the live verification worth
keeping: the Claude CLI exposes only `getDiagnostics` (and notebook
`executeCode`) from an IDE MCP server to the model — selection context flows
exclusively through `selection_changed` push notifications, so a pull-only
endpoint cannot deliver the implicit-context experience at all; and the
official Anthropic extension owns `~/.claude/ide/` discovery (its lockfiles
had a real [origin-spoofing CVE](https://github.com/anthropics/claude-code/security/advisories/GHSA-9f65-56v6-gxw7)
history), which any future attempt must coexist with.

## Performance: pull-only, zero cost when idle

The bridge is **pull-based**: the webview computes the context *only* when an
agent requests it (`requestEditorContext` → `editorContextResult`), never on the
editor's own selection-change path. Consequences:

- Typing and selecting cost the bridge **nothing** — no timer, no mapping, no
  message — until an agent actually asks. A disabled/unused feature is free, per
  the launch-perf rules in `AGENTS.md`.
- The mapping (`sourceCaretAt`) walks only the blocks the caret/anchor sit in
  and reads the cached `lineMap` and cached markdown source (re-split into
  lines per pull, the same pattern as the mode-switch caret); it never
  serializes the document.
- A wedged webview degrades to "no context" after a 1s timeout rather than
  hanging the caller.

**Staleness note:** `lineMap`/`sourceLines` reflect the last sync, while the
ProseMirror selection is always live. On a caret move they agree; mid-edit-burst
the mapped line can trail by the sync cadence — acceptable for advisory context,
and it self-heals on the next sync.
