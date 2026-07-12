/**
 * Fold-affordance derivation on the extension side (MAR-110): the native
 * `editor.showFoldingControls` / `editor.folding` settings — read scoped to
 * the document URI — are baked into the webview HTML as `<body>` classes at
 * resolve time, and the live path re-resolves per open document and posts
 * per-webview (never one global broadcast).
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

/** Section-aware config mock: `editor` reads come from `editorValues`. */
function mockConfiguration(editorValues: Record<string, unknown>) {
    const defaultCfg = {
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
    };
    const editorCfg = {
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key in editorValues ? editorValues[key] : defaultValue,
        ),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockImplementation(
        (section?: string) => (section === "editor" ? editorCfg : defaultCfg),
    );
}

async function resolvedPanel(editorValues: Record<string, unknown>) {
    mockConfiguration(editorValues);
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    return { provider, panel };
}

function bodyClass(html: string): string {
    const match = html.match(/<body class="([^"]*)"/);
    expect(match, "webview HTML has no <body class>").not.toBeNull();
    return match![1]!;
}

describe("MarkdownEditorProvider folding controls bake", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("the default (mouseover, folding on) should emit no fold body class", async () => {
        const { panel } = await resolvedPanel({});
        const cls = bodyClass(panel.webview.html);
        expect(cls).not.toContain("fold-controls-always");
        expect(cls).not.toContain("fold-controls-never");
        expect(cls).not.toContain("folding-disabled");
    });

    it("showFoldingControls always should emit the fold-controls-always body class", async () => {
        const { panel } = await resolvedPanel({ showFoldingControls: "always" });
        expect(bodyClass(panel.webview.html)).toContain("fold-controls-always");
    });

    it("showFoldingControls never should emit the fold-controls-never body class", async () => {
        const { panel } = await resolvedPanel({ showFoldingControls: "never" });
        expect(bodyClass(panel.webview.html)).toContain("fold-controls-never");
    });

    it("editor.folding false should emit only the folding-disabled class", async () => {
        const { panel } = await resolvedPanel({ folding: false, showFoldingControls: "always" });
        const cls = bodyClass(panel.webview.html);
        expect(cls).toContain("folding-disabled");
        expect(cls).not.toContain("fold-controls-always");
    });

    it("an out-of-enum showFoldingControls value should fall back to the default", async () => {
        const { panel } = await resolvedPanel({ showFoldingControls: "sometimes" });
        const cls = bodyClass(panel.webview.html);
        expect(cls).not.toContain("fold-controls-always");
        expect(cls).not.toContain("fold-controls-never");
    });
});

describe("MarkdownEditorProvider broadcastFoldingConfig", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a config change should post a per-panel setFoldingControls message", async () => {
        // Arrange: resolve with defaults, then flip the live config.
        const { provider, panel } = await resolvedPanel({});
        mockConfiguration({ showFoldingControls: "always", folding: true });

        // Act
        provider.broadcastFoldingConfig();

        // Assert
        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            type: "setFoldingControls",
            controls: "always",
            enabled: true,
        });
    });

    it("disabling editor.folding should broadcast enabled false", async () => {
        const { provider, panel } = await resolvedPanel({});
        mockConfiguration({ folding: false });

        provider.broadcastFoldingConfig();

        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            type: "setFoldingControls",
            controls: "mouseover",
            enabled: false,
        });
    });
});
