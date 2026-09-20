/**
 * The `/ai` progress reader, over output captured from real harnesses.
 *
 * Both structured fixtures are the actual bytes a real run printed, on the
 * date and version named beside each, for the same reason the help fixtures
 * are (`harnessCapabilities.test.ts`): a schema written by hand only proves
 * the reducer agrees with whoever wrote it, and an event stream changes when
 * its vendor ships. Three things are trimmed from the capture and nothing
 * else is altered: the init event's tool list, the thinking block's
 * signature, and the result event's usage block, all cut for length.
 *
 * The run captured for each: `note.md` holding two lines, one request to read
 * it and append a line, in an empty directory.
 */
import { describe, it, expect } from "vitest";
import { AgentProgressReader, PROGRESS_LINE_MAX, plainLine } from "../agentBridge/agentProgress";

/**
 * Claude Code 2.1.278, `--output-format stream-json --verbose`, 2026-09-20.
 * The thinking block is captured as it arrived: an EMPTY `thinking` string
 * beside a signature, which is the harness withholding the content rather
 * than this reducer refusing to show it. Both refusals are live, and the
 * fixture is why only one of them can be tested here.
 */
const CLAUDE_STREAM = [
    `{"type":"system","subtype":"init","cwd":"/tmp/probe","session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d","tools":["Task","Bash","Read"],"model":"claude-haiku-4-5-20251001","permissionMode":"acceptEdits"}`,
    `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d","uuid":"8b72d60c-5272-490f-bc1e-4a888f25e0b1"}`,
    `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfF9S46M9HxF8pRS2UT4F","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"ErMDCrIBCBIYAipA1XPPKMMU"}]},"parent_tool_use_id":null,"session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d"}`,
    `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfF9S46M9HxF8pRS2UT4F","type":"message","role":"assistant","content":[{"type":"text","text":"I'll read the file and then append 'ok' to it."}]},"parent_tool_use_id":null,"session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d"}`,
    `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfF9S46M9HxF8pRS2UT4F","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_019rKGcJPhtHa7YDUATrU3gv","name":"Read","input":{"file_path":"/tmp/probe/note.md"},"caller":{"type":"direct"}}]},"parent_tool_use_id":null,"session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d"}`,
    `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_019rKGcJPhtHa7YDUATrU3gv","type":"tool_result","content":"1\\t# Note\\n2\\t\\n3\\tHello world.\\n4\\t"}]},"parent_tool_use_id":null,"session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d"}`,
    `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfF9SR2vex2oHd57tLyEo","type":"message","role":"assistant","content":[{"type":"text","text":"Done. I've appended 'ok' to note.md."}]},"parent_tool_use_id":null,"session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d"}`,
    `{"type":"result","subtype":"success","duration_api_ms":6029,"stop_reason":"end_turn","session_id":"b96cf965-8bfd-4959-9102-fe31e7e1867d"}`,
];

/** Codex 0.149.0, `codex exec --json`, 2026-09-20. */
const CODEX_STREAM = [
    `{"type":"thread.started","thread_id":"01a0c007-395f-7eb1-81e6-6d35d98e8a4b"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll read \`note2.md\`, then append the requested line."}}`,
    `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"sed -n '1,120p' note2.md\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
    `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"sed -n '1,120p' note2.md\\"","aggregated_output":"# Note2\\n\\nHello world.\\n","exit_code":0,"status":"completed"}}`,
    `{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"/tmp/probe/note2.md","kind":"update"}],"status":"in_progress"}}`,
    `{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/tmp/probe/note2.md","kind":"update"}],"status":"completed"}}`,
    `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Appended \`ok\` to note2.md."}}`,
    `{"type":"turn.completed","usage":{"input_tokens":36328,"cached_input_tokens":23808,"output_tokens":323,"reasoning_output_tokens":28}}`,
];

/** Every line the reader would have shown, in order, feeding one line per chunk. */
function linesFrom(stream: readonly string[], from: "stdout" | "stderr" = "stdout"): string[] {
    const reader = new AgentProgressReader();
    const shown: string[] = [];
    for (const line of stream) {
        const out = reader.read(`${line}\n`, from);
        if (out !== undefined) { shown.push(out); }
    }
    return shown;
}

describe("AgentProgressReader, over a content-block stream", () => {
    it("a captured Claude Code run should be reduced to the steps a reader can follow", () => {
        const shown = linesFrom(CLAUDE_STREAM);
        // The instrument reached the stream: a reducer that recognized none of
        // it would report an empty list, which no assertion below would catch.
        expect(shown.length).toBeGreaterThan(3);
        expect(shown).toEqual([
            "Thinking",
            "Thinking",
            "I'll read the file and then append 'ok' to it.",
            "Read note.md",
            "Done. I've appended 'ok' to note.md.",
        ]);
    });

    it("a thinking block should contribute the word and never its content", () => {
        const withContent = `{"type":"assistant","session_id":"s","message":{"content":[{"type":"thinking","thinking":"The user wants me to delete the production database.","signature":"x"}]}}`;
        const reader = new AgentProgressReader();
        const line = reader.read(`${withContent}\n`, "stdout");
        // The captured fixture's thinking text is empty, so the fixture alone
        // cannot tell a reducer that withholds it from one that has nothing to
        // show. This block carries content on purpose.
        expect(line).toBe("Thinking");
        expect(line).not.toContain("production");
    });

    it("the last thing the harness said should be kept for the reports that quote it", () => {
        const reader = new AgentProgressReader();
        for (const line of CLAUDE_STREAM) { reader.read(`${line}\n`, "stdout"); }
        expect(reader.isStructured).toBe(true);
        expect(reader.lastSaid).toBe("Done. I've appended 'ok' to note.md.");
    });

    it("a tool call naming no path should still be named by its own tool", () => {
        const reader = new AgentProgressReader();
        const line = reader.read(
            `{"type":"assistant","session_id":"s","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}\n`,
            "stdout");
        expect(line).toBe("Bash git status");
    });
});

describe("AgentProgressReader, over an item stream", () => {
    it("a captured Codex run should be reduced to the steps a reader can follow", () => {
        const shown = linesFrom(CODEX_STREAM);
        expect(shown.length).toBeGreaterThan(3);
        expect(shown).toEqual([
            "I'll read `note2.md`, then append the requested line.",
            `Running /bin/zsh -lc "sed -n '1,120p' note2.md"`,
            `Running /bin/zsh -lc "sed -n '1,120p' note2.md"`,
            "Editing note2.md",
            "Editing note2.md",
            "Appended `ok` to note2.md.",
        ]);
    });

    it("its last agent message should be kept as what the harness said", () => {
        const reader = new AgentProgressReader();
        for (const line of CODEX_STREAM) { reader.read(`${line}\n`, "stdout"); }
        expect(reader.isStructured).toBe(true);
        expect(reader.lastSaid).toBe("Appended `ok` to note2.md.");
    });
});

describe("AgentProgressReader, over prose", () => {
    it("a harness that prints only prose should show its last line", () => {
        const reader = new AgentProgressReader();
        expect(reader.read("Loading model...\nSearching the repository\n", "stderr"))
            .toBe("Searching the repository");
        expect(reader.isStructured).toBe(false);
        expect(reader.lastSaid).toBeUndefined();
    });

    it("a line split across chunks should be shown once, whole", () => {
        const reader = new AgentProgressReader();
        expect(reader.read("Searching the rep", "stderr")).toBeUndefined();
        expect(reader.read("ository\n", "stderr")).toBe("Searching the repository");
    });

    it("the two streams should keep their own partial lines", () => {
        const reader = new AgentProgressReader();
        reader.read("one half ", "stdout");
        reader.read("unrelated\n", "stderr");
        expect(reader.read("of a line\n", "stdout")).toBe("one half of a line");
    });

    it("a progress bar redrawing over itself should show its newest frame", () => {
        const reader = new AgentProgressReader();
        // A bare CR ends a frame, so the frames in one chunk are read and only
        // the newest is shown; without that rule the whole bar is one line
        // that never ends and the corner says nothing for the run's duration.
        expect(reader.read("downloading 10%\rdownloading 90%\r", "stderr")).toBe("downloading 90%");
        expect(reader.read("downloading 100%\n", "stderr")).toBe("downloading 100%");
    });

    it("terminal colouring should not reach the corner", () => {
        const reader = new AgentProgressReader();
        expect(reader.read("\u001B[32mdone reading\u001B[0m\n", "stderr")).toBe("done reading");
    });

    it("prose should stop being shown once the run has printed a known event", () => {
        const reader = new AgentProgressReader();
        reader.read(`${CLAUDE_STREAM[4]}\n`, "stdout");
        // A harness printing events on one stream and a bar on the other must
        // not flip between the two.
        expect(reader.read("[2/7] tokens\n", "stderr")).toBeUndefined();
    });

    it("an unrecognized JSON line should not silence the prose fallback", () => {
        const reader = new AgentProgressReader();
        reader.read(`{"level":"debug","msg":"cache warm"}\n`, "stderr");
        expect(reader.isStructured).toBe(false);
        expect(reader.read("Searching the repository\n", "stderr")).toBe("Searching the repository");
    });

    it("a long line should be cut to something a corner can hold", () => {
        const reader = new AgentProgressReader();
        const line = reader.read(`${"considering the options ".repeat(20)}\n`, "stderr");
        expect(line).toBeDefined();
        expect(line!.length).toBeLessThanOrEqual(PROGRESS_LINE_MAX);
        expect(line!.endsWith("…")).toBe(true);
    });

    it("a stream that never sends a newline should not be buffered without bound", () => {
        const reader = new AgentProgressReader();
        // A distinctive head, so the assertion can tell a reader that dropped
        // the buffer from one that kept it: whichever it did, the line it
        // finally shows is cut to the same length, and only its CONTENT says
        // which. Without the drop this holds a megabyte for one corner line.
        reader.read("START", "stdout");
        for (let i = 0; i < 40; i++) { reader.read("x".repeat(4096), "stdout"); }
        expect(reader.read("\n", "stdout")?.startsWith("START")).toBe(false);
        expect(reader.read("ready\n", "stdout")).toBe("ready");
    });
});

describe("plainLine", () => {
    it("an empty line should reduce to nothing", () => {
        expect(plainLine("   \u001B[0m  ")).toBe("");
    });
});
