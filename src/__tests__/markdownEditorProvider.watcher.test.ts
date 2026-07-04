import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

const mockFs = vscode.workspace.fs as unknown as {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
};
const mockCreateWatcher =
    vscode.workspace.createFileSystemWatcher as unknown as ReturnType<typeof vi.fn>;

import { MarkdownDocument } from "../../src/MarkdownDocument";
import { MarkdownEditorProvider } from "../../src/MarkdownEditorProvider";

interface FakeWatcher {
    onDidChange: ReturnType<typeof vi.fn>;
    onDidCreate: ReturnType<typeof vi.fn>;
    onDidDelete: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
}

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

/** Minimal WebviewPanel fake covering everything resolveCustomEditor touches */
const makePanel = () => {
    const disposeHandlers: Array<() => void> = [];
    return {
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
        onDidDispose: vi.fn((cb: () => void) => {
            disposeHandlers.push(cb);
            return { dispose: vi.fn() };
        }),
        onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(() => {
            disposeHandlers.forEach((cb) => cb());
        }),
    };
};
type FakePanel = ReturnType<typeof makePanel>;

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

describe("MarkdownEditorProvider file watcher", () => {
    let watchers: FakeWatcher[];

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        watchers = [];
        mockCreateWatcher.mockImplementation(() => {
            const watcher: FakeWatcher = {
                onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
                onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
                onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
                dispose: vi.fn(),
            };
            watchers.push(watcher);
            return watcher;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function setup(content = "initial content", filePath = "/project/note.md") {
        mockFs.readFile.mockResolvedValue(Buffer.from(content, "utf-8"));
        const provider = new MarkdownEditorProvider(makeContext());
        const document = await MarkdownDocument.create(vscode.Uri.file(filePath));
        const panel = makePanel();
        await provider.resolveCustomEditor(
            document,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        return { provider, document, panel, watcher: watchers[0] };
    }

    /** Fires the watcher's registered onDidChange handler (as VS Code would on a file event) */
    const fireChange = (watcher: FakeWatcher, filePath = "/project/note.md") => {
        const handler = watcher.onDidChange.mock.calls[0][0] as (uri: vscode.Uri) => void;
        handler(vscode.Uri.file(filePath));
    };

    /** Extracts revert messages from all postMessage calls */
    const revertMessages = (panel: FakePanel) =>
        panel.webview.postMessage.mock.calls
            .map(([msg]) => msg as { type: string; content?: string })
            .filter((msg) => msg.type === "revert");

    describe("watcher creation", () => {
        it("resolving a file-scheme editor should create a directory-wide watcher via RelativePattern", async () => {
            const { watcher } = await setup();

            expect(mockCreateWatcher).toHaveBeenCalledOnce();
            const pattern = mockCreateWatcher.mock.calls[0][0] as vscode.RelativePattern;
            expect(pattern).toBeInstanceOf(vscode.RelativePattern);
            // "*" rather than the file's basename: the pattern is a glob, so a basename
            // containing glob metacharacters (e.g. "notes [draft].md") would never match
            // itself. The handlers filter events down to this document by fsPath instead.
            expect(pattern.pattern).toBe("*");
            expect(pattern.baseUri?.fsPath).toBe(vscode.Uri.file("/project").fsPath);
            // Both plain changes and atomic-write recreations must be handled
            expect(watcher.onDidChange).toHaveBeenCalledOnce();
            expect(watcher.onDidCreate).toHaveBeenCalledOnce();
        });

        it("a file outside the workspace folders should still get a watcher based on its own directory", async () => {
            // The mock has no workspaceFolders, so every file is a non-workspace file
            expect(vscode.workspace.workspaceFolders).toBeUndefined();
            await setup();

            const pattern = mockCreateWatcher.mock.calls[0][0] as vscode.RelativePattern;
            expect(pattern.baseUri?.fsPath).toBe(vscode.Uri.file("/project").fsPath);
        });

        it("a non-file scheme document should not create a watcher", async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from("", "utf-8"));
            const provider = new MarkdownEditorProvider(makeContext());
            const document = await MarkdownDocument.create(
                vscode.Uri.parse("untitled:Untitled-1"),
            );
            const panel = makePanel();
            await provider.resolveCustomEditor(
                document,
                panel as unknown as vscode.WebviewPanel,
                makeCancellation(),
            );

            expect(mockCreateWatcher).not.toHaveBeenCalled();
        });
    });

    describe("external change handling", () => {
        it("an external file change should revert the document and push the new content to the webview", async () => {
            const { document, panel, watcher } = await setup("old content");
            mockFs.readFile.mockResolvedValue(
                Buffer.from("changed externally", "utf-8"),
            );

            fireChange(watcher);
            await vi.advanceTimersByTimeAsync(200);

            expect(document.getText()).toBe("changed externally");
            const reverts = revertMessages(panel);
            expect(reverts).toHaveLength(1);
            expect(reverts[0].content).toBe("changed externally");
        });

        it("a change event for a different file in the same directory should be ignored", async () => {
            const { panel, watcher } = await setup("old content");
            mockFs.readFile.mockClear();
            mockFs.readFile.mockResolvedValue(Buffer.from("sibling", "utf-8"));

            fireChange(watcher, "/project/other.md");
            await vi.advanceTimersByTimeAsync(200);

            expect(mockFs.readFile).not.toHaveBeenCalled();
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("a file whose name contains glob metacharacters should still receive change events", async () => {
            // Regression: a RelativePattern of the basename itself is a glob, so
            // "notes [draft].md" never matched its own watcher pattern and external
            // changes were silently dropped. The "*" pattern + fsPath filter fixes this.
            const { document, panel, watcher } = await setup(
                "old content",
                "/project/notes [draft].md",
            );
            mockFs.readFile.mockResolvedValue(Buffer.from("changed externally", "utf-8"));

            fireChange(watcher, "/project/notes [draft].md");
            await vi.advanceTimersByTimeAsync(200);

            expect(document.getText()).toBe("changed externally");
            const reverts = revertMessages(panel);
            expect(reverts).toHaveLength(1);
            expect(reverts[0].content).toBe("changed externally");
        });

        it("multiple rapid change events should be debounced into a single revert", async () => {
            const { panel, watcher } = await setup("old content");
            mockFs.readFile.mockClear();
            mockFs.readFile.mockResolvedValue(Buffer.from("new", "utf-8"));

            fireChange(watcher);
            fireChange(watcher);
            fireChange(watcher);
            await vi.advanceTimersByTimeAsync(200);

            expect(mockFs.readFile).toHaveBeenCalledTimes(1);
            expect(revertMessages(panel)).toHaveLength(1);
        });
    });

    describe("self-write suppression", () => {
        it("a change event within 1.5s of our own save should not trigger a revert", async () => {
            const { provider, document, panel, watcher } = await setup("content");
            mockFs.writeFile.mockResolvedValue(undefined);
            await provider.saveCustomDocument(document, makeCancellation());
            mockFs.readFile.mockClear();
            panel.webview.postMessage.mockClear();

            fireChange(watcher);
            await vi.advanceTimersByTimeAsync(200);

            expect(mockFs.readFile).not.toHaveBeenCalled();
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("a manual save whose write outlives the suppression window should still suppress the following event", async () => {
            // Regression: _lastSaveTimes used to be stamped BEFORE `await document.save()`,
            // so a slow write (e.g. remote FS) could finish outside the 1.5s window and the
            // watcher event for our own save triggered a spurious self-revert.
            const { provider, document, panel, watcher } = await setup("content");
            let resolveWrite!: () => void;
            mockFs.writeFile.mockImplementation(
                () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
            );
            const savePromise = provider.saveCustomDocument(document, makeCancellation());
            // The write itself takes longer than the 1.5s suppression window
            await vi.advanceTimersByTimeAsync(2000);
            resolveWrite();
            await savePromise;
            mockFs.readFile.mockClear();
            panel.webview.postMessage.mockClear();

            fireChange(watcher);
            await vi.advanceTimersByTimeAsync(200);

            expect(mockFs.readFile).not.toHaveBeenCalled();
            expect(revertMessages(panel)).toHaveLength(0);
        });

        it("a change event after the 1.5s suppression window should trigger a revert", async () => {
            const { provider, document, panel, watcher } = await setup("content");
            mockFs.writeFile.mockResolvedValue(undefined);
            await provider.saveCustomDocument(document, makeCancellation());
            panel.webview.postMessage.mockClear();
            mockFs.readFile.mockResolvedValue(
                Buffer.from("changed after save window", "utf-8"),
            );

            // Move past the 1.5s suppression window, then fire the event
            await vi.advanceTimersByTimeAsync(1600);
            fireChange(watcher);
            await vi.advanceTimersByTimeAsync(200);

            const reverts = revertMessages(panel);
            expect(reverts).toHaveLength(1);
            expect(reverts[0].content).toBe("changed after save window");
        });
    });

    describe("disposal", () => {
        it("disposing the webview panel should dispose the watcher", async () => {
            const { panel, watcher } = await setup();

            panel.dispose();

            expect(watcher.dispose).toHaveBeenCalledOnce();
        });

        it("a pending debounced event should not fire after the panel is disposed", async () => {
            const { panel, watcher } = await setup("content");
            mockFs.readFile.mockClear();

            fireChange(watcher);
            panel.dispose();
            await vi.advanceTimersByTimeAsync(500);

            expect(mockFs.readFile).not.toHaveBeenCalled();
            expect(revertMessages(panel)).toHaveLength(0);
        });
    });
});
