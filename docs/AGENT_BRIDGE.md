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

What the parse can and cannot learn is the part to re-derive rather than trust, and the fixtures in `harnessCapabilities.test.ts` are captured from real binaries because a parser written against one CLI was correct for one CLI. Each capture carries the version it was taken from and the date, because a CLI's help changes when its vendor ships and a fixture with no provenance later reads as a regression of ours. Two rows of the table have no fixture: Continue and Crush were read by hand on the date shown, and nothing in the suite pins what the parser makes of either.

The surveyed harnesses, each run through the parser and then checked by hand against its own help text:

| Harness | Version, date read | Flag line | Effort flag | Values |
|---|---|---|---|---|
| Claude Code | 2.1.278, 2026-09-19 | `--model <model>`, same line | `--effort` | `(low, medium, …)` |
| Codex | 0.149.0, 2026-09-19 | `-m, --model <MODEL>`, next line | none | none |
| pi | see the fixture | `--model <pattern>`, same line | `--thinking` | `: off, minimal, …` |
| GitHub Copilot CLI | 1.0.86, 2026-09-19 | `--model <model>`, next line | `--reasoning-effort` | `[possible values: none, minimal, …]` |
| Cline | 3.0.62, 2026-09-19 | `-m, --model <model-id>`, same line | `--thinking` | `none\|low\|medium\|high\|xhigh` |
| Gemini CLI | 0.60.0, 2026-09-19 | `-m, --model`, no metavar | none | none |
| opencode | 1.18.31, 2026-09-20 | `-m, --model`, no metavar | none | none |
| Qwen Code | 0.24.2, 2026-09-20 | `-m, --model`, no metavar | none | none |
| Continue | 1.5.47, 2026-09-19 | `--model <slug>`, same line | none | none |
| aider | 0.86.2, 2026-09-19 | `--model MODEL`, same line | `--reasoning-effort`, by name | none published |
| Crush | 0.95.0, 2026-09-19 | not read, see below | not read | not read |

Five consequences worth keeping. A short alias may precede the long flag and the description may sit on the following indented line, both clap conventions, and missing them made Codex report no model support at all while documenting one. Some formatters print no metavar at all: yargs writes `-m, --model  Model  [string]`, so a flag that takes a value and a switch are the same shape and only the trailing type annotation tells them apart, and requiring a metavar found not one flag in the whole of Gemini CLI, opencode or Qwen Code. A value list has four spellings, of which two were missing: clap's own bracketed `[possible values: …]`, where GitHub Copilot CLI publishes a seven-rung scale that read as no scale at all, and a piped run of alternatives, which is how Cline spells its rungs. The reasoning control has no single name, so `EFFORT_FLAGS` holds the spellings and the discovered one travels in `effortFlag`: writing `--effort` at a harness that says `--thinking` is a command that fails rather than a request that differs. And a harness may genuinely have no such flag, which Codex does not, so no effort control is the right answer there rather than a guessed one.

The value shapes matter more than the name list, and a flag found only by NAME should be read as a warning that its values were not understood. Such a flag reaches the panel with an empty scale, and the two halves are coupled: the composer's effort menu offers a free-text row exactly when `efforts` is empty, so a spelling added to `EFFORT_FLAGS` without that row is a button opening onto nothing. aider is the one harness on the survey that arrives this way, documenting `--reasoning-effort` and publishing no values for it.

Free text is offered for effort ONLY in that case, and always for the model, which is the one asymmetry between the two pickers and is deliberate. A model list is examples, so a name missing from it may work; an effort list is an enumeration read off the flag's own documented values, and the formatters that print one (clap's `possible values`, yargs' `choices`) reject anything outside it, so a typed rung beside a published scale is a command that fails rather than a request that differs. Making the two pickers uniform in either direction is the bug.

One harness is still read incompletely, and it is recorded rather than papered over.

The survey reached what npm and PyPI publish. A harness distributed only by its own `curl | bash` installer (Cursor CLI and Hermes are the two that came up) cannot be read without putting a binary on the machine, so none is claimed either way here: adding one is a capture, a fixture and a row, and nothing else has to change unless its help breaks a shape.

Crush needs three things this parser does not do. It separates an alias from its long flag with a space rather than a comma (`-m --model`), which a looser pattern would accept at the cost of reading one long flag as another's alias; it prints no metavar and no type annotation, so nothing distinguishes a switch; and its `--model` is on the `run` subcommand rather than the root, which the probe never asks about because it executes only the template's first word.

Those spellings are the only vendor knowledge in the module, and they are the stable half: what a CLI calls its reasoning knob changes far more slowly than which models it offers, and a name missing from the list costs one absent control rather than a wrong flag.

Models remain the weak case, and the survey strengthened rather than weakened that. The model paragraph goes through the same two passes, an enumeration first and quoted examples second, and of the ten harnesses above not one publishes its catalog in help: Claude Code gives prose examples and GitHub Copilot CLI gives the single alias `auto`, while the rest give nothing in the flag's own paragraph and several offer a separate `--list-models` or `models` command instead. So a catalog can exist, and `modelExamples` is named for the weaker case because the weaker case is what is always there so far. A model absent from it may work perfectly well, which is why free entry is always reachable in the panel. Anything that renders `modelExamples` as "the models", or that drops free entry because the list looks complete, is a bug.

A probe that finds nothing is the graceful floor rather than a failure to paper over: the control is not offered, and the user's template runs as it always did. Never a wrong flag, at worst an absent picker.

Picking a model rewrites the flag in the user's existing template (`setTemplateFlag`), for that one request. The setting is never written, and the writer and the reader (`agentModelName`) are pinned to agree by a round-trip test, or the hint would name a different model from the one about to run.

Two boundaries hold that honest. The raw template never crosses into the webview: it is the user's machine config and a shell command, and the summary carries no part of it. And `agentModelName` reads only the unambiguous long forms (`--model x`, `--model=x`), never `-m` and never `--fallback-model`, and reports nothing when the template names nothing. Absent is not "the default model": an alias resolves inside the CLI, and a name printed here would be a guess in front of someone deciding whether to press Enter.

### What a background run says while it runs

A background `/ai` run used to be a marker in the gutter and silence until it ended, which left no way to tell a harness that is thinking from one that is waiting on a permission prompt or a network call. While a run is live there is now a quiet line in the corner: the harness, what it is doing, and, once a run has been going long enough for the question to arise, how long it has been going. It updates in place on the one toast surface, never stacks, takes no focus, offers nothing to click, and goes when the run does. The gutter marker is still the only control. Nothing about it is persisted: it is not in the document, not in the view-state bag, and a reload leaves nothing behind claiming a run that is no longer there.

Two halves, and the seam between them is one message. The host reduces its child process's output to one short line and posts `agentProgress { requestId, line }`; the page renders exactly what it is given (`webview/plugins/agentPending.ts`, `docs/HOSTING.md`). A host with no way to read its harness lands on the floor rather than on nothing: the page's own clock names the harness and says how long it has been going. That does not say a run is thinking rather than waiting, which only the harness's own events can; what it says is that the run is still there and how long it has been, which is what somebody deciding whether to wait has to go on when nothing else can be read.

The reading half is `src/agentBridge/agentProgress.ts`, and it tells harnesses apart by the SHAPE of what they print rather than by name. Two structured shapes are recognized, each reduced from output captured from a real run, with the version and the date, the way the help fixtures are:

| Shape | Captured from | What a line is made of |
|---|---|---|
| Content blocks: an envelope per message, `content` blocks of `text`, `tool_use` and `thinking`, every event stamped with its session | Claude Code 2.1.278, `--output-format stream-json --verbose`, 2026-09-20 | the tool and the file it names, the opening of a narration, or the word `Thinking` |
| Items: a flat event per thread, turn and item, the item carrying its own kind | Codex 0.149.0, `codex exec --json`, 2026-09-20 | the command run, the file changed, or the opening of an agent message |
| Anything else | every harness, no capture needed | the last plain line, with the terminal's own colouring and redraws taken out |

Reasoning CONTENT is never rendered, and that is a rule rather than a limit of the reducer. A harness's thinking may be private by policy, and the one shape above that carries thinking blocks at all sends them with the text removed and a signature in its place, so there is nothing to show even where it is offered. A thinking step gets the word alone. A corner is not a transcript, and a model that narrates nothing is served by the clock rather than by a summary invented for it.

Birta does not add the flag that turns any of this on. Adding an argument to a command line somebody else wrote is how a request fails rather than differs, which is the rule the capability probe already keeps, and one of the two flags above has a prerequisite that no help text states (Claude Code's `--output-format stream-json` needs `--verbose`, which only its error says). What Birta does own is the templates its own first-use picker offers, and both background ones ask for events. A template that asks for none still runs exactly as it did, and the notice is the clock. The terminal templates ask for none on purpose: the user is reading that output, and events read worse than prose.

One consequence to know before changing a template: a run whose stdout is events has no prose tail, so the two reports that used to quote one (a run that failed, a run that changed nothing) quote the harness's own last words out of the events instead. The whole transcript still reaches the Birta AI output channel as printed, which for a structured run means JSON.

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
