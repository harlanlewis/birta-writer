/**
 * The caret handoff across a mode switch, extension side (MAR-23).
 *
 * Two halves meet here: what the webview is told when it boots (a BODY-relative
 * line map plus the frontmatter's line offset, so document lines survive the
 * trip), and where the raw editor opens when the webview hands its caret back.
 * The webview's half — mapping a caret to a source line/column — is covered in
 * webview/__tests__/sourceCaret.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
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

async function setup(content: string) {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument(content, vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    return { provider, handler, panel };
}

/** The init message the panel was booted with. */
const initMessage = (panel: ReturnType<typeof makePanel>): Record<string, unknown> =>
    panel.webview.postMessage.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((m) => m.type === "init")!;

/** The selection the last showTextDocument call asked for. */
const shownSelection = (): vscode.Range | undefined =>
    (vi.mocked(vscode.window.showTextDocument).mock.calls.at(-1)?.[1] as
        | vscode.TextDocumentShowOptions
        | undefined)?.selection;

describe("mode switch: what the webview is booted with", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        (vscode.window.tabGroups as unknown as { all: unknown[] }).all = [];
    });

    it("a document with no frontmatter should carry a zero line offset", async () => {
        const { panel } = await setup("# Title\n\nbody\n");
        const init = initMessage(panel);
        expect(init.lineMap).toEqual([1, 3]);
        expect(init.lineOffset).toBe(0);
    });

    it("a document with frontmatter should map the BODY and report the offset", async () => {
        // The webview renders the body only, so its doc.child(0) is "# Title".
        // A document-relative map would have named the frontmatter block first
        // and pointed every navigation one block early.
        const { panel } = await setup("---\ntitle: Note\n---\n\n# Title\n\nbody\n");
        const init = initMessage(panel);
        expect(init.lineMap).toEqual([2, 4]);
        expect(init.lineOffset).toBe(3);
        // Body block 1 starts at body line 2 → document line 5, which is where
        // "# Title" actually is.
        expect((init.lineMap as number[])[0] + (init.lineOffset as number)).toBe(5);
    });
});

describe("mode switch: where the raw editor opens", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        (vscode.window.tabGroups as unknown as { all: unknown[] }).all = [];
    });

    it("a line and column should become the text editor's selection", async () => {
        const { handler } = await setup("# Title\n\nsome body text\n");
        await handler({ type: "switchToTextEditor", line: 3, column: 5 });
        const selection = shownSelection();
        expect(selection?.start.line).toBe(2);
        expect(selection?.start.character).toBe(5);
        expect(selection?.end.character).toBe(5);
    });

    it("a column past the end of its line should clamp to the line's length", async () => {
        // The column is computed against the webview's view of the document; the
        // document itself is the authority on where a line ends.
        const { handler } = await setup("# Title\n\nshort\n");
        await handler({ type: "switchToTextEditor", line: 3, column: 99 });
        expect(shownSelection()?.start.character).toBe("short".length);
    });

    it("a line with no column should open at the start of that line", async () => {
        const { handler } = await setup("# Title\n\nbody\n");
        await handler({ type: "switchToTextEditor", line: 3 });
        const selection = shownSelection();
        expect(selection?.start.line).toBe(2);
        expect(selection?.start.character).toBe(0);
    });

    it("a switch with no position at all should leave the selection alone", async () => {
        const { handler } = await setup("# Title\n\nbody\n");
        await handler({ type: "switchToTextEditor" });
        expect(shownSelection()).toBeUndefined();
    });

    it("a carried selection should be restored with its anchor→active drag direction", async () => {
        const { handler } = await setup("# Title\n\nsome body text\n");
        await handler({
            type: "switchToTextEditor",
            line: 3, column: 9, anchorLine: 1, anchorColumn: 2,
        });
        const editor = await vi.mocked(vscode.window.showTextDocument).mock.results.at(-1)!
            .value as { selection: vscode.Selection };
        expect(editor.selection.anchor.line).toBe(0);
        expect(editor.selection.anchor.character).toBe(2);
        expect(editor.selection.active.line).toBe(2);
        expect(editor.selection.active.character).toBe(9);
    });

    it("the arriving caret should be centered, not left at the viewport edge", async () => {
        const { handler } = await setup("# Title\n\nbody\n");
        await handler({ type: "switchToTextEditor", line: 3, column: 2 });
        const editor = await vi.mocked(vscode.window.showTextDocument).mock.results.at(-1)!
            .value as { revealRange: ReturnType<typeof vi.fn> };
        expect(editor.revealRange).toHaveBeenCalledTimes(1);
        const [range, revealType] = editor.revealRange.mock.calls[0] as [vscode.Range, number];
        expect(range.start.line).toBe(2);
        expect(revealType).toBe(vscode.TextEditorRevealType.InCenter);
    });

    it("a switch with no position should not reveal or move the selection", async () => {
        const { handler } = await setup("# Title\n\nbody\n");
        await handler({ type: "switchToTextEditor" });
        const editor = await vi.mocked(vscode.window.showTextDocument).mock.results.at(-1)!
            .value as { revealRange: ReturnType<typeof vi.fn>; selection: unknown };
        expect(editor.revealRange).not.toHaveBeenCalled();
        expect(editor.selection).toBeUndefined();
    });

    it("a line past the end of the document should clamp to its last line", async () => {
        const { handler } = await setup("# Title\n");
        await handler({ type: "switchToTextEditor", line: 999, column: 0 });
        expect(shownSelection()?.start.line).toBeLessThanOrEqual(1);
    });
});
