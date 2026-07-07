/**
 * openUrl handling: the provider opens external links via vscode.env.openExternal
 * after the safety gate (isSafeExternalUrl). Confirmation is VS Code's job — the
 * editor never shows its own dialog: openExternal already runs through the
 * native trusted-domains prompt, so an extension-level confirm would just stack
 * a second dialog on top of it.
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

    it("a safe URL should open directly with no extension-level dialog", async () => {
        // Arrange
        const { handler } = await setup();

        // Act
        await handler({ type: "openUrl", url: "https://example.com/page" });

        // Assert
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscode.env.openExternal).toHaveBeenCalledOnce();
        const opened = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as vscode.Uri;
        expect(opened.toString()).toContain("example.com");
    });

    it("a fragment should survive to openExternal", async () => {
        // Arrange
        const { handler } = await setup();

        // Act
        await handler({ type: "openUrl", url: "https://example.com/page#section" });

        // Assert
        const opened = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as vscode.Uri;
        expect(opened.toString()).toContain("section");
    });

    it("an unsafe URL should be blocked before any open", async () => {
        // Arrange
        const { handler } = await setup();

        // Act
        await handler({ type: "openUrl", url: "javascript:alert(1)" });

        // Assert
        expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
});
