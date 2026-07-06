/**
 * postEditorCommand routing: keybinding/palette invocations carry no target
 * document, and with split editors two panels are simultaneously "active" in
 * their groups — `_activePanel` (last view-state change) may name the wrong
 * split. The router must prefer, in order: the explicitly named document,
 * the focused group's active tab (where the keybinding's group-scoped
 * when-clause actually matched), then `_activePanel`.
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

/** Only messages of type editorCommand, so setup traffic doesn't interfere. */
const editorCommandCalls = (panel: ReturnType<typeof makePanel>) =>
    panel.webview.postMessage.mock.calls.filter(
        ([msg]) => (msg as { type: string }).type === "editorCommand",
    );

async function setupTwoPanels() {
    const provider = new MarkdownEditorProvider(makeContext());
    const uriA = vscode.Uri.file("/project/a.md");
    const uriB = vscode.Uri.file("/project/b.md");
    const panelA = makePanel();
    const panelB = makePanel();
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("aaa\n", uriA) as unknown as vscode.TextDocument,
        panelA as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    // B resolves last: _activePanel is B
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("bbb\n", uriB) as unknown as vscode.TextDocument,
        panelB as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    return { provider, uriA, uriB, panelA, panelB };
}

describe("MarkdownEditorProvider postEditorCommand routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
    });

    it("an explicit document uri should route to that panel regardless of focus", async () => {
        const { provider, uriA, panelA, panelB } = await setupTwoPanels();
        vscode.window.tabGroups.activeTabGroup.activeTab = {
            input: new vscode.TabInputCustom(uriA /* ignored: named wins */, "markdownWriter.editor"),
        };

        provider.postEditorCommand("openFind", uriA.toString());

        expect(editorCommandCalls(panelA)).toHaveLength(1);
        expect(editorCommandCalls(panelB)).toHaveLength(0);
    });

    it("with split editors the focused group's tab should win over the last-resolved panel", async () => {
        const { provider, uriA, panelA, panelB } = await setupTwoPanels();
        // _activePanel is B (resolved last), but focus sits in A's group
        vscode.window.tabGroups.activeTabGroup.activeTab = {
            input: new vscode.TabInputCustom(uriA, "markdownWriter.editor"),
        };

        provider.postEditorCommand("openFind");

        expect(editorCommandCalls(panelA)).toHaveLength(1);
        expect(editorCommandCalls(panelB)).toHaveLength(0);
    });

    it("a non-custom focused tab should fall back to the active panel", async () => {
        const { provider, panelA, panelB } = await setupTwoPanels();
        // e.g. focus in a plain text editor tab: input is not TabInputCustom
        vscode.window.tabGroups.activeTabGroup.activeTab = { input: {} };

        provider.postEditorCommand("openFind");

        expect(editorCommandCalls(panelA)).toHaveLength(0);
        expect(editorCommandCalls(panelB)).toHaveLength(1);
    });

    it("no focused tab at all should fall back to the active panel", async () => {
        const { provider, panelA, panelB } = await setupTwoPanels();

        provider.postEditorCommand("findNext");

        expect(editorCommandCalls(panelA)).toHaveLength(0);
        expect(editorCommandCalls(panelB)).toHaveLength(1);
    });
});
