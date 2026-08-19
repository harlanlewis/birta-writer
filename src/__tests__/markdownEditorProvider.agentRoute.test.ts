/**
 * The `/ai` route summary reaching the webview (MarkdownEditorProvider, the
 * `ready` handshake): the slash menu's hint can only be honest if the summary
 * actually arrives, and the push is one line in a long method with nothing
 * else pointing at it.
 *
 * The claim under test is also a boundary: what crosses is display facts, and
 * never `birta.agent.command` itself, which is a shell template and the
 * user's machine configuration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import type { AgentRouteSummary } from "../../shared/messages";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";

const makeContext = () => ({
    subscriptions: [],
    extensionUri: vscode.Uri.file("/ext"),
    extensionPath: "/ext",
    globalState: { get: vi.fn(), update: vi.fn() },
    workspaceState: { get: vi.fn(), update: vi.fn() },
}) as unknown as vscode.ExtensionContext;

const makePanel = () => ({
    viewColumn: 1,
    active: true,
    visible: true,
    webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview-resource:",
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
});

/** Resolve an editor and complete the webview's `ready` handshake. */
async function bootPanel(settings: Record<string, unknown>) {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (key: string, fallback?: unknown) => settings[key] ?? fallback,
        update: vi.fn(),
        has: vi.fn(),
        inspect: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);

    const provider = new MarkdownEditorProvider(makeContext());
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("hello\n", vscode.Uri.file("/project/a.md")) as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (m: unknown) => void | Promise<void>;
    await handler({ type: "ready" });
    return panel;
}

/** The route summary the provider posted, if any. */
const postedRoute = (panel: ReturnType<typeof makePanel>): AgentRouteSummary | undefined => {
    const calls = panel.webview.postMessage.mock.calls as Array<[{ type: string; route?: AgentRouteSummary }]>;
    return calls.find((c) => c[0]?.type === "agentRoute")?.[0].route;
};

describe("MarkdownEditorProvider: the /ai route summary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a configured command should reach the webview when it says it is ready", async () => {
        const panel = await bootPanel({
            "agent.command": "claude -p {prompt} --permission-mode acceptEdits --model haiku",
            "agent.mode": "background",
        });

        expect(postedRoute(panel)).toEqual({
            configured: true,
            kind: "shell",
            harness: "claude",
            model: "haiku",
            mode: "background",
        });
    });

    it("an unset command should still be pushed, so the hint can say Enter will ask", async () => {
        // The absence has to travel: a webview told nothing cannot tell the
        // difference between "no route" and "the message never came".
        const panel = await bootPanel({ "agent.command": "", "agent.mode": "background" });

        expect(postedRoute(panel)).toEqual({ configured: false, kind: "shell" });
    });

    it("the shell template itself should never be posted to the webview", async () => {
        const panel = await bootPanel({
            "agent.command": "claude -p {prompt} --permission-mode acceptEdits",
            "agent.mode": "background",
        });

        // Asserted through the parsed message rather than a substring of the
        // whole log: a mutation that renamed the type still left "agentRoute"
        // inside "agentRouteDISABLED", so the substring form reported a pass
        // for a push that was not happening.
        expect(postedRoute(panel)).toBeDefined();
        const everything = JSON.stringify(panel.webview.postMessage.mock.calls);
        expect(everything).not.toContain("{prompt}");
        expect(everything).not.toContain("permission-mode");
    });
});
