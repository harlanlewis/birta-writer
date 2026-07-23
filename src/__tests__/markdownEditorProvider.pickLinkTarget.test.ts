/**
 * pickLinkTarget handling: the link editor's "browse" button asks the
 * extension to open the OS-native file dialog and expects the picked file
 * back as a DOCUMENT-relative posix path (the same form a hand-typed link
 * takes), or null on cancel — the reply must always arrive, since the
 * webview's button waits on it.
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

const DOC_PATH = "/repo/docs/guide/page.md";

async function setup() {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("hello\n", vscode.Uri.file(DOC_PATH));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    return { provider, handler, panel };
}

/** All linkTargetPicked replies posted so far, as [id, path]. */
function pickedReplies(panel: ReturnType<typeof makePanel>): Array<[string, string | null]> {
    return panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string; id: string; path: string | null })
        .filter((m) => m.type === "linkTargetPicked")
        .map((m) => [m.id, m.path]);
}

describe("MarkdownEditorProvider pickLinkTarget handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        (vscode.window.tabGroups as unknown as { all: unknown[] }).all = [];
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
            { uri: vscode.Uri.file("/repo") },
        ];
    });

    it("replies with a document-relative posix path for a picked file", async () => {
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file("/repo/docs/POSITIONING.md"),
        ]);
        const { handler, panel } = await setup();

        await handler({ type: "pickLinkTarget", id: "p1" });

        expect(pickedReplies(panel)).toEqual([["p1", "../POSITIONING.md"]]);
        // The dialog opened anchored at the document's own folder.
        const opts = vi.mocked(vscode.window.showOpenDialog).mock
            .calls[0][0] as vscode.OpenDialogOptions;
        expect(opts.defaultUri?.fsPath).toBe(vscode.Uri.file("/repo/docs/guide").fsPath);
        expect(opts.canSelectMany).toBe(false);
        expect(opts.canSelectFolders).toBe(false);
    });

    it("a sibling pick stays a bare relative name", async () => {
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file("/repo/docs/guide/other.md"),
        ]);
        const { handler, panel } = await setup();

        await handler({ type: "pickLinkTarget", id: "p2" });

        expect(pickedReplies(panel)).toEqual([["p2", "other.md"]]);
    });

    it("cancel replies null (the webview must never wait forever)", async () => {
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);
        const { handler, panel } = await setup();

        await handler({ type: "pickLinkTarget", id: "p3" });

        expect(pickedReplies(panel)).toEqual([["p3", null]]);
    });

    // (The handler's non-file-scheme guard is defense in depth only: the
    // provider never finishes resolving a webview for a non-file document,
    // so no message can arrive on that path to test through.)

    it("a dialog failure still replies null", async () => {
        vi.mocked(vscode.window.showOpenDialog).mockRejectedValue(new Error("boom"));
        const { handler, panel } = await setup();

        await handler({ type: "pickLinkTarget", id: "p5" });

        expect(pickedReplies(panel)).toEqual([["p5", null]]);
    });
});
