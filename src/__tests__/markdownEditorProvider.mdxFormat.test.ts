/**
 * MDX plumbing in the provider (MAR-42): the `init` message tells the webview
 * which FormatModule to build with (derived from the document URI), and a
 * `fatalParse` reply — invalid MDX cannot open WYSIWYG — surfaces the error
 * and falls back to the text editor without touching the document.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider, fatalParseNotice } from "../MarkdownEditorProvider";

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

const makeCancellation = () => ({ isCancellationRequested: false }) as vscode.CancellationToken;

async function setup(path: string, content = "hello\n") {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument(content, vscode.Uri.file(path));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0]![0] as (msg: Record<string, unknown>) => Promise<void>;
    return { panel, handler };
}

/** The init message the ready handshake posted, or undefined. */
function postedInit(panel: ReturnType<typeof makePanel>): Record<string, unknown> | undefined {
    return panel.webview.postMessage.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((m) => m["type"] === "init");
}

describe("init carries the document format", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a .mdx document should init with format mdx", async () => {
        const { panel, handler } = await setup("/project/page.mdx");
        await handler({ type: "ready" });
        expect(postedInit(panel)?.["format"]).toBe("mdx");
    });

    it("a .MDX document should init with format mdx (extension match is case-insensitive)", async () => {
        const { panel, handler } = await setup("/project/PAGE.MDX");
        await handler({ type: "ready" });
        expect(postedInit(panel)?.["format"]).toBe("mdx");
    });

    it("a .md document should init with format markdown", async () => {
        const { panel, handler } = await setup("/project/note.md");
        await handler({ type: "ready" });
        expect(postedInit(panel)?.["format"]).toBe("markdown");
    });
});

describe("fatalParse falls back to the text editor", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("should surface the parse error and reopen the document as text", async () => {
        const { panel, handler } = await setup("/project/broken.mdx", "a {unclosed\n");

        await handler({ type: "fatalParse", error: "Unexpected end of file in expression" });

        // The user is told why the visual editor did not open...
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
        const said = (vscode.window.showErrorMessage as ReturnType<typeof vi.fn>).mock
            .calls[0]![0] as string;
        expect(said).toContain("Unexpected end of file in expression");
        // ...the WYSIWYG pane is closed (no custom tab is registered in the
        // mock, so the fallback disposes the panel directly)...
        expect(panel.dispose).toHaveBeenCalledTimes(1);
        // ...and the same document reopens in the text editor.
        expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
        expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
    });

    it("should report the position in document lines, not body lines", async () => {
        // Four frontmatter lines, then a body whose first line is document
        // line 5. The webview parses the body and reports 1:12.
        const content = "---\ntitle: x\ntags: []\n---\na {unclosed\n";
        const { handler } = await setup("/project/broken.mdx", content);
        await handler({ type: "ready" });

        await handler({ type: "fatalParse", error: "unclosed brace", line: 1, column: 12 });

        const said = (vscode.window.showErrorMessage as ReturnType<typeof vi.fn>).mock
            .calls[0]![0] as string;
        expect(said).toContain("Line 5, column 12");
        expect(said).toContain("unclosed brace");
    });
});

describe("fatalParseNotice", () => {
    it("a document with no frontmatter should report the parser's own line", () => {
        expect(fatalParseNotice("boom", { line: 3, column: 7 }, 0)).toContain("Line 3, column 7");
    });

    it("a document with frontmatter should shift the line by its length", () => {
        expect(fatalParseNotice("boom", { line: 3, column: 7 }, 4)).toContain("Line 7, column 7");
    });

    it("an unpositioned failure should read as a plain reason", () => {
        const said = fatalParseNotice("boom", undefined, 4);
        expect(said).toContain("boom");
        expect(said).not.toContain("Line");
    });

    it("a position left inside the reason text should be shifted too", () => {
        // The unclosed-tag family embeds its own range; the webview lifts the
        // trailing one out, so this covers a shape it could not.
        expect(fatalParseNotice("bad (2:1-2:6) here", undefined, 4))
            .toContain("(6:1-6:6)");
    });

    it("a reason containing a colon pair should be untouched without frontmatter", () => {
        expect(fatalParseNotice("bad (2:1-2:6) here", undefined, 0))
            .toContain("(2:1-2:6)");
    });
});
