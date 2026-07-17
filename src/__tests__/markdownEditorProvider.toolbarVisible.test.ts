/**
 * Whole-toolbar visibility on the extension side: the setToolbarVisible
 * message persists birta.toolbar.visible (respecting the winning
 * scope), and getToolbarConfig carries the value to the webview bootstrap /
 * toolbarConfig echoes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";

import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import { getToolbarConfig } from "../config";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

/** Minimal WebviewPanel fake covering everything resolveCustomTextEditor touches */
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

/** Configuration fake with a controllable inspect() and a spyable update(). */
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

describe("MarkdownEditorProvider toolbar visibility", () => {
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

    it("a setToolbarVisible message should write toolbar.visible to the Global scope by default", async () => {
        // Arrange
        const { handler } = await setup();
        const { update } = mockConfiguration();

        // Act
        await handler({ type: "setToolbarVisible", visible: false });

        // Assert
        expect(update).toHaveBeenCalledWith(
            "toolbar.visible",
            false,
            vscode.ConfigurationTarget.Global,
        );
    });

    it("a setToolbarVisible message should write to the Workspace scope when a workspace value wins", async () => {
        // Arrange
        const { handler } = await setup();
        const { update } = mockConfiguration({
            inspect: () => ({ workspaceValue: false }),
        });

        // Act
        await handler({ type: "setToolbarVisible", visible: true });

        // Assert
        expect(update).toHaveBeenCalledWith(
            "toolbar.visible",
            true,
            vscode.ConfigurationTarget.Workspace,
        );
    });

    it("getToolbarConfig should default visible to true and pass a stored false through", () => {
        // Arrange / Act / Assert — default
        mockConfiguration();
        expect(getToolbarConfig().visible).toBe(true);

        // Arrange / Act / Assert — user hid the toolbar
        mockConfiguration({
            get: (key, defaultValue) => (key === "toolbar.visible" ? false : defaultValue),
        });
        expect(getToolbarConfig().visible).toBe(false);
    });
});
