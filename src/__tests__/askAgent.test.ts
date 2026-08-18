/**
 * Ask Agent (src/agentBridge/askAgent.ts): the one-shot hand-off of a caret
 * request to the user's own agent. Pure composition and quoting first, then
 * the command body against the vscode mock: which route runs, that the
 * document is saved first so the line reference names what is on disk, that
 * a missing request or route is asked for rather than guessed, that a
 * background run reports its life to the webview and hands the disk text
 * over only when the document is dirty at exit, and that terminal mode
 * reuses one terminal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import {
    agentOutputChannel,
    askAgent,
    cancelAgentRun,
    reportAgentMerge,
    composeAgentRequest,
    expandCommandTemplate,
    harnessName,
    normalizeAgentMode,
    shellQuote,
    CHAT_OPEN_COMMAND,
    TERMINAL_NAME,
} from "../agentBridge/askAgent";
import type { ActiveEditorContext } from "../agentBridge/api";
import type { EditorSelectionContext } from "../../shared/agentContext";
import type { AgentRunMessage } from "../../shared/messages";
import { makeFakeTextDocument, resetTextDocumentMocks, Range, Uri } from "../../__mocks__/vscode";

/** A spawn stand-in: an emitter with a stderr stream and a kill the test can drive. */
class FakeChild extends EventEmitter {
    stderr = new EventEmitter();
    stdout = new EventEmitter();
    kill = vi.fn(() => { this.emit("exit", null); return true; });
}
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const noteUri = Uri.file("/notes/plan.md");

function caretContext(line: number): EditorSelectionContext {
    return {
        selections: [{ anchor: { line, column: 0 }, active: { line, column: 0 }, text: "" }],
        primary: 0,
        isEmpty: true,
    };
}

function activeAt(line: number): ActiveEditorContext {
    return { uri: noteUri, context: caretContext(line) };
}

/** Points the config mock's agent settings at `command` and `mode`. */
function configureRoute(command: string, mode = "background"): { update: ReturnType<typeof vi.fn> } {
    const update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, fallback?: unknown) =>
            key === "agent.command" ? command : key === "agent.mode" ? mode : fallback),
        inspect: vi.fn(() => undefined),
        update,
    } as unknown as vscode.WorkspaceConfiguration);
    return { update };
}

function reporter(): { report: (uri: vscode.Uri, m: AgentRunMessage) => void; messages: AgentRunMessage[] } {
    const messages: AgentRunMessage[] = [];
    return { report: (_uri, m) => { messages.push(m); }, messages };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("composeAgentRequest", () => {
    it("a request and a reference should compose to one line naming the location first", () => {
        expect(composeAgentRequest("add a mermaid diagram", "notes/plan.md#L12")).toBe(
            "In notes/plan.md#L12: add a mermaid diagram",
        );
    });

    it("newlines and runs of spaces in the request should collapse to single spaces", () => {
        expect(composeAgentRequest("  rewrite\n\nthis   section ", "a.md#L1-L3")).toBe(
            "In a.md#L1-L3: rewrite this section",
        );
    });
});

describe("shellQuote", () => {
    it("a POSIX platform should single-quote and escape embedded single quotes", () => {
        expect(shellQuote("it's $HOME `x`", "darwin")).toBe(`'it'\\''s $HOME \`x\`'`);
    });

    it("win32 should single-quote for PowerShell, doubling an embedded quote and expanding nothing", () => {
        expect(shellQuote("it's $x `y`", "win32")).toBe("'it''s $x `y`'");
    });
});

describe("expandCommandTemplate", () => {
    it("every {prompt} placeholder should be replaced by the quoted line", () => {
        expect(expandCommandTemplate("claude {prompt} && echo {prompt}", "'q'")).toBe(
            "claude 'q' && echo 'q'",
        );
    });

    it("a template without the placeholder should get the line appended", () => {
        expect(expandCommandTemplate("  claude  ", "'q'")).toBe("claude 'q'");
    });
});

describe("harnessName", () => {
    it("the command's first word, without any path, names the harness", () => {
        expect(harnessName("claude -p {prompt} --permission-mode acceptEdits")).toBe("claude");
        expect(harnessName("/usr/local/bin/codex exec {prompt}")).toBe("codex");
        expect(harnessName("   ")).toBe("agent");
    });
});

describe("reportAgentMerge (the webview's verdict on a dirty-document merge)", () => {
    beforeEach(() => vi.clearAllMocks());

    it("applied should be a status-bar line, not a toast", () => {
        reportAgentMerge(noteUri, "applied");
        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining("updated around your edits"), 5000);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("partial and conflict should warn and point at Compare", () => {
        reportAgentMerge(noteUri, "partial");
        reportAgentMerge(noteUri, "conflict");
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
        expect(vscode.window.showWarningMessage).toHaveBeenNthCalledWith(1, expect.stringContaining("left out"));
        expect(vscode.window.showWarningMessage).toHaveBeenNthCalledWith(2, expect.stringContaining("could not be merged"));
    });
});

describe("normalizeAgentMode", () => {
    it("only the literal terminal should read as terminal", () => {
        expect(normalizeAgentMode("terminal")).toBe("terminal");
        expect(normalizeAgentMode("background")).toBe("background");
        expect(normalizeAgentMode("Terminal")).toBe("background");
        expect(normalizeAgentMode(undefined)).toBe("background");
    });
});

describe("askAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vscode.window.terminals.length = 0;
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
        spawnMock.mockImplementation(() => new FakeChild());
    });

    it("no active editor should report and dispatch nothing", async () => {
        configureRoute("clipboard");
        const { messages } = reporter();

        await askAgent(() => Promise.resolve(null), reporter().report, "do x", "ai1");

        expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
    });

    it("the clipboard route should copy the composed line and hand the marker off", async () => {
        configureRoute("clipboard");
        makeFakeTextDocument("# Plan\n\nbody\n", noteUri);
        const { report, messages } = reporter();

        await askAgent(() => Promise.resolve(activeAt(3)), report, "add a diagram", "ai1");

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("In notes/plan.md#L3: add a diagram");
        expect(messages).toEqual([{ type: "agentRun", requestId: "ai1", status: "handedOff" }]);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it("terminal mode should run the template in one reused Birta AI terminal at the workspace folder", async () => {
        configureRoute("claude {prompt}", "terminal");
        makeFakeTextDocument("# Plan\n", noteUri);
        const folder = { uri: Uri.file("/notes") };
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(folder as never);
        const { report, messages } = reporter();

        await askAgent(() => Promise.resolve(activeAt(1)), report, "it's done", "ai1");
        await askAgent(() => Promise.resolve(activeAt(1)), report, "again", "ai2");

        expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
        expect(vscode.window.createTerminal).toHaveBeenCalledWith({ name: TERMINAL_NAME, cwd: folder.uri });
        const terminal = vscode.window.terminals[0]!;
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, `claude 'In notes/plan.md#L1: it'\\''s done'`, true);
        expect(terminal.sendText).toHaveBeenNthCalledWith(2, `claude 'In notes/plan.md#L1: again'`, true);
        expect(messages.map((m) => m.status)).toEqual(["handedOff", "handedOff"]);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it("a terminal that has exited should not be reused", async () => {
        configureRoute("claude {prompt}", "terminal");
        makeFakeTextDocument("# Plan\n", noteUri);
        vscode.window.createTerminal({ name: TERMINAL_NAME });
        vscode.window.terminals[0]!.exitStatus = { code: 0 };
        vi.mocked(vscode.window.createTerminal).mockClear();

        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "x", "ai1");

        expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
        expect(vscode.window.terminals).toHaveLength(2);
    });

    it("the chat route should open the Chat view with the line as its query", async () => {
        configureRoute("chat");
        makeFakeTextDocument("# Plan\n", noteUri);

        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "summarize", "ai1");

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(CHAT_OPEN_COMMAND, {
            query: "In notes/plan.md#L1: summarize",
        });
    });

    it("background mode should spawn the template in its own process group, report running, then done once the clean reload landed", async () => {
        configureRoute("claude -p {prompt}", "background");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();

        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai7");

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [commandLine, options] = spawnMock.mock.calls[0]!;
        expect(commandLine).toBe(`claude -p 'In notes/plan.md#L1: do x'`);
        expect(options).toMatchObject({ shell: true, detached: true });
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
        expect(messages).toEqual([{ type: "agentRun", requestId: "ai7", status: "running", harness: "claude" }]);

        // The agent writes the file; VS Code reloads the clean document.
        const disk = "# Plan\n\nAgent line.\n";
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(disk));
        doc.setTextExternally(disk);
        child.emit("exit", 0);
        // `done` waits for the reload to land and the push to go out first.
        await new Promise((r) => setTimeout(r, 600));

        expect(messages[1]).toEqual({ type: "agentRun", requestId: "ai7", status: "done", harness: "claude" });
        // The change itself is the feedback, plus one status-bar line.
        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining("claude finished"), 5000);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("done should not be reported until the clean document shows the agent's write, within a bound", async () => {
        configureRoute("claude -p {prompt}", "background");
        makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();
        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai14");
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from("# Plan\n\nAgent line.\n"));

        child.emit("exit", 0);
        await new Promise((r) => setTimeout(r, 200));

        // Not yet: the document has not taken the write.
        expect(messages).toHaveLength(1);
    });

    it("the finish channel: a failure logs the run to the Birta AI output channel and the toast offers Show Output", async () => {
        configureRoute("claude -p {prompt}", "background");
        makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce("Show Output" as never);
        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "do x", "ai15");

        child.stderr.emit("data", Buffer.from("boom"));
        child.emit("exit", 2);
        await flush();
        await flush();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("boom"), "Show Output");
        const channel = agentOutputChannel();
        expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("failed"));
        expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("boom"));
        expect(channel.show).toHaveBeenCalled();
    });

    it("a run that changed nothing should still end with feedback: the agent's last words in a message", async () => {
        configureRoute("claude -p {prompt}", "background");
        makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();
        await askAgent(() => Promise.resolve(activeAt(1)), report, "say hello", "ai12");

        child.stdout.emit("data", Buffer.from("Hello! Nothing to change here.\n"));
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from("# Plan\n"));
        child.emit("exit", 0);
        await flush();

        expect(messages[1]).toEqual({ type: "agentRun", requestId: "ai12", status: "done", harness: "claude" });
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringMatching(/claude finished without changing notes\/plan\.md\. It said: Hello! Nothing to change here\./),
            "Show Output",
        );
    });

    it("a run that changed nothing and said nothing should say so", async () => {
        configureRoute("codex exec {prompt}", "background");
        makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "say hello", "ai13");

        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from("# Plan\n"));
        child.emit("exit", 0);
        await flush();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("codex finished without changing notes/plan.md, and said nothing."),
            "Show Output",
        );
    });

    it("a dirty document at exit should carry the disk text into the done report", async () => {
        configureRoute("claude -p {prompt}", "background");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();
        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai8");
        // The user types while the agent works, and the agent writes the file.
        (doc as unknown as { applyReplace(r: Range, t: string): void }).applyReplace(new Range(doc.positionAt(0), doc.positionAt(0)), "x");
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from("# Plan\n\nAgent line.\n"));

        child.emit("exit", 0);
        await flush();

        expect(messages[1]).toEqual({ type: "agentRun", requestId: "ai8", status: "done", text: "# Plan\n\nAgent line.\n", harness: "claude" });
    });

    it("a dirty document whose file the agent did not change should report a plain done", async () => {
        configureRoute("claude -p {prompt}", "background");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();
        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai9");
        (doc as unknown as { applyReplace(r: Range, t: string): void }).applyReplace(new Range(doc.positionAt(0), doc.positionAt(0)), "x");
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from("# Plan\n"));

        child.emit("exit", 0);
        await flush();

        expect(messages[1]).toEqual({ type: "agentRun", requestId: "ai9", status: "done", harness: "claude" });
    });

    it("a non-zero exit should report failed with the code and the stderr tail", async () => {
        configureRoute("claude -p {prompt}", "background");
        makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();
        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai10");

        child.stderr.emit("data", Buffer.from("no such command"));
        child.emit("exit", 127);
        await flush();

        expect(messages[1]?.status).toBe("failed");
        expect(messages[1]?.message).toContain("127");
        expect(messages[1]?.message).toContain("no such command");
        // A failure is announced, not only marked in the gutter.
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("claude could not finish"), "Show Output");
    });

    it("cancelling a run should kill the child and report cancelled, not failed", async () => {
        configureRoute("claude -p {prompt}", "background");
        makeFakeTextDocument("# Plan\n", noteUri);
        const child = new FakeChild();
        spawnMock.mockImplementation(() => child);
        const { report, messages } = reporter();
        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai11");

        cancelAgentRun("ai11");
        await flush();

        expect(child.kill).toHaveBeenCalled();
        expect(messages[1]).toEqual({ type: "agentRun", requestId: "ai11", status: "cancelled", harness: "claude" });
    });

    it("a dirty document should be saved before the hand-off", async () => {
        configureRoute("clipboard");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        (doc as unknown as { applyReplace(r: Range, t: string): void }).applyReplace(new Range(doc.positionAt(0), doc.positionAt(0)), "x");
        expect(doc.isDirty).toBe(true);

        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "do x", "ai1");

        expect(doc.save).toHaveBeenCalled();
        const saveOrder = vi.mocked(doc.save).mock.invocationCallOrder[0]!;
        const copyOrder = vi.mocked(vscode.env.clipboard.writeText).mock.invocationCallOrder[0]!;
        expect(saveOrder).toBeLessThan(copyOrder);
    });

    it("a save that fails should warn, send nothing, and hand the marker off", async () => {
        configureRoute("clipboard");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        (doc as unknown as { applyReplace(r: Range, t: string): void }).applyReplace(new Range(doc.positionAt(0), doc.positionAt(0)), "x");
        vi.mocked(doc.save).mockResolvedValueOnce(false);
        const { report, messages } = reporter();

        await askAgent(() => Promise.resolve(activeAt(1)), report, "do x", "ai1");

        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(messages).toEqual([{ type: "agentRun", requestId: "ai1", status: "handedOff" }]);
    });

    it("no request should ask in an input box and use the answer", async () => {
        configureRoute("clipboard");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("  tighten this  ");

        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, undefined, "ai1");

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("In notes/plan.md#L1: tighten this");
    });

    it("a cancelled input box should send nothing and hand the marker off", async () => {
        configureRoute("clipboard");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
        const { report, messages } = reporter();

        await askAgent(() => Promise.resolve(activeAt(1)), report, "", "ai1");

        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(messages).toEqual([{ type: "agentRun", requestId: "ai1", status: "handedOff" }]);
    });

    it("an unset route should ask once and store the pick and its mode globally", async () => {
        const { update } = configureRoute("");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            label: "Claude Code, in a terminal",
            value: "claude {prompt}",
            mode: "terminal",
        } as never);

        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "do x", "ai1");

        expect(update).toHaveBeenCalledWith("agent.command", "claude {prompt}", vscode.ConfigurationTarget.Global);
        expect(update).toHaveBeenCalledWith("agent.mode", "terminal", vscode.ConfigurationTarget.Global);
        expect(vscode.window.terminals[0]?.sendText).toHaveBeenCalledWith(`claude 'In notes/plan.md#L1: do x'`, true);
    });

    it("dismissing the route picker should store nothing and send nothing", async () => {
        const { update } = configureRoute("");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

        await askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "do x", "ai1");

        expect(update).not.toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it("a route that throws should surface one error and not rethrow", async () => {
        configureRoute("chat");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("no chat"));

        await expect(askAgent(() => Promise.resolve(activeAt(1)), reporter().report, "do x", "ai1")).resolves.toBeUndefined();

        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
});
