/**
 * TOC dock side on the extension side: the setTocPosition message persists
 * markdownWysiwyg.tocPosition (respecting the winning scope). The config-change
 * echo back to the webview is wired in extension.ts and covered by the webview
 * setPosition tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";

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

function mockConfiguration(opts?: {
    inspect?: (key: string) => unknown;
    get?: (key: string, defaultValue?: unknown) => unknown;
}) {
    const update = vi.fn();
    const cfg = {
        get: vi.fn(opts?.get ?? ((_key: string, defaultValue?: unknown) => defaultValue)),
        inspect: vi.fn(opts?.inspect ?? (() => undefined)),
        update,
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
    return { cfg, update };
}

describe("MarkdownEditorProvider TOC position", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    async function setup() {
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md"));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0]![0] as unknown as (msg: Record<string, unknown>) => Promise<void>;
        return { provider, panel, handler };
    }

    it("a setTocPosition message should write tocPosition to the Global scope by default", async () => {
        // Arrange
        const { handler } = await setup();
        const { update } = mockConfiguration();

        // Act
        await handler({ type: "setTocPosition", position: "left" });

        // Assert
        expect(update).toHaveBeenCalledWith(
            "tocPosition",
            "left",
            vscode.ConfigurationTarget.Global,
        );
    });

    it("a setTocPosition message should write to the Workspace scope when a workspace value wins", async () => {
        // Arrange
        const { handler } = await setup();
        const { update } = mockConfiguration({
            inspect: () => ({ workspaceValue: "right" }),
        });

        // Act
        await handler({ type: "setTocPosition", position: "left" });

        // Assert
        expect(update).toHaveBeenCalledWith(
            "tocPosition",
            "left",
            vscode.ConfigurationTarget.Workspace,
        );
    });
});
