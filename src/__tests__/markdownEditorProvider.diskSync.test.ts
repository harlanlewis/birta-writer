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

        it("a touch event (disk content unchanged) should refresh the stat but keep the edits dirty", async () => {
            // An mtime-only touch leaves the model's disk stat stale, which
            // alone is enough to trigger the native conflict dialog on the
            // next save — so it must reconcile like any other event: revert
            // (fresh stat) and reapply the user's edits.
            const { document, handler, fireDiskChange, panel } = await setup("line1\nline2\n");
            await handler({ type: "update", content: "line1 EDITED\nline2\n", baseSyncVersion: 0 });
            panel.webview.postMessage.mockClear();

            // Watcher fires but the bytes are still the original base.
            await reconcile(fireDiskChange);

            expect(revertCalls).toBe(1);
            expect(document.getText()).toBe("line1 EDITED\nline2\n");
            expect(document.isDirty).toBe(true);
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });

        it("a hot-exit-restored dirty document should merge against the DISK as base, not its own text", async () => {
            // Regression guard for the seeding race: the base for a document
            // restored dirty (hot exit) is the disk content, seeded through
            // the edit queue BEFORE any reconcile can run. Were the base to
            // fall back to the document's own text, the merge would resolve
            // to "take disk" and silently discard the restored edits.
            diskContent = "line1\nline2\nline3\n";
            const provider = new MarkdownEditorProvider(makeContext());
            const document = makeFakeTextDocument("line1 RESTORED\nline2\nline3\n", vscode.Uri.file("/project/hot.md"));
            document.markDirty();
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
            const watcher = (vscode.workspace.createFileSystemWatcher as Mock).mock.results[0]
                .value as { onDidChange: Mock };
            const fireDiskChange = watcher.onDidChange.mock.calls[0][0] as () => void;

            // An external tool edits line3 on disk while the restored edit
            // to line1 is still unsaved.
            diskContent = "line1\nline2\nline3 DISK\n";
            await reconcile(fireDiskChange);

            expect(document.getText()).toBe("line1 RESTORED\nline2\nline3 DISK\n");
            expect(document.isDirty).toBe(true);
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

    describe("edge cases", () => {
        it("a deleted file (read fails) should be left to VS Code's orphaned-file handling", async () => {
            const { document, panel, handler, fireDiskChange } = await setup("line1\nline2\n");
            await handler({ type: "update", content: "line1 EDITED\nline2\n", baseSyncVersion: 0 });
            panel.webview.postMessage.mockClear();

            // The file is deleted out from under the editor.
            (vscode.workspace.fs.readFile as Mock).mockRejectedValueOnce(
                new Error("ENOENT"),
            );
            await reconcile(fireDiskChange);

            expect(revertCalls).toBe(0);
            expect(document.getText()).toBe("line1 EDITED\nline2\n");
            expect(document.isDirty).toBe(true);
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });

        it("the disk moving AGAIN between read and revert should re-merge against what actually loaded", async () => {
            const { document, panel, handler, fireDiskChange } = await setup(
                "line1\nline2\nline3\n",
            );
            await handler({ type: "update", content: "line1 MINE\nline2\nline3\n", baseSyncVersion: 0 });
            panel.webview.postMessage.mockClear();

            // First read sees a line3 edit; but by the time the revert lands,
            // the disk has moved on to also carry a line2 edit. The re-merge
            // must fold in the newer disk state, not the stale first read.
            diskContent = "line1\nline2\nline3 DISK1\n";
            let revertsSeen = 0;
            (vscode.commands.executeCommand as Mock).mockImplementation(
                async (command: string) => {
                    if (command !== REVERT_COMMAND) { return; } // e.g. keepEditor
                    revertCalls++;
                    if (revertsSeen++ === 0) {
                        diskContent = "line1\nline2 DISK2\nline3 DISK1\n"; // moved again
                    }
                    document.markSaved();
                    if (document.getText() !== diskContent) {
                        document.setTextExternally(diskContent);
                    }
                },
            );
            await reconcile(fireDiskChange);

            expect(document.getText()).toBe("line1 MINE\nline2 DISK2\nline3 DISK1\n");
            expect(document.isDirty).toBe(true);
            expect(messagesOfType(panel, "syncConflict")).toHaveLength(0);
        });

        it("the disk moving into a CONFLICT between read and revert should restore the edits and flag it", async () => {
            const { document, panel, handler, fireDiskChange } = await setup(
                "line1\nline2\nline3\n",
            );
            await handler({ type: "update", content: "line1\nline2 MINE\nline3\n", baseSyncVersion: 0 });
            panel.webview.postMessage.mockClear();

            // First read is cleanly mergeable (line3 edit); but the revert
            // loads a disk that now also rewrites line2 — colliding with the
            // user's unsaved line2 edit. The retry merge conflicts, so the
            // user's content is restored and the conflict flagged.
            diskContent = "line1\nline2\nline3 DISK1\n";
            let revertsSeen = 0;
            (vscode.commands.executeCommand as Mock).mockImplementation(
                async (command: string) => {
                    if (command !== REVERT_COMMAND) { return; } // e.g. keepEditor
                    revertCalls++;
                    if (revertsSeen++ === 0) {
                        diskContent = "line1\nline2 DISK2\nline3 DISK1\n"; // collides with MINE
                    }
                    document.markSaved();
                    if (document.getText() !== diskContent) {
                        document.setTextExternally(diskContent);
                    }
                },
            );
            await reconcile(fireDiskChange);

            expect(document.getText()).toBe("line1\nline2 MINE\nline3\n");
            expect(document.isDirty).toBe(true);
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

        it("a reconcile enqueued while the picker is open must not interleave with the resolution", async () => {
            // The scenario the whole feature targets: an external tool writes
            // the file again while the user is deciding how to resolve. The
            // mutation must serialize on the edit queue AFTER the reconcile,
            // never race its revert+reapply — otherwise the final content is
            // indeterminate.
            const { document, handler, fireDiskChange } = await setupConflictWithPick("takeDisk");

            // A fresh external write lands and its watcher event is queued
            // BEFORE the user's pick executes.
            diskContent = "line1\nline2 DISK NEWER\nline3\n";
            fireDiskChange();
            await handler({ type: "resolveSyncConflict" });
            await vi.advanceTimersByTimeAsync(500);

            // "Reload from disk" wins deterministically on the latest bytes;
            // the document is exactly the disk content, clean, no partial state.
            expect(document.getText()).toBe("line1\nline2 DISK NEWER\nline3\n");
            expect(document.isDirty).toBe(false);
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
