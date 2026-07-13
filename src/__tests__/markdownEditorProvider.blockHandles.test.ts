/**
 * Resting block-handle mode on the extension side: the `blockHandles`
 * setting is baked into the webview HTML as a `<body>` class at resolve time
 * (the live config-change echo is wired in extension.ts and covered by the
 * webview applyBlockHandles tests), including the read-side migration of the
 * pre-rename `gutterMarkers` key.
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

/**
 * Mock the markdownWysiwyg configuration from a map of user-set values:
 * `get` returns the value (or the default), and `inspect` reports a
 * globalValue only for the keys present — the shape the provider's legacy
 * migration reads.
 */
function mockConfiguration(userValues: Record<string, unknown> = {}) {
    const cfg = {
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key in userValues ? userValues[key] : defaultValue),
        inspect: vi.fn((key: string) =>
            key in userValues ? { key, globalValue: userValues[key] } : { key }),
        update: vi.fn(),
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
}

/** Resolve an editor with the given user-set values mocked; return the HTML. */
async function htmlForConfig(userValues: Record<string, unknown>): Promise<string> {
    mockConfiguration(userValues);
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    return panel.webview.html;
}

function bodyClass(html: string): string {
    const match = html.match(/<body class="([^"]*)"/);
    expect(match, "webview HTML has no <body class>").not.toBeNull();
    return match![1]!;
}

describe("MarkdownEditorProvider block handles", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("the default (headings) mode should emit no handles-rest body class", async () => {
        const cls = bodyClass(await htmlForConfig({}));
        expect(cls).not.toContain("handles-rest-hover");
        expect(cls).not.toContain("handles-rest-always");
    });

    it("the hover mode should emit the handles-rest-hover body class", async () => {
        expect(bodyClass(await htmlForConfig({ blockHandles: "hover" }))).toContain("handles-rest-hover");
    });

    it("the always mode should emit the handles-rest-always body class", async () => {
        expect(bodyClass(await htmlForConfig({ blockHandles: "always" }))).toContain("handles-rest-always");
    });

    it("an out-of-enum settings value should fall back to the default mode", async () => {
        const cls = bodyClass(await htmlForConfig({ blockHandles: "everything" }));
        expect(cls).not.toContain("handles-rest-hover");
        expect(cls).not.toContain("handles-rest-always");
    });
});

describe("MarkdownEditorProvider legacy gutterMarkers migration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a user-set legacy none with blockHandles unset should bake handles-rest-hover", async () => {
        expect(bodyClass(await htmlForConfig({ gutterMarkers: "none" }))).toContain("handles-rest-hover");
    });

    it("a user-set legacy all with blockHandles unset should bake handles-rest-always", async () => {
        expect(bodyClass(await htmlForConfig({ gutterMarkers: "all" }))).toContain("handles-rest-always");
    });

    it("an explicitly set blockHandles should win over the legacy value", async () => {
        const cls = bodyClass(await htmlForConfig({ gutterMarkers: "none", blockHandles: "always" }));
        expect(cls).toContain("handles-rest-always");
        expect(cls).not.toContain("handles-rest-hover");
    });

    it("neither key set should stay on the default (no handles-rest class)", async () => {
        const cls = bodyClass(await htmlForConfig({}));
        expect(cls).not.toContain("handles-rest-hover");
        expect(cls).not.toContain("handles-rest-always");
    });

    it("a garbage legacy value should be ignored in favor of the default", async () => {
        const cls = bodyClass(await htmlForConfig({ gutterMarkers: "everything" }));
        expect(cls).not.toContain("handles-rest-hover");
        expect(cls).not.toContain("handles-rest-always");
    });
});

describe("MarkdownEditorProvider setBlockHandles message", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    async function setupHandler() {
        mockConfiguration();
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md"));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        return panel.webview.onDidReceiveMessage.mock
            .calls[0]![0] as unknown as (msg: Record<string, unknown>) => Promise<void>;
    }

    it("a setBlockHandles message should persist the mode to the winning scope", async () => {
        // Arrange
        const handler = await setupHandler();
        const update = vi.fn();
        const cfg = { get: vi.fn((_k: string, d?: unknown) => d), inspect: vi.fn(() => undefined), update };
        (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);

        // Act
        await handler({ type: "setBlockHandles", mode: "always" });

        // Assert
        expect(update).toHaveBeenCalledWith("blockHandles", "always", vscode.ConfigurationTarget.Global);
    });

    it("an out-of-enum mode from the webview should be normalized before the write", async () => {
        // Arrange
        const handler = await setupHandler();
        const update = vi.fn();
        const cfg = { get: vi.fn((_k: string, d?: unknown) => d), inspect: vi.fn(() => undefined), update };
        (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);

        // Act
        await handler({ type: "setBlockHandles", mode: "garbage" });

        // Assert
        expect(update).toHaveBeenCalledWith("blockHandles", "headings", vscode.ConfigurationTarget.Global);
    });
});
