# Coding-agent bridge

How Birta lets AI coding agents see what the user has open and selected in the WYSIWYG editor. Source: `src/agentBridge/`, `shared/agentContext.ts`, `webview/agentContext.ts`.

## The problem

Every coding agent reads the same VS Code APIs for implicit context: `window.activeTextEditor`, its `.selection`, and `onDidChangeTextEditorSelection`. VS Code deliberately leaves `activeTextEditor` `undefined` while a custom editor is focused ([microsoft/vscode#102110](https://github.com/microsoft/vscode/issues/102110), closed *as-designed*). So while the user is in Birta, an agent (Copilot, Cursor, the Claude/Codex sidebars) sees no file, no caret, no selection.

This is structural, not a bug we can fix in Birta. The active-editor path is closed to us, so bridges are required.

## The shape: one neutral core, many thin adapters

```
webview selection ──(pull, on request only)──> MarkdownEditorProvider
   sourceCaretAt()                                  │ getActiveEditorContext()
   → EditorSelectionContext                         ▼
                        ┌───────────────┬───────────────┬────────────────┐
                        │ Reference     │ LanguageModel │ Public API     │
                        │ commands      │ Tool          │ (activate())   │
                        │ (any agent)   │ (Copilot)     │ (any extension)│
                        └───────────────┴───────────────┴────────────────┘
```

### The core

`EditorSelectionContext` (`shared/agentContext.ts`) is the file selection in document coordinates. It is produced in exactly one place, `webview/agentContext.ts`, reusing the block-level `sourceCaretAt` mapping. The extension side resolves it through `MarkdownEditorProvider.getActiveEditorContext()`.

### The adapters

Each adapter in `src/agentBridge/` projects that one core onto a different agent-ingestion surface. Reaching a new agent means adding an adapter; the core never changes. That is what keeps the design forward-looking: the agent ecosystem is young and churning (even Codex's own `/ide` selection context ships broken today), so nothing is bet on one vendor's protocol.

## Reachability: implicit vs explicit

A Family-A agent that runs *inside* VS Code and reads `activeTextEditor` cannot be fed implicit context by another extension. VS Code has no such API yet ([microsoft/vscode#252481](https://github.com/microsoft/vscode/issues/252481)). So the shipped adapters are all explicit or pull-based:

| Adapter | Reaches | Trigger |
|---|---|---|
| `referenceCommand` | every agent | user picks it from the editor's right-click menu (or the palette), pastes the reference |
| `invoke` | every agent with a CLI | user types `/ai <prompt>` in the document; Birta runs the configured command in a terminal |
| `languageModelTool` | Copilot agent mode, any LM-tool client | the model calls `#birtaSelection` |
| `publicApi` | any cooperating extension | caller invokes `getActiveEditorContext()` |

### `/ai`: a one-way invoke, and why it is not Family-B

`invoke` (`src/agentBridge/invoke.ts`) closes the last manual step of the reference path: instead of copying a reference and switching to the agent's panel, the user types `/ai <prompt>` at the caret and Birta hands the agent one prompt with the file and line span already named. The invocation is a `birta.ai.command` template run in a terminal, with placeholders substituted shell-quoted, so a prompt containing a quote or a `$` reaches the agent as typed rather than being split or expanded on the way.

It stays on the safe side of the boundary below, and the distinction is what makes it fileable at all. There is no socket, no server, no lockfile, no discovery entry and no auth: Birta composes a command line and runs it, the same shape as the Send Feedback command. It is rung 0b in [`NETWORK_POSTURE.md`](NETWORK_POSTURE.md), because Birta itself makes no request; the agent is the user's own tool acting under their own identity. `birta.ai.enabled` ships off, since picking the row spawns a process.

A template rather than a roster of harnesses, for the reason the adapter design already gives: the ecosystem is churning, and a shipped vendor list rots. Claude Code's CLI is the default; anything else is one setting.

Two limits are inherent to a one-way invoke and are not bugs to fix here. It cannot know when the agent finished, so nothing reports completion and the result arrives through the ordinary external-change path. And VS Code applies a disk change only to a CLEAN document, so Birta saves before invoking; if the user edits during the wait the agent's write lands as a disk-drift advisory instead of an edit. The window after the invoke cannot be closed from this side.

### Why Family-B is not built

Implicit (automatic) context needs a *Family-B* wire adapter, where the editor hosts the agent over a socket/stdio protocol and pushes selection changes. The candidates are the Claude Code IDE protocol (localhost WebSocket + MCP), the Codex `/ide` context, and Zed's [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol).

Family-B is deliberately not built. A Claude Code IDE endpoint (loopback WebSocket + MCP, lockfile discovery, the pull tool set) was implemented, merged (#150, 2026-07-28), live-tested against the real CLI, and removed the same day by owner decision (#151, `897db3a`). The maintainer judged the surface a liability: a second discovery entry masquerading as an "IDE", an authenticated local socket to maintain, and an experience that stays inert without a further `selection_changed` push half, and chose to prune it rather than carry it. Do not reintroduce a wire adapter without an explicit owner request.

Two facts from the live verification are worth keeping:

- Of an IDE MCP server's tools, the Claude CLI exposed only `getDiagnostics` to the model (observed live, CLI v2.1.220). Selection context flows exclusively through `selection_changed` push notifications, so a pull-only endpoint cannot deliver the implicit-context experience at all.
- The official Anthropic extension owns `~/.claude/ide/` discovery, and any future attempt must coexist with it. Its lockfiles had a real [origin-spoofing CVE](https://github.com/anthropics/claude-code/security/advisories/GHSA-9f65-56v6-gxw7) history.

## Performance: pull-only, zero cost when idle

The bridge is pull-based. The webview computes the context *only* when an agent requests it (`requestEditorContext` → `editorContextResult`), never on the editor's own selection-change path. Consequences:

- Typing and selecting cost the bridge nothing until an agent actually asks: no timer, no mapping, no message. A disabled or unused feature is free, per the launch-perf rules in `AGENTS.md`.
- The mapping (`sourceCaretAt`) walks only the blocks the caret and anchor sit in, and reads the cached `lineMap` and cached markdown source (re-split into lines per pull, the same pattern as the mode-switch caret). It never serializes the document.
- A wedged webview degrades to "no context" after a 1s timeout rather than hanging the caller.

### Staleness

`lineMap` and `sourceLines` reflect the last sync, while the ProseMirror selection is always live. On a caret move they agree. Mid-edit-burst the mapped line can trail by the sync cadence, which is acceptable for advisory context, and it self-heals on the next sync.
