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
Those plug into the same `ActiveContextResolver`, but they are a **separate,
verification-gated increment**: they run authenticated local sockets (the Claude
one had a real [origin-spoofing CVE](https://github.com/anthropics/claude-code/security/advisories/GHSA-9f65-56v6-gxw7))
and must coexist with the official extensions that own the same lockfiles —
neither is safe to ship without end-to-end testing against the live CLIs. When
they land, `getActiveEditorContext` grows a push counterpart
(`onDidChangeContext`) and the adapters subscribe to it.

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
