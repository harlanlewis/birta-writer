/**
 * getActiveEditorContext (the coding-agent bridge's pull): the provider posts a
 * `requestEditorContext` to the active webview and resolves with its reply,
 * degrades to null when nothing answers within the timeout, and returns null
 * when no Birta editor is active.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import type { EditorSelectionContext } from "../../shared/agentContext";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
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

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

const messageHandler = (panel: ReturnType<typeof makePanel>) =>
    panel.webview.onDidReceiveMessage.mock.calls[0][0] as (m: unknown) => void | Promise<void>;

/** The id the provider tagged its most recent requestEditorContext with. */
const lastRequestId = (panel: ReturnType<typeof makePanel>): string => {
    const calls = panel.webview.postMessage.mock.calls as Array<[{ type: string; id: string }]>;
    const req = [...calls].reverse().find((c) => c[0]?.type === "requestEditorContext");
    if (!req) { throw new Error("no requestEditorContext was posted"); }
    return req[0].id;
};

const sampleContext: EditorSelectionContext = {
    selections: [{ anchor: { line: 2, column: 0 }, active: { line: 4, column: 3 }, text: "hi" }],
    primary: 0,
    isEmpty: false,
};

async function withActivePanel() {
    const provider = new MarkdownEditorProvider(makeContext());
    const uri = vscode.Uri.file("/project/a.md");
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("aaa\n", uri) as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    return { provider, uri, panel };
}

describe("MarkdownEditorProvider.getActiveEditorContext", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resetTextDocumentMocks();
    });

    it("should return null when no Birta editor is active", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        expect(await provider.getActiveEditorContext()).toBeNull();
    });

    it("should post requestEditorContext and resolve with the webview's reply", async () => {
        const { provider, uri, panel } = await withActivePanel();

        const pending = provider.getActiveEditorContext();
        // The provider asked the active webview for its selection.
        const id = lastRequestId(panel);
        // The webview answers.
        await messageHandler(panel)({ type: "editorContextResult", id, context: sampleContext });

        const result = await pending;
        expect(result?.uri.toString()).toBe(uri.toString());
        expect(result?.context).toEqual(sampleContext);
    });

    it("should resolve null when the webview does not answer before the timeout", async () => {
        vi.useFakeTimers();
        const { provider } = await withActivePanel();

        const pending = provider.getActiveEditorContext();
        await vi.advanceTimersByTimeAsync(1000);

        expect(await pending).toBeNull();
    });

    it("should ignore a reply whose id does not match a pending request", async () => {
        const { provider, panel } = await withActivePanel();

        const pending = provider.getActiveEditorContext();
        const id = lastRequestId(panel);
        // A stale/unknown id must not resolve the request...
        await messageHandler(panel)({ type: "editorContextResult", id: "ctx-stale", context: null });
        // ...but the correct one does.
        await messageHandler(panel)({ type: "editorContextResult", id, context: sampleContext });

        expect((await pending)?.context).toEqual(sampleContext);
    });
});

describe("MarkdownEditorProvider askAgent routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resetTextDocumentMocks();
    });

    it("an askAgent message should run birta.askAgent with the prompt", async () => {
        const { panel } = await withActivePanel();

        await messageHandler(panel)({ type: "askAgent", prompt: "add a diagram", requestId: "ai1" });

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("birta.askAgent", "add a diagram", "ai1");
    });

    it("an askAgent message without a prompt should run the command with none", async () => {
        const { panel } = await withActivePanel();

        await messageHandler(panel)({ type: "askAgent" });

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("birta.askAgent", undefined, undefined);
    });
});
