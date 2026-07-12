/**
 * Resting gutter-marker mode on the extension side: the `gutterMarkers`
 * setting is baked into the webview HTML as a `<body>` class at resolve time
 * (the live config-change echo is wired in extension.ts and covered by the
 * webview applyGutterMarkers tests).
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

function mockConfiguration(get?: (key: string, defaultValue?: unknown) => unknown) {
    const cfg = {
        get: vi.fn(get ?? ((_key: string, defaultValue?: unknown) => defaultValue)),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
}

/** Resolve an editor with `gutterMarkers` mocked to `mode`; return the HTML. */
async function htmlForMode(mode: unknown): Promise<string> {
    mockConfiguration((key, defaultValue) => (key === "gutterMarkers" ? mode : defaultValue));
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

describe("MarkdownEditorProvider gutter markers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("the default (headings) mode should emit no gutter-rest body class", async () => {
        const cls = bodyClass(await htmlForMode(undefined));
        expect(cls).not.toContain("gutter-rest-none");
        expect(cls).not.toContain("gutter-rest-all");
    });

    it("the none mode should emit the gutter-rest-none body class", async () => {
        expect(bodyClass(await htmlForMode("none"))).toContain("gutter-rest-none");
    });

    it("the all mode should emit the gutter-rest-all body class", async () => {
        expect(bodyClass(await htmlForMode("all"))).toContain("gutter-rest-all");
    });

    it("an out-of-enum settings value should fall back to the default mode", async () => {
        const cls = bodyClass(await htmlForMode("everything"));
        expect(cls).not.toContain("gutter-rest-none");
        expect(cls).not.toContain("gutter-rest-all");
    });
});
