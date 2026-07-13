/**
 * Disk-change reconciliation: the provider watches the open file on disk and
 * folds external writes (terminal tools, background sync, git) into the
 * document — reloading a clean document, three-way merging into a dirty one,
 * and flagging a toolbar conflict (instead of touching anything) when the
 * unsaved edits and the disk changed the same lines differently.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    fireDidSaveTextDocument,
} from "../../__mocks__/vscode";

import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const REVERT_COMMAND = "workbench.action.files.revert";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

/** Minimal WebviewPanel fake covering everything resolveCustomTextEditor touches */
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

function messagesOfType(panel: FakePanel, type: string): Array<Record<string, unknown>> {
    return panel.webview.postMessage.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((msg) => msg["type"] === type);
}

describe("MarkdownEditorProvider disk-change reconciliation", () => {
    /** The simulated file-on-disk content, served by fs.readFile and by the revert command. */
    let diskContent: string;
    let revertCalls: number;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
        diskContent = "";
        revertCalls = 0;
        (vscode.workspace.fs.readFile as Mock).mockImplementation(
            async () => Buffer.from(diskContent, "utf8"),
        );
        // Writes land on the simulated disk (so a later revert reloads them).
        (vscode.workspace.fs.writeFile as Mock).mockImplementation(
            async (_uri: vscode.Uri, bytes: Uint8Array) => {
                diskContent = Buffer.from(bytes).toString("utf8");
            },
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function setup(content = "line1\nline2\nline3\n", filePath = "/project/note.md") {
        diskContent = content;
        const provider = new MarkdownEditorProvider(makeContext());
        const document = makeFakeTextDocument(content, vscode.Uri.file(filePath));

        // Simulate the workbench revert command against the fake document: the
        // model reloads the disk content and comes out clean.
        (vscode.commands.executeCommand as Mock).mockImplementation(
            async (command: string) => {
                if (command === REVERT_COMMAND) {
                    revertCalls++;
                    document.markSaved();
                    if (document.getText() !== diskContent) {
                        document.setTextExternally(diskContent);
                    }
                }
            },
        );

        const panel = makePanel();
        await provider.resolveCustomTextEditor(
            document as unknown as vscode.TextDocument,
            panel as unknown as vscode.WebviewPanel,
            makeCancellation(),
        );
        const handler = panel.webview.onDidReceiveMessage.mock
            .calls[0][0] as (msg: Record<string, unknown>) => Promise<void>;
        await handler({ type: "ready" });

        // The single watcher created for this document, with its change trigger.
        const watcher = (vscode.workspace.createFileSystemWatcher as Mock).mock.results[0]
            .value as { onDidChange: Mock; onDidCreate: Mock; dispose: Mock };
        const fireDiskChange = watcher.onDidChange.mock.calls[0][0] as () => void;

        panel.webview.postMessage.mockClear();
        return { provider, document, panel, handler, watcher, fireDiskChange };
    }

    /** Fires the watcher and runs the debounce + reconciliation + push timers. */
    async function reconcile(fireDiskChange: () => void): Promise<void> {
        fireDiskChange();
        await vi.advanceTimersByTimeAsync(500);
    }

    describe("watcher lifecycle", () => {
        it("resolving a document should create a watcher scoped to that file", async () => {
            await setup("content\n", "/project/note.md");

            const pattern = (vscode.workspace.createFileSystemWatcher as Mock).mock
                .calls[0][0] as { base: string; pattern: string };
            expect(pattern.pattern).toBe("note.md");
            expect(pattern.base.replace(/\\/g, "/")).toBe("/project");
        });

        it("disposing the panel should dispose the watcher", async () => {
            const { panel, watcher } = await setup();

            panel.dispose();

            expect(watcher.dispose).toHaveBeenCalled();
        });
    });

    describe("clean document", () => {
        it("an external disk change should reload the document and push it to the webview", async () => {
            const { document, panel, fireDiskChange } = await setup("original\n");

            diskContent = "changed on disk\n";
            await reconcile(fireDiskChange);

            expect(revertCalls).toBe(1);
            expect(document.getText()).toBe("changed on disk\n");
            expect(document.isDirty).toBe(false);
            const pushes = messagesOfType(panel, "externalUpdate");
            expect(pushes.length).toBeGreaterThanOrEqual(1);
            expect(pushes[pushes.length - 1]["content"]).toBe("changed on disk\n");
        });

        it("a watcher echo of the document's own save should not revert anything", async () => {
            const { fireDiskChange, panel } = await setup("saved content\n");

            // Disk already equals the model (e.g. the user just saved).
            await reconcile(fireDiskChange);

            expect(revertCalls).toBe(0);
            expect(messagesOfType(panel, "externalUpdate")).toHaveLength(0);
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });
    });

    describe("dirty document, mergeable disk change", () => {
        it("non-overlapping edits should merge: the user's edit AND the disk edit both land", async () => {
            const { document, panel, handler, fireDiskChange } = await setup(
                "line1\nline2\nline3\n",
            );
            // The user edits line1 in the webview (document goes dirty)…
            await handler({ type: "update", content: "line1 EDITED\nline2\nline3\n", baseSyncVersion: 0 });
            expect(document.isDirty).toBe(true);

            // …meanwhile a terminal tool rewrites line3 on disk.
            diskContent = "line1\nline2\nline3 DISK\n";
            await reconcile(fireDiskChange);

            expect(document.getText()).toBe("line1 EDITED\nline2\nline3 DISK\n");
            // The user's edit is still unsaved — the merge must keep it dirty.
            expect(document.isDirty).toBe(true);
            expect(revertCalls).toBe(1);
            const pushes = messagesOfType(panel, "externalUpdate");
            expect(pushes.length).toBeGreaterThanOrEqual(1);
            expect(pushes[pushes.length - 1]["content"]).toBe("line1 EDITED\nline2\nline3 DISK\n");
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });

        it("an external write that exactly matches the dirty model should re-anchor it as clean", async () => {
            const { document, handler, fireDiskChange } = await setup("line1\nline2\n");
            await handler({ type: "update", content: "line1 SAME\nline2\n", baseSyncVersion: 0 });
            expect(document.isDirty).toBe(true);

            // An external tool writes exactly what the editor already contains.
            diskContent = "line1 SAME\nline2\n";
            await reconcile(fireDiskChange);

            expect(revertCalls).toBe(1);
            expect(document.isDirty).toBe(false);
            expect(document.getText()).toBe("line1 SAME\nline2\n");
        });

        it("a touch event (disk content unchanged) should do nothing to a dirty document", async () => {
            const { document, handler, fireDiskChange, panel } = await setup("line1\nline2\n");
            await handler({ type: "update", content: "line1 EDITED\nline2\n", baseSyncVersion: 0 });
            panel.webview.postMessage.mockClear();

            // Watcher fires but the bytes are still the original base.
            await reconcile(fireDiskChange);

            expect(revertCalls).toBe(0);
            expect(document.getText()).toBe("line1 EDITED\nline2\n");
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });
    });

    describe("dirty document, conflicting disk change", () => {
        async function setupConflict() {
            const ctx = await setup("line1\nline2\nline3\n");
            // The user and the disk both rewrite line2, differently.
            await ctx.handler({ type: "update", content: "line1\nline2 MINE\nline3\n", baseSyncVersion: 0 });
            ctx.panel.webview.postMessage.mockClear();
            diskContent = "line1\nline2 DISK\nline3\n";
            await reconcile(ctx.fireDiskChange);
            return ctx;
        }

        it("should leave the document untouched and flag the conflict to the webview", async () => {
            const { document, panel } = await setupConflict();

            expect(revertCalls).toBe(0);
            expect(document.getText()).toBe("line1\nline2 MINE\nline3\n");
            expect(document.isDirty).toBe(true);
            const flags = messagesOfType(panel, "syncConflict");
            expect(flags).toHaveLength(1);
            expect(flags[0]["state"]).toBe("conflict");
        });

        it("should not re-notify for a second conflicting change while already flagged", async () => {
            const { panel, fireDiskChange } = await setupConflict();
            panel.webview.postMessage.mockClear();

            diskContent = "line1\nline2 DISK AGAIN\nline3\n";
            await reconcile(fireDiskChange);

            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });

        it("a later disk change that converges with the editor should clear the conflict", async () => {
            const { document, panel, fireDiskChange } = await setupConflict();
            panel.webview.postMessage.mockClear();

            // The external tool ends up writing exactly the editor's content.
            diskContent = "line1\nline2 MINE\nline3\n";
            await reconcile(fireDiskChange);

            expect(document.isDirty).toBe(false);
            const flags = messagesOfType(panel, "syncConflict");
            expect(flags).toHaveLength(1);
            expect(flags[0]["state"]).toBe("none");
        });

        it("saving the document should clear the conflict and re-anchor the merge base", async () => {
            const { document, panel } = await setupConflict();
            panel.webview.postMessage.mockClear();

            // The user saves through VS Code's native conflict dialog
            // ("Overwrite"): the model is written to disk as-is.
            document.markSaved();
            diskContent = document.getText();
            fireDidSaveTextDocument(document);

            const flags = messagesOfType(panel, "syncConflict");
            expect(flags).toHaveLength(1);
            expect(flags[0]["state"]).toBe("none");
        });

        it("a rebuilt webview (ready) should re-learn the still-active conflict", async () => {
            const { panel, handler } = await setupConflict();
            panel.webview.postMessage.mockClear();

            await handler({ type: "ready" });

            const flags = messagesOfType(panel, "syncConflict");
            expect(flags).toHaveLength(1);
            expect(flags[0]["state"]).toBe("conflict");
        });
    });

    describe("conflict resolution picker", () => {
        async function setupConflictWithPick(action: "compare" | "keepMine" | "takeDisk" | null) {
            const ctx = await setup("line1\nline2\nline3\n");
            await ctx.handler({ type: "update", content: "line1\nline2 MINE\nline3\n", baseSyncVersion: 0 });
            diskContent = "line1\nline2 DISK\nline3\n";
            await reconcile(ctx.fireDiskChange);
            ctx.panel.webview.postMessage.mockClear();
            (vscode.window.showQuickPick as Mock).mockImplementation(
                async (items: Array<{ action: string }>) =>
                    action === null ? undefined : items.find((i) => i.action === action),
            );
            return ctx;
        }

        it("'keep your version' should overwrite the disk and end up clean on the editor content", async () => {
            const { document, panel, handler } = await setupConflictWithPick("keepMine");

            await handler({ type: "resolveSyncConflict" });
            await vi.advanceTimersByTimeAsync(500);

            expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
            const [, bytes] = (vscode.workspace.fs.writeFile as Mock).mock.calls[0];
            // The overwrite happens BEFORE the revert reloads, so assert the payload.
            expect(Buffer.from(bytes as Uint8Array).toString("utf8")).toBe("line1\nline2 MINE\nline3\n");
            const flags = messagesOfType(panel, "syncConflict");
            expect(flags.map((f) => f["state"])).toEqual(["none"]);
            expect(document.getText()).toBe("line1\nline2 MINE\nline3\n");
        });

        it("'reload from disk' should discard the editor content for the disk content", async () => {
            const { document, panel, handler } = await setupConflictWithPick("takeDisk");

            await handler({ type: "resolveSyncConflict" });
            await vi.advanceTimersByTimeAsync(500);

            expect(revertCalls).toBe(1);
            expect(document.getText()).toBe("line1\nline2 DISK\nline3\n");
            expect(document.isDirty).toBe(false);
            const flags = messagesOfType(panel, "syncConflict");
            expect(flags.map((f) => f["state"])).toEqual(["none"]);
        });

        it("'compare' should open the built-in diff and keep the conflict flagged", async () => {
            const { handler, panel, document } = await setupConflictWithPick("compare");

            await handler({ type: "resolveSyncConflict" });
            await vi.advanceTimersByTimeAsync(500);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                "workbench.files.action.compareWithSaved",
                document.uri,
            );
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
            expect(document.getText()).toBe("line1\nline2 MINE\nline3\n");
        });

        it("dismissing the picker should change nothing", async () => {
            const { handler, panel, document } = await setupConflictWithPick(null);

            await handler({ type: "resolveSyncConflict" });
            await vi.advanceTimersByTimeAsync(500);

            expect(revertCalls).toBe(0);
            expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
            expect(document.getText()).toBe("line1\nline2 MINE\nline3\n");
        });
    });

    describe("interplay with webview edits", () => {
        it("a webview edit racing a disk merge should be rejected as stale and re-based", async () => {
            const { document, panel, handler, fireDiskChange } = await setup(
                "line1\nline2\nline3\n",
            );
            await handler({ type: "update", content: "line1 EDITED\nline2\nline3\n", baseSyncVersion: 0 });

            diskContent = "line1\nline2\nline3 DISK\n";
            await reconcile(fireDiskChange);
            const merged = "line1 EDITED\nline2\nline3 DISK\n";
            expect(document.getText()).toBe(merged);

            // The webview posts an edit still based on version 0 (pre-merge).
            panel.webview.postMessage.mockClear();
            await handler({ type: "update", content: "line1 EDITED MORE\nline2\nline3\n", baseSyncVersion: 0 });
            await vi.advanceTimersByTimeAsync(500);

            // Rejected: the document keeps the merged state, and the current
            // content is re-pushed for the webview to re-base on.
            expect(document.getText()).toBe(merged);
            const pushes = messagesOfType(panel, "externalUpdate");
            expect(pushes.length).toBeGreaterThanOrEqual(1);
            expect(pushes[pushes.length - 1]["content"]).toBe(merged);
        });
    });
});
