/**
 * Provider wiring for the webview crash boundary (MAR-169): a `crash` message
 * from the webview must reach the error sink — a console error for every
 * report, and a single deduped notification per session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import { _resetErrorSinkForTests } from "../errorSink";

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

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

describe("MarkdownEditorProvider crash reporting", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        _resetErrorSinkForTests();
        consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    async function setup() {
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument("hello\n", vscode.Uri.file("/project/note.md"));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        return panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    }

    it("a crash message should log to the console with its stack", async () => {
        const handler = await setup();

        await handler({ type: "crash", message: "boom", stack: "at somewhere", source: "error" });

        expect(consoleError).toHaveBeenCalledTimes(1);
        const [prefix, detail] = consoleError.mock.calls[0] as [string, string];
        expect(prefix).toContain("webview error");
        expect(detail).toContain("boom");
        expect(detail).toContain("at somewhere");
    });

    it("repeated crash messages should surface a single notification", async () => {
        const handler = await setup();

        await handler({ type: "crash", message: "boom 1", source: "error" });
        await handler({ type: "crash", message: "boom 2", source: "unhandledrejection" });
        await handler({ type: "crash", message: "boom 3", source: "error" });

        expect(consoleError).toHaveBeenCalledTimes(3);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    });
});
