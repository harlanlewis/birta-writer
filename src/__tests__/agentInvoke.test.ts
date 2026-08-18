/**
 * src/agentBridge/invoke.ts — the `/ai` invocation adapter.
 *
 * The interesting surface is the command line it builds, because that string
 * is handed to a shell. The prompt is the user's own prose rather than hostile
 * input, so quoting is a CORRECTNESS property, not a trust boundary: an
 * apostrophe in "don't", a `$` in a price, or a backtick in a code reference
 * must all reach the agent as the bytes the user typed instead of being split
 * on, expanded, or executed by the shell first.
 *
 * These are pure-function tests. The terminal path (which needs a live
 * `vscode.window`) is exercised through the extension host, not here.
 */
import { describe, it, expect } from "vitest";
import {
    shellQuote,
    renderCommand,
    buildInstruction,
    type InvokeSubstitutions,
} from "../agentBridge/invoke";

const SUBS: InvokeSubstitutions = {
    prompt: "add a mermaid diagram",
    reference: "notes.md#L12-L20",
    file: "notes.md",
    instruction: "In notes.md#L12-L20: add a mermaid diagram",
};

describe("shellQuote", () => {
    it("ordinary text should be wrapped in single quotes", () => {
        expect(shellQuote("hello world", false)).toBe("'hello world'");
    });

    it("a POSIX single quote should be closed, escaped, and resumed", () => {
        // The one sequence single quoting cannot contain. "don't" must survive
        // as five characters, not end the quoting two characters in.
        expect(shellQuote("don't", false)).toBe(`'don'\\''t'`);
    });

    it("shell metacharacters should be inert inside POSIX quoting", () => {
        const raw = "$HOME `whoami` $(id) \"x\" ; rm -rf / && echo | tee";
        const quoted = shellQuote(raw, false);
        expect(quoted.startsWith("'")).toBe(true);
        expect(quoted.endsWith("'")).toBe(true);
        // No unescaped quote inside means the whole thing is one literal word.
        expect(quoted.slice(1, -1)).toBe(raw);
    });

    it("a PowerShell single quote should be doubled rather than backslashed", () => {
        // Windows shells do not honour the POSIX escape, so the same input
        // must take the other form or the argument breaks apart.
        expect(shellQuote("don't", true)).toBe("'don''t'");
    });

    it("an empty value should still quote to an explicit empty argument", () => {
        expect(shellQuote("", false)).toBe("''");
        expect(shellQuote("", true)).toBe("''");
    });

    it("a newline should survive quoting on both platforms", () => {
        expect(shellQuote("a\nb", false)).toBe("'a\nb'");
        expect(shellQuote("a\nb", true)).toBe("'a\nb'");
    });
});

describe("renderCommand", () => {
    it("every known placeholder should substitute, quoted", () => {
        const out = renderCommand(
            "agent ${prompt} ${reference} ${file} ${instruction}",
            SUBS,
            false,
        );
        expect(out).toBe(
            "agent 'add a mermaid diagram' 'notes.md#L12-L20' 'notes.md' " +
                "'In notes.md#L12-L20: add a mermaid diagram'",
        );
    });

    it("the shipped default template should render a single quoted argument", () => {
        expect(renderCommand("claude ${instruction}", SUBS, false)).toBe(
            "claude 'In notes.md#L12-L20: add a mermaid diagram'",
        );
    });

    it("a prompt carrying a quote should not break the command apart", () => {
        const out = renderCommand("claude ${prompt}", { ...SUBS, prompt: "don't break" }, false);
        expect(out).toBe(`claude 'don'\\''t break'`);
    });

    it("an unknown placeholder should be left untouched rather than blanked", () => {
        // A template is user-authored config. Silently emptying a name they
        // meant literally is worse than letting the shell answer for it.
        expect(renderCommand("agent ${nope} ${prompt}", SUBS, false)).toBe(
            "agent ${nope} 'add a mermaid diagram'",
        );
    });

    it("a template with no placeholders should pass through unchanged", () => {
        expect(renderCommand("claude --help", SUBS, false)).toBe("claude --help");
    });

    it("a repeated placeholder should substitute at every occurrence", () => {
        expect(renderCommand("a ${file} b ${file}", SUBS, false)).toBe(
            "a 'notes.md' b 'notes.md'",
        );
    });

    it("a template targeting a different harness should work with no code change", () => {
        // The reason the setting is a template and not a vendor list.
        expect(renderCommand("codex exec ${instruction}", SUBS, false)).toBe(
            "codex exec 'In notes.md#L12-L20: add a mermaid diagram'",
        );
    });
});

describe("buildInstruction", () => {
    it("should name where the ask applies before the ask itself", () => {
        expect(buildInstruction("add a diagram", "notes.md#L12-L20")).toBe(
            "In notes.md#L12-L20: add a diagram",
        );
    });
});
