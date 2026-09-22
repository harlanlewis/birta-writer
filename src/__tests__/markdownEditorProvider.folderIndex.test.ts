/**
 * The provider's half of the folder edge index (MAR-479): which folder a
 * document is indexed under, that one ask subscribes a panel, and that a
 * change on disk is re-sent to it. Driven through the real message handler
 * and the real `**\/*` watcher; the indexing itself is folderIndex.test.ts's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import type { FolderIndex } from "../../shared/folderIndex";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        workspaceState: { get: vi.fn(() => undefined), update: vi.fn() },
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

const findFiles = vscode.workspace.findFiles as unknown as ReturnType<typeof vi.fn>;
const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
const getWorkspaceFolder = vscode.workspace.getWorkspaceFolder as unknown as ReturnType<typeof vi.fn>;

/** The workspace on disk: path → text. */
let files: Record<string, string>;

function mountWorkspace(root: string, contents: Record<string, string>): void {
    files = contents;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    getWorkspaceFolder.mockImplementation((uri: vscode.Uri) =>
        uri.fsPath.startsWith(root + "/") ? { uri: vscode.Uri.file(root) } : undefined);
    findFiles.mockImplementation(async () => Object.keys(files).map((p) => vscode.Uri.file(p)));
    readFile.mockImplementation(async (uri: vscode.Uri) => new TextEncoder().encode(files[uri.fsPath] ?? ""));
}

async function open(path: string) {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument(files[path] ?? "", vscode.Uri.file(path));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0]![0] as (msg: Record<string, unknown>) => Promise<void>;
    return { provider, panel, handler };
}

/** Every folderIndex message the panel was sent, oldest first. */
function sent(panel: ReturnType<typeof makePanel>): Array<{ index: FolderIndex | null; self: string | null }> {
    return panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string; index: FolderIndex | null; self: string | null })
        .filter((m) => m.type === "folderIndex");
}

/** Let the handler's promise chain (walk, reads, post) settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) { await Promise.resolve(); }
    await vi.advanceTimersByTimeAsync(0);
}

/** The listeners the provider registered on its `**\/*` watcher. Chosen by its
 *  glob, not by position: opening a document creates a watcher of its own
 *  (diskDrift.ts) after the provider's. */
function watcher() {
    const mock = (vscode.workspace.createFileSystemWatcher as unknown as ReturnType<typeof vi.fn>).mock;
    const at = mock.calls.findIndex((c) => c[0] === "**/*");
    const w = mock.results[at]!.value;
    return {
        change: w.onDidChange.mock.calls[0][0] as (uri: vscode.Uri) => void,
        create: w.onDidCreate.mock.calls[0][0] as (uri: vscode.Uri) => void,
    };
}

describe("MarkdownEditorProvider: the folder index", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vscode.workspace.workspaceFolders = undefined;
        getWorkspaceFolder.mockReset();
        getWorkspaceFolder.mockImplementation(() => undefined);
    });

    it("a request should be answered with the document's folder indexed and its own place in it", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "Body.\n", "/ws/other.md": "See [[note]].\n" });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestFolderIndex" });
        await settle();
        const [msg] = sent(panel);
        expect(msg!.self).toBe("note.md");
        expect(msg!.index!.rootName).toBe("ws");
        expect(msg!.index!.edges.map((e) => [e.from, e.to])).toEqual([["other.md", "note.md"]]);
    });

    it("a document in no workspace folder should get no index, even when a workspace is open", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "" });
        files["/loose/free.md"] = "";
        const { panel, handler } = await open("/loose/free.md");
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)).toEqual([{ type: "folderIndex", index: null, self: null }]);
        expect(findFiles).not.toHaveBeenCalled();
    });

    it("a saved note should re-send the index to a panel that asked, once the burst settles", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "", "/ws/other.md": "Nothing yet.\n" });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)).toHaveLength(1);

        files["/ws/other.md"] = "Now [[note]].\n";
        watcher().change(vscode.Uri.file("/ws/other.md"));
        watcher().change(vscode.Uri.file("/ws/other.md"));
        await vi.advanceTimersByTimeAsync(749);
        expect(sent(panel)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        const all = sent(panel);
        expect(all).toHaveLength(2);
        expect(all[1]!.index!.edges.map((e) => e.from)).toEqual(["other.md"]);
    });

    it("a save that changes no reference should send nothing, and a second ask should still be answered", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "", "/ws/other.md": "See [[note]].\n" });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)).toHaveLength(1);

        // Prose changes, references do not: the rebuild is the same index.
        files["/ws/other.md"] = "See [[note]], with more words around it.\n";
        watcher().change(vscode.Uri.file("/ws/other.md"));
        await vi.advanceTimersByTimeAsync(1000);
        await settle();
        expect(sent(panel)).toHaveLength(1);

        // A page that asks again (a reload in the same panel) has nothing and must be answered.
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)).toHaveLength(2);
    });

    it("a change that is not a note, or a panel that never asked, should send nothing", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "" });
        const { panel } = await open("/ws/note.md");
        watcher().change(vscode.Uri.file("/ws/note.md"));
        watcher().change(vscode.Uri.file("/ws/image.png"));
        await vi.advanceTimersByTimeAsync(2000);
        await settle();
        expect(sent(panel)).toEqual([]);
    });

    it("a closed panel should not be re-sent anything", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "" });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestFolderIndex" });
        await settle();
        for (const call of panel.onDidDispose.mock.calls) { (call[0] as () => void)(); }
        panel.webview.postMessage.mockClear();
        watcher().create(vscode.Uri.file("/ws/new.md"));
        await vi.advanceTimersByTimeAsync(2000);
        await settle();
        expect(sent(panel)).toEqual([]);
    });
});
