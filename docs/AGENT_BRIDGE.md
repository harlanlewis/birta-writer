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
| `askAgent` | every agent the user runs | user types `/ai <request>` at the caret (or runs Ask Agent from the palette); Birta composes the request plus the caret's `path.md#L12` reference into one line, saves the document, and hands the line to a shell command (a child process in the background by default, or one reused terminal, per `birta.agent.mode`), the Chat view, or the clipboard per `birta.agent.command`. One request per run, no conversation and no reply pane; a background run shows a stop pill in the gutter until its process exits, and the edit it brings back enters the undo history like a paste (see `plugins/agentPending.ts`) |
| `languageModelTool` | Copilot agent mode, any LM-tool client | the model calls `#birtaSelection` |
| `publicApi` | any cooperating extension | caller invokes `getActiveEditorContext()` |

### Which model answers, and how the editor says it

`birta.agent.command` is one free-form shell template, and that is the whole model control: `--model` and `--effort` are the harness's own flags, so `claude -p {prompt} --permission-mode acceptEdits --model haiku --effort low` gives Birta a different model from the one the same CLI uses interactively. There is deliberately no `birta.agent.model` setting. A structured one would need per-harness flag grammar (`claude --model X` against `codex exec -c model_reasoning_effort=high`), which is exactly the vendor list this design refuses to carry, and it would mean nothing for the `chat` and `clipboard` routes.

What the template costs is legibility, so the editor reads it back. `describeAgentRoute` reduces the setting to display facts (`configured`, `kind`, `harness`, `model`, `mode`) and the provider pushes them to the webview as `agentRoute`, on init and on every `birta.agent.*` change. The slash menu shows the sentence at the caret while the `/ai` pill is committed and empty.

### Asking the harness what it accepts

The composer (`/ai-advanced`) offers a model and an effort, which are flags on somebody else's CLI. There are three places that knowledge could come from: a list Birta ships, a list the user maintains, or the harness. Only the third both stays current and costs no configuration, so `src/agentBridge/harnessCapabilities.ts` reads the configured binary's own `--help`, and `harnessProbe.ts` runs it once per harness version and caches the answer in `globalState`. Nothing in the tree names a vendor, a model, or a flag value.

The probe spawns the binary twice, with `--version` and `--help` and no shell, so it is kicked off when a document opens and nothing waits on it. Time it with `time claude --help` rather than trusting a figure here; it is fast enough to cache and too slow to sit in front of a panel.

What the parse can and cannot learn is the part to re-derive rather than trust, and the fixtures in `harnessCapabilities.test.ts` are captured from three real binaries because a parser written against one CLI was correct for one CLI. The three differ in every way that matters:

| Harness | Flag line | Description | Effort flag | Values |
|---|---|---|---|---|
| Claude Code | `--model <model>` | same line | `--effort` | `(low, medium, …)` |
| Codex | `-m, --model <MODEL>` | next line | none | none |
| pi | `--model <pattern>` | same line | `--thinking` | `: off, minimal, …` |

Three consequences worth keeping. A short alias may precede the long flag and the description may sit on the following indented line, both clap conventions, and missing them made Codex report no model support at all while documenting one. The reasoning control has no single name, so `EFFORT_FLAGS` holds the spellings and the discovered one travels in `effortFlag`: writing `--effort` at a harness that says `--thinking` is a command that fails rather than a request that differs. And a harness may genuinely have no such flag, which Codex does not, so no effort control is the right answer there rather than a guessed one.

Those spellings are the only vendor knowledge in the module, and they are the stable half: what a CLI calls its reasoning knob changes far more slowly than which models it offers, and a name missing from the list costs one absent control rather than a wrong flag.

Models remain the weak case. The model paragraph goes through the same two passes, an enumeration first and quoted examples second, and of the three, Claude Code gives examples, Codex gives nothing, and pi gives nothing in the flag's own paragraph while offering `--list-models` elsewhere. So a catalog can exist, and `modelExamples` is named for the weaker case because the weaker case is what is usually there. A model absent from it may work perfectly well, which is why free entry is always reachable in the panel. Anything that renders `modelExamples` as "the models", or that drops free entry because the list looks complete, is a bug.

A probe that finds nothing is the graceful floor rather than a failure to paper over: the control is not offered, and the user's template runs as it always did. Never a wrong flag, at worst an absent picker.

Picking a model rewrites the flag in the user's existing template (`setTemplateFlag`), for that one request. The setting is never written, and the writer and the reader (`agentModelName`) are pinned to agree by a round-trip test, or the hint would name a different model from the one about to run.

Two boundaries hold that honest. The raw template never crosses into the webview: it is the user's machine config and a shell command, and the summary carries no part of it. And `agentModelName` reads only the unambiguous long forms (`--model x`, `--model=x`), never `-m` and never `--fallback-model`, and reports nothing when the template names nothing. Absent is not "the default model": an alias resolves inside the CLI, and a name printed here would be a guess in front of someone deciding whether to press Enter.

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
