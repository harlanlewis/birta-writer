/**
 * The per-URI view-state echo: the webview mirrors its state bag (fold
 * anchors, scroll, frontmatter collapse) via `viewState` messages; a LATER
 * webview for the same document gets it back in `init`. This is what makes
 * the raw-editor round trip — which CLOSES the custom tab and destroys VS
 * Code's own webview state — lossless for view state.
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

async function resolve(provider: MarkdownEditorProvider, doc: unknown) {
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        doc as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    return { panel, handler };
}

function lastInit(panel: ReturnType<typeof makePanel>): Record<string, unknown> | undefined {
    const inits = panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string })
        .filter((m) => m.type === "init");
    return inits[inits.length - 1] as Record<string, unknown> | undefined;
}

describe("MarkdownEditorProvider view-state echo", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a bag posted by one webview should ride the NEXT webview's init for the same doc", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));

        const first = await resolve(provider, doc);
        await first.handler({ type: "ready" });
        await first.handler({ type: "viewState", state: { fmCollapsed: true, scrollY: 42 } });

        // The raw-editor switch closes the tab; reopening resolves a NEW panel.
        const second = await resolve(provider, doc);
        await second.handler({ type: "ready" });

        expect(lastInit(second.panel)?.["viewState"]).toEqual({ fmCollapsed: true, scrollY: 42 });
    });

    it("a document never echoed should init with no viewState", async () => {
        const provider = new MarkdownEditorProvider(makeContext());
        const doc = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/other.md"));
        const { panel, handler } = await resolve(provider, doc);
        await handler({ type: "ready" });
        expect(lastInit(panel)?.["viewState"]).toBeUndefined();
    });
});
