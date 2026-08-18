/**
 * Reading a harness's own `--help` for what it accepts
 * (src/agentBridge/harnessCapabilities.ts).
 *
 * The fixture is captured VERBATIM from Claude Code, wrapping and all,
 * because the thing under test is a parse of real help text and a fixture
 * written by hand would only prove the parser agrees with its author. The
 * neighbouring flags are kept for the same reason: paragraph boundaries are
 * where this parse fails, so the test has to contain some.
 *
 * The invariant that matters most is negative. `--fallback-model` sits next
 * to `--model` and means something else entirely, and an effort scale
 * invented rather than read would be a wrong control in front of someone
 * about to spend money.
 */
import { describe, it, expect } from "vitest";
import {
    enumeratedValues,
    helpParagraph,
    parseHarnessHelp,
    quotedExamples,
} from "../agentBridge/harnessCapabilities";
import { agentEffortName, agentModelName, setTemplateFlag } from "../agentBridge/askAgent";

/** Captured from `claude --help`. */
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

/** A harness offering neither flag: the shape that must produce no controls. */
const PLAIN_HELP = `Usage: someagent [options] <prompt>

Options:
  -h, --help                            Show help
  --verbose                             Chatty output
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

    it("the examples should never be treated as the set of what exists", () => {
        // The whole reason this is called `modelExamples`: help prose names
        // a few aliases, and a model missing from it works just as well.
        const caps = parseHarnessHelp("claude", "2.1.0", CLAUDE_HELP);

        expect(caps.modelExamples).not.toContain("haiku");
        expect(caps.supportsModel).toBe(true);
    });
});
