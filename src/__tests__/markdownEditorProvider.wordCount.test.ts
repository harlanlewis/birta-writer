/**
 * Status bar word-count wiring (MAR-29): the webview posts `wordCount` messages;
 * the provider renders them into the injected status bar view — but only for the
 * active editor — caches them per document, and shows/hides on activation and
 * disposal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import type { WordCountView } from "../wordCountStatus";
import type { TextCount } from "../../shared/messages";

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

const makeView = (): WordCountView & { update: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> } => ({
    update: vi.fn(),
    hide: vi.fn(),
});

/** Grab the message handler the provider registered on a panel. */
const messageHandler = (panel: ReturnType<typeof makePanel>) =>
    panel.webview.onDidReceiveMessage.mock.calls[0][0] as (m: unknown) => void | Promise<void>;

/** Grab the view-state handler the provider registered on a panel. */
const viewStateHandler = (panel: ReturnType<typeof makePanel>) =>
    panel.onDidChangeViewState.mock.calls[0][0] as (e: { webviewPanel: unknown }) => void;

/** Fire an onDidDispose handler registered on a panel. */
const disposeHandlers = (panel: ReturnType<typeof makePanel>) =>
    panel.onDidDispose.mock.calls.map((c) => c[0] as () => void);

const doc: TextCount = { words: 100, characters: 500, readingTimeMinutes: 1 };
const selection: TextCount = { words: 10, characters: 42, readingTimeMinutes: 1 };

async function setup() {
    const provider = new MarkdownEditorProvider(makeContext());
    const view = makeView();
    provider.setWordCountView(view);
    const uriA = vscode.Uri.file("/project/a.md");
    const uriB = vscode.Uri.file("/project/b.md");
    const panelA = makePanel();
    const panelB = makePanel();
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("aaa\n", uriA) as unknown as vscode.TextDocument,
        panelA as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    // B resolves last → _activePanel is B.
    await provider.resolveCustomTextEditor(
        makeFakeTextDocument("bbb\n", uriB) as unknown as vscode.TextDocument,
        panelB as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    return { provider, view, uriA, uriB, panelA, panelB };
}

describe("MarkdownEditorProvider word-count status bar", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a wordCount message from the active panel should render into the status bar", async () => {
        const { view, panelB } = await setup();
        view.update.mockClear();

        await messageHandler(panelB)({ type: "wordCount", doc, selection: null });

        expect(view.update).toHaveBeenCalledWith(doc, null);
    });

    it("a wordCount message from an inactive panel should not render (only cache)", async () => {
        const { view, panelA } = await setup();
        view.update.mockClear();

        await messageHandler(panelA)({ type: "wordCount", doc, selection: null });

        // panelA is not the active editor → the readout must not change.
        expect(view.update).not.toHaveBeenCalled();
    });

    it("re-activating a panel should re-render its cached counts", async () => {
        const { view, panelA } = await setup();
        // Cache counts for A while it is inactive.
        await messageHandler(panelA)({ type: "wordCount", doc, selection });
        view.update.mockClear();

        // Now A becomes active again (retained webview, no fresh report).
        panelA.active = true;
        viewStateHandler(panelA)({ webviewPanel: panelA });

        expect(view.update).toHaveBeenCalledWith(doc, selection);
    });

    it("deactivating the active panel should hide the readout", async () => {
        const { view, panelB } = await setup();
        view.hide.mockClear();

        panelB.active = false;
        viewStateHandler(panelB)({ webviewPanel: panelB });

        expect(view.hide).toHaveBeenCalled();
    });

    it("disposing the active panel should hide the readout", async () => {
        const { view, panelB } = await setup();
        view.hide.mockClear();

        for (const fn of disposeHandlers(panelB)) { fn(); }

        expect(view.hide).toHaveBeenCalled();
    });
});
