/**
 * openUrl handling: the provider opens external links via vscode.env.openExternal,
 * but only after the safety gate (isSafeExternalUrl) and, when
 * `markdownWriter.confirmExternalLinks` is enabled (default), an explicit
 * confirmation dialog. This keeps a document from navigating anywhere without
 * the user's consent — the last outbound path after the network-egress removal.
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

/** Force `confirmExternalLinks` to a specific value; all other keys fall through to their default. */
function setConfirmExternalLinks(value: boolean): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key === "confirmExternalLinks" ? value : defaultValue,
        ),
    } as unknown as vscode.WorkspaceConfiguration);
}

async function setup() {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    return { handler };
}

describe("MarkdownEditorProvider openUrl handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("confirmExternalLinks enabled and confirmed should open the URL", async () => {
        // Arrange
        const { handler } = await setup();
        setConfirmExternalLinks(true);
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Open" as never);

        // Act
        await handler({ type: "openUrl", url: "https://example.com/page" });

        // Assert
        expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
        expect(vscode.env.openExternal).toHaveBeenCalledOnce();
        const opened = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as vscode.Uri;
        expect(opened.toString()).toContain("example.com");
    });

    it("confirmExternalLinks enabled and cancelled should NOT open the URL", async () => {
        // Arrange
        const { handler } = await setup();
        setConfirmExternalLinks(true);
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

        // Act
        await handler({ type: "openUrl", url: "https://example.com/page" });

        // Assert
        expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
        expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it("confirmExternalLinks disabled should open the URL without a confirmation dialog", async () => {
        // Arrange
        const { handler } = await setup();
        setConfirmExternalLinks(false);

        // Act
        await handler({ type: "openUrl", url: "https://example.com/page" });

        // Assert
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscode.env.openExternal).toHaveBeenCalledOnce();
    });

    it("an unsafe URL should be blocked before any dialog or open", async () => {
        // Arrange
        const { handler } = await setup();
        setConfirmExternalLinks(true);

        // Act
        await handler({ type: "openUrl", url: "javascript:alert(1)" });

        // Assert
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
});
