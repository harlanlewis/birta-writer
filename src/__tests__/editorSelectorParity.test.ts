/**
 * The set of file extensions this editor claims must agree in three places:
 * `contributes.customEditors[].selector` in package.json (what VS Code will
 * hand to the provider at all), the link-routing regex in
 * MarkdownEditorProvider (what a clicked link opens in the WYSIWYG view
 * rather than passing to `vscode.open`), and the link-suggestion ranking in
 * shared/linkTargetSuggest.ts.
 *
 * A drift is silent in both directions. An extension in the regex but not the
 * selector sends `vscode.openWith` at a viewType that refuses the file; one in
 * the selector but not the regex opens by hand but never from a link.
 *
 * The routing checks drive the real `openFile` message handler — the message a
 * link click posts — rather than testing the regex, so what they cover is the
 * path from "the user clicked a link" to "this editor was asked to open the
 * target". They enumerate package.json rather than restating a list, and
 * assert the size enumerated: a selector array read as empty would otherwise
 * pass every check below by having nothing to check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import { rankLinkTargets } from "../../shared/linkTargetSuggest";
import { DOCUMENT_EXTENSIONS } from "../../shared/documentExtensions";

const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
) as {
    contributes: {
        customEditors: Array<{ viewType: string; selector: Array<{ filenamePattern: string }> }>;
    };
};

const editor = pkg.contributes.customEditors.find((e) => e.viewType === "birta.editor");

/** Extensions the manifest claims, lowercased, without the leading dot. */
const claimed = (editor?.selector ?? [])
    .map((s) => s.filenamePattern)
    .filter((p) => p.startsWith("*."))
    .map((p) => p.slice(2).toLowerCase());

describe("the manifest's custom-editor selector", () => {
    it("should be a real, non-empty enumeration", () => {
        expect(editor, "no birta.editor entry in contributes.customEditors").toBeDefined();
        // The manifest is the one copy of the list that cannot import the
        // shared constant, so this is where the two are held together: a
        // format added to DOCUMENT_EXTENSIONS without a selector entry never
        // reaches the provider, and one added to the selector without the
        // constant opens by hand but never from a link, a swap or a wikilink.
        expect(claimed.length).toBe(DOCUMENT_EXTENSIONS.length);
        expect([...claimed].sort()).toEqual([...DOCUMENT_EXTENSIONS].sort());
    });
});

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

const DOC_PATH = "/repo/docs/index.md";

function setWorkspace(existingFiles: string[]): void {
    const files = new Set(existingFiles.map((f) => vscode.Uri.file(f).fsPath));
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: vscode.Uri.file("/repo") },
    ];
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri: vscode.Uri) => {
        if (files.has(uri.fsPath)) return { type: vscode.FileType.File } as vscode.FileStat;
        throw new Error("ENOENT");
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue(
        existingFiles.map((f) => vscode.Uri.file(f)),
    );
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key === "smartLinks" ? true : defaultValue,
        ),
        inspect: vi.fn(() => undefined),
    } as unknown as vscode.WorkspaceConfiguration);
}

async function openLink(path: string, wiki?: true) {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("hello\n", vscode.Uri.file(DOC_PATH));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock
        .calls[0]![0] as (msg: Record<string, unknown>) => Promise<void>;
    await handler({ type: "ready" });
    await handler({ type: "openFile", path, ...(wiki ? { wiki: true } : {}) });
    return vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter((c) => c[0] === "vscode.openWith")
        .map((c) => ({ uri: c[1] as vscode.Uri, viewType: c[2] as string }));
}

describe("a clicked link to an editor document opens in this editor", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        (vscode.window.tabGroups as unknown as { all: unknown[] }).all = [];
    });

    for (const ext of claimed) {
        it(`a relative link to a .${ext} file should open with the birta viewType`, async () => {
            const target = `/repo/docs/page.${ext}`;
            setWorkspace([DOC_PATH, target]);

            const calls = await openLink(`./page.${ext}`);

            expect(calls).toHaveLength(1);
            expect(calls[0]!.uri.fsPath).toBe(vscode.Uri.file(target).fsPath);
            expect(calls[0]!.viewType).toBe("birta.editor");
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });

        it(`a wikilink to a .${ext} file should open with the birta viewType`, async () => {
            const target = `/repo/docs/Some-Page.${ext}`;
            setWorkspace([DOC_PATH, target]);

            const calls = await openLink("some-page", true);

            expect(calls).toHaveLength(1);
            expect(calls[0]!.uri.fsPath).toBe(vscode.Uri.file(target).fsPath);
            expect(calls[0]!.viewType).toBe("birta.editor");
        });
    }

    it("a link to a file this editor does not claim should not open with it", async () => {
        setWorkspace([DOC_PATH, "/repo/docs/notes.txt"]);

        const calls = await openLink("./notes.txt");

        expect(calls).toHaveLength(0);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "vscode.open",
            expect.anything(),
        );
    });

    it("a heading fragment on an .mdx link should still resolve to its line", async () => {
        setWorkspace([DOC_PATH, "/repo/docs/guide.mdx"]);
        makeFakeTextDocument(
            "import X from './x'\n\n# Guide\n\n## Set Up\n\nbody\n",
            vscode.Uri.file("/repo/docs/guide.mdx"),
        );
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument("hello\n", vscode.Uri.file(DOC_PATH));
        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            { isCancellationRequested: false } as vscode.CancellationToken,
        );
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0]![0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });
        const spy = vi.spyOn(provider, "setPendingNavigation");

        await handler({ type: "openFile", path: "./guide.mdx#set-up" });

        expect(spy).toHaveBeenCalledWith(vscode.Uri.file("/repo/docs/guide.mdx").fsPath, 5);
    });
});

describe("link suggestions rank editor documents first", () => {
    for (const ext of claimed) {
        it(`a .${ext} target should outrank a shorter plain file`, () => {
            // Both forms contain the query, so the only thing separating them
            // is the sort: path length is the next tiebreak, and without the
            // extension in the markdown set the shorter .txt would win.
            const ranked = rankLinkTargets(
                [
                    { relative: "p.txt", rootRelative: "/p.txt" },
                    { relative: `notes/p.${ext}`, rootRelative: `/notes/p.${ext}` },
                ],
                "p",
            );
            expect(ranked.map((r) => r.rootRelative)).toEqual([
                `/notes/p.${ext}`,
                "/p.txt",
            ]);
        });
    }
});
