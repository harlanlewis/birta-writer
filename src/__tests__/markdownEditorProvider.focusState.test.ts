/**
 * focusState handling (MAR-104): the provider mirrors webview focus into the
 * `birta.webviewFocused` when-clause context key so document-mutating
 * keybindings (deleteBlock, joinLines, setHeading, …) fire only while an editor
 * webview is truly focused — not merely because its tab is the active custom
 * editor with focus parked in the Explorer. A Set backs the key so a split view
 * of several editor webviews reports focused while any one holds focus.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
} from "../../__mocks__/vscode";

import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
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

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

type Panel = ReturnType<typeof makePanel>;
type Handler = (msg: Record<string, unknown>) => Promise<void>;

async function resolvePanel(
    provider: MarkdownEditorProvider,
    fsPath: string,
): Promise<{ panel: Panel; handler: Handler }> {
    const document = makeFakeTextDocument("hello\n", vscode.Uri.file(fsPath));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0] as Handler;
    await handler({ type: "ready" });
    return { panel, handler };
}

/** The last `birta.webviewFocused` value pushed via setContext, or undefined. */
function lastFocusContext(): boolean | undefined {
    const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter(
        (c) => c[0] === "setContext" && c[1] === "birta.webviewFocused",
    );
    return calls.length ? (calls[calls.length - 1][2] as boolean) : undefined;
}

function focusContextCallCount(): number {
    return vi.mocked(vscode.commands.executeCommand).mock.calls.filter(
        (c) => c[0] === "setContext" && c[1] === "birta.webviewFocused",
    ).length;
}

describe("MarkdownEditorProvider focusState handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a focusState:true message should set birta.webviewFocused true", async () => {
        // Arrange
        const provider = new MarkdownEditorProvider(makeContext());
        const { handler } = await resolvePanel(provider, "/project/a.md");

        // Act
        await handler({ type: "focusState", focused: true });

        // Assert
        expect(lastFocusContext()).toBe(true);
    });

    it("a focusState:false after focus should set birta.webviewFocused false", async () => {
        // Arrange
        const provider = new MarkdownEditorProvider(makeContext());
        const { handler } = await resolvePanel(provider, "/project/a.md");

        // Act
        await handler({ type: "focusState", focused: true });
        await handler({ type: "focusState", focused: false });

        // Assert
        expect(lastFocusContext()).toBe(false);
    });

    it("a redundant focusState:true should not re-push the context key", async () => {
        // Arrange
        const provider = new MarkdownEditorProvider(makeContext());
        const { handler } = await resolvePanel(provider, "/project/a.md");

        // Act
        await handler({ type: "focusState", focused: true });
        const after = focusContextCallCount();
        await handler({ type: "focusState", focused: true });

        // Assert — no state change, no extra setContext.
        expect(focusContextCallCount()).toBe(after);
    });

    it("in a split view the key should stay true until the last webview blurs", async () => {
        // Arrange — two editor webviews on one provider (split view).
        const provider = new MarkdownEditorProvider(makeContext());
        const a = await resolvePanel(provider, "/project/a.md");
        const b = await resolvePanel(provider, "/project/b.md");

        // Act / Assert — focus both, then blur one at a time.
        await a.handler({ type: "focusState", focused: true });
        await b.handler({ type: "focusState", focused: true });
        expect(lastFocusContext()).toBe(true);

        await a.handler({ type: "focusState", focused: false });
        expect(lastFocusContext()).toBe(true); // b still focused

        await b.handler({ type: "focusState", focused: false });
        expect(lastFocusContext()).toBe(false); // none focused
    });
});
