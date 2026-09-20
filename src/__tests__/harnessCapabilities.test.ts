/**
 * Reading a harness's own `--help` for what it accepts
 * (src/agentBridge/harnessCapabilities.ts).
 *
 * Every fixture but one is captured VERBATIM from a real binary, wrapping
 * and all, because the thing under test is a parse of real help text and a
 * fixture written by hand would only prove the parser agrees with its
 * author. The neighbouring flags are kept for the same reason: paragraph
 * boundaries are where this parse fails, so the test has to contain some.
 *
 * Each capture carries the binary's VERSION and the date it was taken,
 * because a CLI's help is not a stable target. It changes when its vendor
 * ships, and a fixture with no provenance later reads as "we regressed"
 * when it means "they changed".
 *
 * The invariant that matters most is negative. `--fallback-model` sits next
 * to `--model` and means something else entirely, and an effort scale
 * invented rather than read would be a wrong control in front of someone
 * about to spend money.
 */
import { describe, it, expect } from "vitest";
import {
    allFlags,
    EFFORT_FLAGS,
    effortFlagFromValues,
    enumeratedValues,
    helpParagraph,
    parseHarnessHelp,
    quotedExamples,
} from "../agentBridge/harnessCapabilities";
import { agentEffortName, agentModelName, setTemplateFlag } from "../agentBridge/askAgent";

/**
 * Captured from `claude --help`. Its `--effort`, `--fallback-model` and
 * `--model` paragraphs were re-read unchanged against Claude Code 2.1.278 on
 * 2026-09-19.
 */
const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
                                        (ccpool_...).
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
                                        (shown in the prompt box, /resume
                                        picker, and terminal title)

Commands:
  agents [options]                      Manage background agents
`;

/**
 * Captured from `codex --help`. Two things here broke the first parser, and
 * both are clap conventions rather than anything unusual: the long flag is
 * preceded by its short alias, and the description sits on the FOLLOWING
 * indented line rather than the flag's own. Codex reported no model support
 * at all while documenting `--model`.
 *
 * Re-read unchanged against codex-cli 0.149.0 on 2026-09-19, root help and
 * `codex exec --help` alike: still `-m, --model <MODEL>`, still no effort
 * flag on either, so reporting none remains the right answer rather than a
 * gap.
 */
const CODEX_HELP = `Usage: codex [OPTIONS] [PROMPT]

Options:
  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt

  -m, --model <MODEL>
          Model the agent should use

      --oss
          Use open-source provider

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]
`;

/**
 * Captured from `pi --help`. Its reasoning control is `--thinking`, not
 * `--effort`, and it lists the levels after a colon rather than in
 * parentheses. Both are why pi reported no effort support at all.
 */
const PI_HELP = `Usage:
  pi [options] [@files...] [messages...]

Options:
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --list-models [search]         List available models (with optional fuzzy search)
`;

/**
 * Python's argparse. Its metavar is a bare uppercase word rather than an
 * angled placeholder, the alias carries a metavar of its own
 * (`-m MESSAGE, --message MESSAGE`), and a long flag pushes its description
 * onto the next line. Nothing in this shape parsed at all until the metavar
 * pattern learned the bare form, which silently excluded most CLIs written
 * in Python.
 *
 * Synthetic rather than captured: it is argparse's documented output shape,
 * not a claim about any particular tool's flags. `AIDER_HELP` below is the
 * captured one, and the two disagree about exactly the thing a synthetic
 * fixture is bad at, which is worth reading before writing another.
 */
const ARGPARSE_HELP = `usage: agent [-h] [--model MODEL] [--reasoning-effort REASONING_EFFORT]

options:
  -h, --help            show this help message and exit
  --model MODEL         Specify the model to use for the main chat
  --reasoning-effort REASONING_EFFORT
                        Set the reasoning effort (low, medium, high)
  -m MESSAGE, --message MESSAGE
                        Specify a single message, process it, then exit
`;

/** click's variant of the same idea: an uppercase type name, no brackets. */
const CLICK_HELP = `Usage: tool [OPTIONS]

Options:
  --model TEXT      Which model to use
  --effort TEXT     Effort (low, medium, high)
`;

/** A harness offering neither flag: the shape that must produce no controls. */
const PLAIN_HELP = `Usage: someagent [options] <prompt>

Options:
  -h, --help                            Show help
  --verbose                             Chatty output
`;

/**
 * Captured from `aider --help`, aider 0.86.2, observed 2026-09-19.
 *
 * Real argparse, against which the synthetic `ARGPARSE_HELP` above turns out
 * to be optimistic in the one place it matters: aider DOES document
 * `--reasoning-effort`, and documents no values for it at all. So the shape
 * rule cannot see it and the name in `EFFORT_FLAGS` is what finds it, which
 * makes aider the one harness on the survey reaching the panel with a flag
 * and no scale, and therefore the one the composer's free-text effort row
 * exists for.
 *
 * The neighbours are kept because they are the traps: `-m` is `--message`
 * here rather than the model, `--list-models` puts a second long flag where
 * an alias goes, and three flags end in words that contain `model`.
 */
const AIDER_HELP = `usage: aider [-h] [--model MODEL] [--reasoning-effort REASONING_EFFORT]
             [--message COMMAND]

Main model:
  FILE                  files to edit with an LLM (optional)
  --model MODEL         Specify the model to use for the main chat [env var:
                        AIDER_MODEL]

Model settings:
  --list-models MODEL, --models MODEL
                        List known models which match the (partial) MODEL name
                        [env var: AIDER_LIST_MODELS]
  --alias ALIAS:MODEL   Add a model alias (can be used multiple times) [env
                        var: AIDER_ALIAS]
  --reasoning-effort REASONING_EFFORT
                        Set the reasoning_effort API parameter (default: not
                        set) [env var: AIDER_REASONING_EFFORT]
  --thinking-tokens THINKING_TOKENS
                        Set the thinking token budget for models that support
                        it. Use 0 to disable. (default: not set) [env var:
                        AIDER_THINKING_TOKENS]

Modes:
  --message COMMAND, --msg COMMAND, -m COMMAND
                        Specify a single message to send the LLM, process
                        reply then exit (disables chat mode) [env var:
                        AIDER_MESSAGE]
`;

/**
 * Captured from `cline --help`, Cline 3.0.62, observed 2026-09-19.
 *
 * Plain commander, so every flag parsed from the first day, and yet this is
 * the harness that proved the `EFFORT_FLAGS` fallback can land somewhere
 * worse than nowhere. Cline spells its rungs with PIPES, which no value
 * shape read, so `--thinking` was found by name with an empty scale behind
 * it: `supportsEffort` true, `efforts` empty, and a picker in the composer
 * whose only row is the default it already had.
 *
 * `--compaction` is kept because it is piped too and is not the scale.
 */
const CLINE_HELP = `Usage: cline [options] [command] [prompt]

Cline CLI - AI coding assistant in your terminal

Options:
  -p, --plan                    Run in plan mode
  --auto-approve <boolean>      Set tool auto-approval for all tools (default:
                                true)
  --thinking <level>            Set reasoning effort:
                                none|low|medium|high|xhigh. Bare --thinking uses
                                medium; omitted leaves provider default.
  --compaction <mode>           Context compaction mode: agentic|basic|off
                                (default: agentic)
  -m, --model <model-id>        Model to use for the session with the selected
                                provider
  -h, --help                    display help for command
`;

/**
 * Captured from `gemini --help`, Gemini CLI 0.60.0, observed 2026-09-19.
 *
 * yargs, and a fourth formatter shape: there is NO metavar anywhere. A flag
 * that takes a value and a flag that does not are printed identically, and
 * what tells them apart is the type yargs annotates at the end of the
 * paragraph. Requiring a metavar therefore found not one flag in the whole
 * of this file, so no model picker was offered and nothing said why.
 *
 * The booleans are kept because they are what the second pass must refuse:
 * `-y, --yolo` and `-m, --model` are the same shape up to the annotation.
 */
const GEMINI_HELP = `Usage: gemini [options] [command]

Options:
  -d, --debug                     Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -m, --model                     Model  [string]
  -p, --prompt                    Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]
  -s, --sandbox                   Run in sandbox?  [boolean]
  -y, --yolo                      Automatically accept all actions (aka YOLO mode)?  [boolean] [default: false]
      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --acp                       Starts the agent in ACP mode  [boolean]
  -o, --output-format             The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]
  -v, --version                   Show version number  [boolean]
  -h, --help                      Show help  [boolean]
`;

/**
 * Captured from `copilot --help`, GitHub Copilot CLI 1.0.86, observed
 * 2026-09-19.
 *
 * clap again, so the flag lines parsed from the first day. What did not is
 * the value list: clap writes an enumeration as `[possible values: ...]`,
 * and the colon shape cannot reach past the closing bracket, so a
 * seven-rung effort scale documented in plain sight read as no scale and
 * the flag naming itself `--reasoning-effort` was never reached either.
 *
 * Three bracketed lists are kept, because only one of them is the scale.
 */
const COPILOT_HELP = `Usage: copilot [OPTIONS] [COMMAND]

Options:
  -v, --version
          show version information
  -p, --prompt <text>
          Execute a prompt in non-interactive mode (exits after
          completion)
      --model <model>
          Set the AI model to use (use 'auto' to let Copilot pick
          automatically)
      --reasoning-effort <level>
          Set the reasoning effort level [possible values: none, minimal, low, medium, high, xhigh, max]
      --context <tier>
          Set the context window tier (overrides persisted setting) [possible values: default, long_context]
      --auto-tier <preference>
          Set the Auto routing profile [possible values: efficiency, balance, intelligence]
`;

describe("helpParagraph", () => {
    it("a flag's own paragraph should be found, unwrapped, and bounded by the next flag", () => {
        expect(helpParagraph(CLAUDE_HELP, "--effort"))
            .toBe("Effort level for the current session (low, medium, high, xhigh, max)");
    });

    it("a longer flag ending in the same word should not be read as the flag", () => {
        // `--fallback-model` names what runs when the first choice is
        // unavailable. Reading it as `--model` would set the wrong thing,
        // and the two are adjacent in the real help.
        const para = helpParagraph(CLAUDE_HELP, "--model");
        expect(para).toContain("Model for the current session");
        expect(para).not.toContain("fallback");
    });

    it("an absent flag should be null, not an empty paragraph", () => {
        // Null is what turns a control off. An empty string would read as
        // "present but says nothing" and would offer a picker that sets a
        // flag the harness does not take.
        expect(helpParagraph(PLAIN_HELP, "--model")).toBeNull();
        expect(helpParagraph(PLAIN_HELP, "--effort")).toBeNull();
        expect(helpParagraph(CLAUDE_HELP, "--nonexistent")).toBeNull();
    });

    it("the last flag before the commands section should still end cleanly", () => {
        expect(helpParagraph(CLAUDE_HELP, "-n, --name"))
            .toBe("Set a display name for this session (shown in the prompt box, /resume picker, and terminal title)");
    });
});

describe("enumeratedValues", () => {
    it("three or more parenthesised words should be the value list, in order", () => {
        expect(enumeratedValues("Effort level (low, medium, high, xhigh, max)"))
            .toEqual(["low", "medium", "high", "xhigh", "max"]);
    });

    it("a parenthetical that is prose should not become a scale", () => {
        // A guessed scale is worse than none: the user would be choosing
        // from values the harness never accepts.
        expect(enumeratedValues("Model for the session (defaults to your setting)")).toEqual([]);
        expect(enumeratedValues("Run in the background (fast, cheap)")).toEqual([]);
        expect(enumeratedValues("no parentheses at all")).toEqual([]);
    });
});

describe("quotedExamples", () => {
    it("quoted literals should be offered as suggestions, deduplicated", () => {
        expect(quotedExamples(helpParagraph(CLAUDE_HELP, "--model")!))
            .toEqual(["fable", "opus", "sonnet", "claude-fable-5"]);
    });
});

describe("setTemplateFlag", () => {
    const BASE = "claude -p {prompt} --permission-mode acceptEdits";

    it("a template carrying no such flag should gain it", () => {
        expect(setTemplateFlag(BASE, "--model", "opus"))
            .toBe("claude -p {prompt} --permission-mode acceptEdits --model opus");
    });

    it("a template already carrying it should have the value replaced, not doubled", () => {
        const once = setTemplateFlag(BASE, "--model", "opus");
        const twice = setTemplateFlag(once, "--model", "haiku");

        expect(twice).toBe("claude -p {prompt} --permission-mode acceptEdits --model haiku");
        expect(twice.match(/--model/g)).toHaveLength(1);
    });

    it("every spelling of an existing value should be replaced", () => {
        expect(setTemplateFlag("claude --model=sonnet {prompt}", "--model", "opus"))
            .toBe("claude --model opus {prompt}");
        expect(setTemplateFlag(`claude --model "claude-fable-5" {prompt}`, "--model", "opus"))
            .toBe("claude --model opus {prompt}");
    });

    it("undefined should remove the flag, because there is no value meaning default", () => {
        // Sending a literal "default" would be a model name the CLI rejects.
        // Absent is how "let the harness decide" is actually expressed.
        expect(setTemplateFlag("claude -p {prompt} --model opus", "--model", undefined))
            .toBe("claude -p {prompt}");
        expect(setTemplateFlag(BASE, "--model", undefined)).toBe(BASE);
    });

    it("a trailing {prompt} should stay last when a flag is appended", () => {
        // A CLI taking the prompt positionally would otherwise read the
        // flag's value as the prompt and send "opus" as the request.
        expect(setTemplateFlag("claude {prompt}", "--model", "opus"))
            .toBe("claude --model opus {prompt}");
    });

    it("what the panel sets should be exactly what the hint reads back", () => {
        // The round trip is the contract between the two halves: the writer
        // and the reader are separate functions and must agree, or the hint
        // names a model different from the one about to run.
        const withBoth = setTemplateFlag(setTemplateFlag(BASE, "--model", "opus"), "--effort", "xhigh");

        expect(agentModelName(withBoth)).toBe("opus");
        expect(agentEffortName(withBoth)).toBe("xhigh");
    });

    it("setting a model should not disturb a neighbouring flag of similar name", () => {
        const t = setTemplateFlag("claude --fallback-model sonnet {prompt}", "--model", "opus");

        expect(t).toContain("--fallback-model sonnet");
        expect(agentModelName(t)).toBe("opus");
    });
});

describe("parseHarnessHelp", () => {
    it("real help should yield a settable model, a discovered effort scale, and suggestions", () => {
        const caps = parseHarnessHelp("claude", "2.1.0\n", CLAUDE_HELP);

        expect(caps).toEqual({
            harness: "claude",
            version: "2.1.0",
            supportsModel: true,
            supportsEffort: true,
            modelFlag: "--model",
            effortFlag: "--effort",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            modelExamples: ["fable", "opus", "sonnet", "claude-fable-5"],
        });
    });

    it("a harness offering neither flag should offer no controls at all", () => {
        // The graceful floor: the user's template still runs exactly as it
        // does today, and the panel simply has no pickers to show.
        const caps = parseHarnessHelp("someagent", "0.1", PLAIN_HELP);

        expect(caps.supportsModel).toBe(false);
        expect(caps.supportsEffort).toBe(false);
        expect(caps.efforts).toEqual([]);
        expect(caps.modelExamples).toEqual([]);
    });

    it("a harness that DOES enumerate its models should have that list read", () => {
        // The claim "no CLI publishes its catalog" came from one harness, and
        // one harness is an observation rather than a law. A help text that
        // lists its models is read by the same enumeration pass the effort
        // scale uses, so nothing has to change the day one appears.
        const listing = `Usage: other [options]

Options:
  --model <model>                       Model to use (fast, balanced, deep)
  --verbose                             Chatty
`;
        const caps = parseHarnessHelp("other", "1.0", listing);

        expect(caps.modelExamples).toEqual(["fast", "balanced", "deep"]);
        expect(caps.supportsModel).toBe(true);
    });

    it("an enumeration should win over quoted examples in the same paragraph", () => {
        const both = `Usage: other [options]

Options:
  --model <model>                       One of (alpha, beta, gamma), e.g. 'alpha'
`;

        expect(parseHarnessHelp("other", "1.0", both).modelExamples)
            .toEqual(["alpha", "beta", "gamma"]);
    });

    it("a clap-style harness should be read despite the alias prefix and the next-line description", () => {
        // The regression this pins is the whole design failing quietly. Built
        // against one CLI, the parser found nothing in Codex at all: no model
        // control was offered for a harness that documents `--model`, and
        // there was no error anywhere to say so.
        const caps = parseHarnessHelp("codex", "0.147.0", CODEX_HELP);

        expect(caps.supportsModel).toBe(true);
        expect(caps.modelFlag).toBe("--model");
        // Codex exposes reasoning effort only as a config override, so the
        // correct answer here is no effort control rather than a wrong flag.
        expect(caps.supportsEffort).toBe(false);
        expect(caps.effortFlag).toBeUndefined();
    });

    it("a harness whose effort flag has another name should still get an effort control", () => {
        const caps = parseHarnessHelp("pi", "1.0", PI_HELP);

        expect(caps.supportsEffort).toBe(true);
        // The spelling has to travel, or the command written back names a
        // flag pi does not take and the run fails rather than differing.
        expect(caps.effortFlag).toBe("--thinking");
        expect(caps.efforts).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    });

    it("a possible-values block should not be mistaken for the flag it follows", () => {
        // Codex prints `[possible values: ...]` under --sandbox. Nothing may
        // read that as the model's or the effort's values.
        const caps = parseHarnessHelp("codex", "0.147.0", CODEX_HELP);

        expect(caps.efforts).toEqual([]);
        expect(caps.modelExamples).not.toContain("read-only");
    });

    it("every harness actually installed should yield a usable answer", () => {
        // The three real shapes, side by side. Built against Claude Code
        // alone, this parser was correct for one of them.
        const all = [
            parseHarnessHelp("claude", "1", CLAUDE_HELP),
            parseHarnessHelp("codex", "1", CODEX_HELP),
            parseHarnessHelp("pi", "1", PI_HELP),
        ];

        expect(all.map((c) => c.supportsModel)).toEqual([true, true, true]);
        expect(all.map((c) => c.supportsEffort)).toEqual([true, false, true]);
        expect(all.map((c) => c.effortFlag)).toEqual(["--effort", undefined, "--thinking"]);
    });

    it("a reasoning flag under a name nobody listed should still be found", () => {
        // The point of shape discovery: a harness inventing a third word for
        // this is found on the day it ships, not on the day someone adds a
        // string to EFFORT_FLAGS. Neither name below is in that list.
        const invented = `Usage: newagent [options]

Options:
  --model <model>                Which model
  --brainpower <level>           How hard to think (low, medium, high, ludicrous)
`;
        const caps = parseHarnessHelp("newagent", "1.0", invented);

        expect(caps.supportsEffort).toBe(true);
        expect(caps.effortFlag).toBe("--brainpower");
        expect(caps.efforts).toEqual(["low", "medium", "high", "ludicrous"]);
    });

    it("a flag offering only one rung should not be read as a reasoning scale", () => {
        // `high` alone is not evidence. The three rungs are required together
        // because unrelated flags do use one of the words.
        const noisy = `Usage: other [options]

Options:
  --model <model>                Which model
  --quality <q>                  Output quality (draft, high)
  --compression <c>              Compression (none, high, extreme)
`;

        expect(parseHarnessHelp("other", "1", noisy).supportsEffort).toBe(false);
    });

    it("across three real CLIs the only rung-bearing flags should be the reasoning ones", () => {
        // The false-positive check, run over real help rather than fixtures
        // chosen to pass it. It also asserts what the sweep REACHED: a flag
        // enumerator that found nothing would satisfy the first claim
        // vacuously and report success having examined no flags at all.
        for (const [help, expected, floor] of [
            [CLAUDE_HELP, "--effort", 3],
            [CODEX_HELP, undefined, 3],
            [PI_HELP, "--thinking", 3],
        ] as const) {
            const flags = allFlags(help);
            expect(flags.length).toBeGreaterThanOrEqual(floor);
            const bearing = flags
                .filter((f) => /\b(low|medium|high)\b/.test(f.paragraph))
                .map((f) => f.flag);
            expect(bearing).toEqual(expected === undefined ? [] : [expected]);
        }
    });

    it("a bare uppercase metavar should parse, which is most of Python's CLIs", () => {
        // argparse writes `--model MODEL`, not `--model <MODEL>`. Requiring
        // the angled form found nothing in this whole shape, and the failure
        // was silent: no control offered, no error, for every CLI written
        // with argparse or click.
        const caps = parseHarnessHelp("agent", "1.0", ARGPARSE_HELP);

        expect(caps.supportsModel).toBe(true);
        expect(caps.modelFlag).toBe("--model");
    });

    it("an argparse effort flag should be found by its values, not by its name", () => {
        // `--reasoning-effort` IS in EFFORT_FLAGS now, so "the name did not
        // find it" can no longer be asserted by its absence from that list.
        // The scale is what discriminates: the name path yields a flag with
        // no values at all, so a non-empty `efforts` here can only have come
        // from the shape rule reading the paragraph.
        const caps = parseHarnessHelp("agent", "1.0", ARGPARSE_HELP);

        expect(caps.effortFlag).toBe("--reasoning-effort");
        expect(caps.efforts).toEqual(["low", "medium", "high"]);
        expect(EFFORT_FLAGS).toContain("--reasoning-effort");
    });

    it("an alias carrying its own metavar should not swallow the long flag", () => {
        // argparse prints `-m MESSAGE, --message MESSAGE`. `-m` is MESSAGE
        // here and not model, which is exactly why only long forms are read.
        expect(helpParagraph(ARGPARSE_HELP, "--message"))
            .toBe("Specify a single message, process it, then exit");
        expect(parseHarnessHelp("agent", "1", ARGPARSE_HELP).modelFlag).toBe("--model");
    });

    it("a description beginning with a capitalised word should not be read as a metavar", () => {
        // The risk the bare-uppercase form introduces. `Use` is capitalised
        // but not a metavar, and treating it as one would invent a
        // value-taking flag out of a boolean switch.
        expect(helpParagraph(CODEX_HELP, "--oss")).toBeNull();
    });

    it("click's uppercase type name should parse too", () => {
        const caps = parseHarnessHelp("tool", "1", CLICK_HELP);

        expect(caps.supportsModel).toBe(true);
        expect(caps.effortFlag).toBe("--effort");
        expect(caps.efforts).toEqual(["low", "medium", "high"]);
    });

    it("a yargs harness printing no metavar at all should still yield a model flag", () => {
        // The regression this pins is the biggest one the survey found, and
        // it was silent in the same way Codex's was: gemini-cli, opencode and
        // qwen are all yargs, and the parse reached NOT ONE flag in any of
        // them. `supportsModel` was false for a CLI whose second documented
        // option is the model.
        const caps = parseHarnessHelp("gemini", "0.60.0", GEMINI_HELP);

        expect(caps.supportsModel).toBe(true);
        expect(caps.modelFlag).toBe("--model");
        // No reasoning control, which is the right answer: Gemini CLI
        // documents none, so an absent picker is correct rather than a gap.
        expect(caps.supportsEffort).toBe(false);
    });

    it("a yargs switch should not be read as a flag that takes a value", () => {
        // The discriminating half, and the reason the second pass reads the
        // type annotation instead of dropping the metavar requirement. Every
        // flag below is shaped exactly like `--model` up to `[boolean]`, and
        // a picker writing `--yolo <something>` is a command that fails.
        const found = allFlags(GEMINI_HELP).map((f) => f.flag);

        expect(found).toEqual([
            "--model", "--prompt", "--approval-mode", "--output-format",
        ]);
        for (const sw of ["--debug", "--sandbox", "--yolo", "--acp", "--version", "--help"]) {
            expect(helpParagraph(GEMINI_HELP, sw)).toBeNull();
        }
    });

    it("clap's possible-values block should be read as the effort scale", () => {
        // GitHub Copilot CLI documents seven rungs in plain sight and got no
        // effort control, because the colon shape has to end the paragraph
        // and clap closes the list with a bracket.
        const caps = parseHarnessHelp("copilot", "1.0.86", COPILOT_HELP);

        expect(caps.supportsModel).toBe(true);
        expect(caps.effortFlag).toBe("--reasoning-effort");
        expect(caps.efforts)
            .toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    });

    it("the other possible-values blocks in the same help should not be the scale", () => {
        // `--context` and `--auto-tier` enumerate too, and picking either as
        // the reasoning control would write a real flag with a real value and
        // change something nobody asked to change.
        const bearing = allFlags(COPILOT_HELP)
            .filter((f) => /\b(low|medium|high)\b/.test(f.paragraph))
            .map((f) => f.flag);

        expect(bearing).toEqual(["--reasoning-effort"]);
        expect(enumeratedValues(helpParagraph(COPILOT_HELP, "--auto-tier")!))
            .toEqual(["efficiency", "balance", "intelligence"]);
    });

    it("a pipe-separated scale should be read, so the name fallback is never the answer", () => {
        // The outcome that matters is not `supportsEffort`, which was already
        // true here: it is `efforts`. Found by NAME with nothing behind it,
        // `--thinking` rendered a picker whose only row was the default the
        // user already had, which is worse than the absent picker a harness
        // with no such flag gets. Found by SHAPE it carries its rungs.
        const caps = parseHarnessHelp("cline", "3.0.62", CLINE_HELP);

        expect(caps.effortFlag).toBe("--thinking");
        expect(caps.efforts).toEqual(["none", "low", "medium", "high", "xhigh"]);
        expect(caps.modelFlag).toBe("--model");
    });

    it("a piped list that is not a scale should not become one", () => {
        // `--compaction` is spelled the same way and is a different control.
        expect(enumeratedValues(helpParagraph(CLINE_HELP, "--compaction")!))
            .toEqual(["agentic", "basic", "off"]);
        expect(effortFlagFromValues(CLINE_HELP)?.flag).toBe("--thinking");
    });

    it("a wrapped paragraph naming its own flag should not end at that mention", () => {
        // `Bare --thinking uses medium` sits mid-paragraph, and a paragraph
        // that ended at every mention of a flag would have kept the rungs and
        // lost nothing visible, which is the kind of near miss a captured
        // fixture catches and a hand-written one does not.
        expect(helpParagraph(CLINE_HELP, "--thinking"))
            .toBe("Set reasoning effort: none|low|medium|high|xhigh. Bare --thinking uses medium; omitted leaves provider default.");
    });

    it("real argparse should give a model flag and an effort flag with no scale", () => {
        // aider is the case the name list exists for, and the only one on
        // the survey: it documents `--reasoning-effort` and documents no
        // values, so the shape rule cannot see it and the name is what finds
        // it. `efforts` staying empty is the load-bearing half, because that
        // is what the composer's free-text row keys off; a scale invented
        // here would be rungs aider never published.
        const caps = parseHarnessHelp("aider", "0.86.2", AIDER_HELP);

        expect(caps.supportsModel).toBe(true);
        expect(caps.modelFlag).toBe("--model");
        expect(caps.supportsEffort).toBe(true);
        expect(caps.effortFlag).toBe("--reasoning-effort");
        expect(caps.efforts).toEqual([]);
        // The fixture has to be able to express the case, so assert the
        // sweep REACHED the flag and found it empty, rather than inferring
        // that from the empty scale: a fixture missing the flag entirely
        // would satisfy the line above having tested nothing.
        const reasoning = allFlags(AIDER_HELP).find((f) => f.flag === "--reasoning-effort");
        expect(reasoning?.paragraph).toContain("Set the reasoning_effort API parameter");
        expect(enumeratedValues(reasoning!.paragraph)).toEqual([]);
    });

    it("aider's neighbours should not be read as the model flag", () => {
        // Three traps in one help: `-m` is the message, `--list-models` puts
        // a second long flag where an alias goes, and `--alias ALIAS:MODEL`
        // ends in the word.
        expect(helpParagraph(AIDER_HELP, "--model"))
            .toBe("Specify the model to use for the main chat [env var: AIDER_MODEL]");
        expect(helpParagraph(AIDER_HELP, "--message"))
            .toContain("Specify a single message to send the LLM");
        expect(parseHarnessHelp("aider", "1", AIDER_HELP).modelExamples).toEqual([]);
    });

    it("every surveyed harness should be answered, and the answers should differ", () => {
        // The whole survey in one table, and the assertion that matters is
        // that the answers are not all the same: a parser that had quietly
        // stopped finding anything would give a uniform column of false and
        // each individual test above would still be a separate thing to
        // notice. Floors rather than a sum, so a sweep reaching nothing
        // fails rather than passing vacuously.
        const surveyed = [
            { help: CLAUDE_HELP, model: "--model", effort: "--effort", rungs: 5, floor: 3 },
            { help: CODEX_HELP, model: "--model", effort: undefined, rungs: 0, floor: 3 },
            { help: PI_HELP, model: "--model", effort: "--thinking", rungs: 7, floor: 3 },
            { help: AIDER_HELP, model: "--model", effort: "--reasoning-effort", rungs: 0, floor: 5 },
            { help: CLINE_HELP, model: "--model", effort: "--thinking", rungs: 5, floor: 4 },
            { help: GEMINI_HELP, model: "--model", effort: undefined, rungs: 0, floor: 4 },
            { help: COPILOT_HELP, model: "--model", effort: "--reasoning-effort", rungs: 7, floor: 4 },
        ];

        for (const { help, model, effort, rungs, floor } of surveyed) {
            const caps = parseHarnessHelp("h", "1", help);
            expect(allFlags(help).length).toBeGreaterThanOrEqual(floor);
            expect(caps.modelFlag).toBe(model);
            expect(caps.effortFlag).toBe(effort);
            expect(caps.efforts).toHaveLength(rungs);
        }
        expect(new Set(surveyed.map((s) => s.effort)).size).toBeGreaterThan(1);
    });

    it("the examples should never be treated as the set of what exists", () => {
        // The whole reason this is called `modelExamples`: help prose names
        // a few aliases, and a model missing from it works just as well.
        const caps = parseHarnessHelp("claude", "2.1.0", CLAUDE_HELP);

        expect(caps.modelExamples).not.toContain("haiku");
        expect(caps.supportsModel).toBe(true);
    });
});
