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
const getConfiguration = vi.mocked(vscode.workspace.getConfiguration);
const defaultConfiguration = getConfiguration.getMockImplementation()!;

/** `birta.folderGraph`, which the mock otherwise reads at its code default (off). */
let folderGraphOn = true;
function stubSettings(): void {
    getConfiguration.mockImplementation(() => ({
        get: vi.fn((key: string, defaultValue?: unknown) => (key === "folderGraph" ? folderGraphOn : defaultValue)),
        inspect: vi.fn(() => undefined),
        update: vi.fn(async () => undefined),
    }) as never);
}

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
        // A getter: the change handler exists only once a panel has subscribed.
        get change() { return w.onDidChange.mock.calls[0][0] as (uri: vscode.Uri) => void; },
        create: w.onDidCreate.mock.calls[0][0] as (uri: vscode.Uri) => void,
        /** How many change handlers the provider has registered: none until a panel subscribes. */
        changeHandlers: w.onDidChange.mock.calls.length as number,
    };
}

describe("MarkdownEditorProvider: the folder index", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
        folderGraphOn = true;
        stubSettings();
    });
    afterEach(() => {
        vi.useRealTimers();
        vscode.workspace.workspaceFolders = undefined;
        getWorkspaceFolder.mockReset();
        getWorkspaceFolder.mockImplementation(() => undefined);
        getConfiguration.mockImplementation(defaultConfiguration);
    });

    it("with birta.folderGraph off, an ask should be answered empty: no walk, no read, no subscription, no change handler", async () => {
        folderGraphOn = false;
        mountWorkspace("/ws", { "/ws/note.md": "", "/ws/other.md": "See [[note]].\n" });
        const { panel, handler } = await open("/ws/note.md");
        // The page reads the setting off its boot blob, so a blob that drops
        // the key is a setting that can never be turned on.
        expect(panel.webview.html).toContain('"folderGraph":false');
        expect(watcher().changeHandlers).toBe(0);
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)).toEqual([{ type: "folderIndex", index: null, self: null }]);
        expect(findFiles).not.toHaveBeenCalled();
        expect(readFile).not.toHaveBeenCalled();
        expect(watcher().changeHandlers).toBe(0);
        // Nor is it re-sent anything when the folder changes.
        watcher().create(vscode.Uri.file("/ws/new.md"));
        await vi.advanceTimersByTimeAsync(2000);
        await settle();
        expect(sent(panel)).toHaveLength(1);
        expect(findFiles).not.toHaveBeenCalled();
    });

    it("the setting going off under a subscriber should answer it empty once, drop it, and walk nothing more", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "", "/ws/other.md": "See [[note]].\n" });
        const { provider, panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)).toHaveLength(1);
        const walks = findFiles.mock.calls.length;

        folderGraphOn = false;
        provider.folderGraphChanged();
        await settle();
        const posted = panel.webview.postMessage.mock.calls.map((c) => c[0] as { type: string; enabled?: boolean });
        expect(posted.filter((m) => m.type === "setFolderGraph")).toEqual([{ type: "setFolderGraph", enabled: false }]);
        expect(sent(panel)).toHaveLength(2);
        expect(sent(panel)[1]).toEqual({ type: "folderIndex", index: null, self: null });

        // A later change under the folder reaches no subscriber and walks nothing.
        files["/ws/new.md"] = "";
        watcher().create(vscode.Uri.file("/ws/new.md"));
        await vi.advanceTimersByTimeAsync(2000);
        await settle();
        expect(sent(panel)).toHaveLength(2);
        expect(findFiles.mock.calls.length).toBe(walks);
    });

    it("the setting going on should tell every open page, and a page that then asks should be indexed", async () => {
        folderGraphOn = false;
        mountWorkspace("/ws", { "/ws/note.md": "", "/ws/other.md": "See [[note]].\n" });
        const { provider, panel, handler } = await open("/ws/note.md");
        folderGraphOn = true;
        provider.folderGraphChanged();
        const posted = panel.webview.postMessage.mock.calls.map((c) => c[0] as { type: string; enabled?: boolean });
        expect(posted.filter((m) => m.type === "setFolderGraph")).toEqual([{ type: "setFolderGraph", enabled: true }]);
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(sent(panel)[0]!.index!.edges).toHaveLength(1);
    });

    it("the change handler should be registered by the first ask, once, and not at activation", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "", "/ws/other.md": "" });
        const { handler } = await open("/ws/note.md");
        expect(watcher().changeHandlers).toBe(0);
        await handler({ type: "requestFolderIndex" });
        await settle();
        expect(watcher().changeHandlers).toBe(1);
        const second = await open("/ws/other.md");
        await second.handler({ type: "requestFolderIndex" });
        await settle();
        expect(watcher().changeHandlers).toBe(1);
    });

    it("a request should be answered with the document's folder indexed and its own place in it", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "Body.\n", "/ws/other.md": "See [[note]].\n" });
        const { panel, handler } = await open("/ws/note.md");
        expect(panel.webview.html).toContain('"folderGraph":true');
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

    it("a change that is not a note, or one that changes no reference, should send nothing; a panel that never asked has no change handler to receive", async () => {
        mountWorkspace("/ws", { "/ws/note.md": "" });
        const { panel, handler } = await open("/ws/note.md");
        expect(watcher().changeHandlers).toBe(0);
        await handler({ type: "requestFolderIndex" });
        await settle();
        panel.webview.postMessage.mockClear();
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
