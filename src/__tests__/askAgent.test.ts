/**
 * Ask Agent (src/agentBridge/askAgent.ts): the one-shot hand-off of a caret
 * request to the user's own agent. Pure composition and quoting first, then
 * the command body against the vscode mock: which route runs, that the
 * document is saved first so the line reference names what is on disk, and
 * that a missing request or route is asked for rather than guessed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
    askAgent,
    composeAgentRequest,
    expandCommandTemplate,
    shellQuote,
    CHAT_OPEN_COMMAND,
    TERMINAL_NAME,
} from "../agentBridge/askAgent";
import type { ActiveEditorContext } from "../agentBridge/api";
import type { EditorSelectionContext } from "../../shared/agentContext";
import { makeFakeTextDocument, resetTextDocumentMocks, Range, Uri } from "../../__mocks__/vscode";

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

/** Points the config mock's `agent.command` read at `value`. */
function configureRoute(value: string): { update: ReturnType<typeof vi.fn> } {
    const update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, fallback?: unknown) => (key === "agent.command" ? value : fallback)),
        inspect: vi.fn(() => undefined),
        update,
    } as unknown as vscode.WorkspaceConfiguration);
    return { update };
}

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

    it("win32 should double-quote and backtick-escape the PowerShell specials", () => {
        expect(shellQuote('say "hi" $x `y`', "win32")).toBe('"say `"hi`" `$x ``y``"');
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

describe("askAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    });

    it("no active editor should report and dispatch nothing", async () => {
        configureRoute("clipboard");

        await askAgent(() => Promise.resolve(null), "do x");

        expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    });

    it("the clipboard route should copy the composed line", async () => {
        configureRoute("clipboard");
        makeFakeTextDocument("# Plan\n\nbody\n", noteUri);

        await askAgent(() => Promise.resolve(activeAt(3)), "add a diagram");

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            "In notes/plan.md#L3: add a diagram",
        );
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    });

    it("a shell template should run in a fresh terminal at the workspace folder with the line quoted", async () => {
        configureRoute("claude {prompt}");
        makeFakeTextDocument("# Plan\n", noteUri);
        const folder = { uri: Uri.file("/notes") };
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(folder as never);

        await askAgent(() => Promise.resolve(activeAt(1)), "it's done");

        expect(vscode.window.createTerminal).toHaveBeenCalledWith({ name: TERMINAL_NAME, cwd: folder.uri });
        const terminal = vi.mocked(vscode.window.createTerminal).mock.results[0]!.value;
        expect(terminal.show).toHaveBeenCalled();
        expect(terminal.sendText).toHaveBeenCalledWith(
            `claude 'In notes/plan.md#L1: it'\\''s done'`,
            true,
        );
    });

    it("the chat route should open the Chat view with the line as its query", async () => {
        configureRoute("chat");
        makeFakeTextDocument("# Plan\n", noteUri);

        await askAgent(() => Promise.resolve(activeAt(1)), "summarize");

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(CHAT_OPEN_COMMAND, {
            query: "In notes/plan.md#L1: summarize",
        });
    });

    it("a dirty document should be saved before the hand-off", async () => {
        configureRoute("clipboard");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        (doc as unknown as { applyReplace(r: Range, t: string): void }).applyReplace(
            new Range(doc.positionAt(0), doc.positionAt(0)),
            "x",
        );
        expect(doc.isDirty).toBe(true);

        await askAgent(() => Promise.resolve(activeAt(1)), "do x");

        expect(doc.save).toHaveBeenCalled();
        const saveOrder = vi.mocked(doc.save).mock.invocationCallOrder[0]!;
        const copyOrder = vi.mocked(vscode.env.clipboard.writeText).mock.invocationCallOrder[0]!;
        expect(saveOrder).toBeLessThan(copyOrder);
    });

    it("a save that fails should warn and send nothing", async () => {
        configureRoute("clipboard");
        const doc = makeFakeTextDocument("# Plan\n", noteUri);
        (doc as unknown as { applyReplace(r: Range, t: string): void }).applyReplace(
            new Range(doc.positionAt(0), doc.positionAt(0)),
            "x",
        );
        vi.mocked(doc.save).mockResolvedValueOnce(false);

        await askAgent(() => Promise.resolve(activeAt(1)), "do x");

        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    });

    it("no request should ask in an input box and use the answer", async () => {
        configureRoute("clipboard");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("  tighten this  ");

        await askAgent(() => Promise.resolve(activeAt(1)), undefined);

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("In notes/plan.md#L1: tighten this");
    });

    it("a cancelled input box should send nothing", async () => {
        configureRoute("clipboard");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

        await askAgent(() => Promise.resolve(activeAt(1)), "");

        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    });

    it("an unset route should ask once and store the pick globally", async () => {
        const { update } = configureRoute("");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            label: "Copy to clipboard",
            value: "clipboard",
        } as never);

        await askAgent(() => Promise.resolve(activeAt(1)), "do x");

        expect(update).toHaveBeenCalledWith("agent.command", "clipboard", vscode.ConfigurationTarget.Global);
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("In notes/plan.md#L1: do x");
    });

    it("dismissing the route picker should store nothing and send nothing", async () => {
        const { update } = configureRoute("");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

        await askAgent(() => Promise.resolve(activeAt(1)), "do x");

        expect(update).not.toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    });

    it("a route that throws should surface one error and not rethrow", async () => {
        configureRoute("chat");
        makeFakeTextDocument("# Plan\n", noteUri);
        vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("no chat"));

        await expect(askAgent(() => Promise.resolve(activeAt(1)), "do x")).resolves.toBeUndefined();

        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
});
