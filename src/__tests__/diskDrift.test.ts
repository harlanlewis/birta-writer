/**
 * DiskDriftController (src/diskDrift.ts): notify-only detection of external disk
 * edits. The load-bearing guarantee is that it NEVER mutates the document —
 * drift is flagged for the webview badge, and the only writes/reverts happen on
 * an explicit user pick. These tests assert both the detection logic and,
 * critically, the absence of any automatic revert/write.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    fireDidChangeTextDocument,
    fireDidSaveTextDocument,
} from "../../__mocks__/vscode";
import { DiskDriftController } from "../diskDrift";

const REVERT = "workbench.action.files.revert";
const COMPARE = "workbench.files.action.compareWithSaved";

describe("DiskDriftController — notify-only disk drift", () => {
    /** The simulated on-disk content served by fs.readFile. */
    let diskContent: string;
    /** Drift transitions the controller reported, in order. */
    let transitions: Array<{ uriKey: string; drifted: boolean }>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        vi.useFakeTimers();
        diskContent = "";
        transitions = [];
        (vscode.workspace.fs.readFile as Mock).mockImplementation(
            async () => Buffer.from(diskContent, "utf8"),
        );
        (vscode.commands.executeCommand as Mock).mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function setup(content = "line1\nline2\n", filePath = "/project/note.md") {
        diskContent = content;
        const document = makeFakeTextDocument(content, vscode.Uri.file(filePath));
        const uriKey = document.uri.toString();
        const controller = new DiskDriftController({
            onDriftChange: (key, drifted) => transitions.push({ uriKey: key, drifted }),
        });
        const tracking = controller.track(document as unknown as vscode.TextDocument, uriKey);
        // The single watcher created for this document, with its change trigger.
        const watcher = (vscode.workspace.createFileSystemWatcher as Mock).mock.results[0]
            .value as { onDidChange: Mock; onDidCreate: Mock };
        const fireDiskChange = watcher.onDidChange.mock.calls[0][0] as () => void;
        return { controller, document, uriKey, tracking, fireDiskChange };
    }

    /** Dirty the document in-editor (routes through the fake applyEdit → applyReplace). */
    async function dirtyEdit(document: ReturnType<typeof makeFakeTextDocument>, insertAt: number, text: string) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(insertAt), document.positionAt(insertAt)), text);
        await vscode.workspace.applyEdit(edit);
        expect(document.isDirty).toBe(true);
    }

    /** Fire the debounced watcher and let the async evaluate settle. */
    async function triggerDiskChange(fire: () => void) {
        fire();
        await vi.advanceTimersByTimeAsync(200);
    }

    it("a disk change while the document is dirty and differs should flag drift", async () => {
        const { document, uriKey, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = "line1 DISK\nline2\n"; // external write, differs from the dirty editor

        await triggerDiskChange(fireDiskChange);

        expect(transitions).toEqual([{ uriKey, drifted: true }]);
    });

    it("a disk change while the document is CLEAN should not flag drift (VS Code auto-reloads it)", async () => {
        const { fireDiskChange } = setup();
        diskContent = "line1 DISK\nline2\n"; // document stays clean

        await triggerDiskChange(fireDiskChange);

        expect(transitions).toEqual([]);
    });

    it("a disk change that converges with the editor content should not flag drift", async () => {
        const { document, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = document.getText(); // disk now equals the dirty editor content

        await triggerDiskChange(fireDiskChange);

        expect(transitions).toEqual([]);
    });

    it("saving the document clears an existing drift", async () => {
        const { document, uriKey, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = "line1 DISK\nline2\n";
        await triggerDiskChange(fireDiskChange);
        expect(transitions).toEqual([{ uriKey, drifted: true }]);

        fireDidSaveTextDocument(document);

        expect(transitions).toEqual([
            { uriKey, drifted: true },
            { uriKey, drifted: false },
        ]);
    });

    it("the document becoming clean (reload/undo) clears an existing drift", async () => {
        const { document, uriKey, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = "line1 DISK\nline2\n";
        await triggerDiskChange(fireDiskChange);

        // Simulate a reload/revert: the model goes clean and a change fires.
        await document.save(); // clears isDirty in the fake
        fireDidChangeTextDocument({
            document,
            contentChanges: [],
            reason: undefined,
        });

        expect(transitions[transitions.length - 1]).toEqual({ uriKey, drifted: false });
    });

    it("repeated disk changes while drifted report the transition only once", async () => {
        const { document, uriKey, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = "line1 DISK\nline2\n";

        await triggerDiskChange(fireDiskChange);
        diskContent = "line1 DISK AGAIN\nline2\n";
        await triggerDiskChange(fireDiskChange);

        expect(transitions).toEqual([{ uriKey, drifted: true }]); // one transition, not two
    });

    it("detection NEVER reverts the document or writes to disk automatically", async () => {
        const { document, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = "line1 DISK\nline2\n";

        await triggerDiskChange(fireDiskChange);

        expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(REVERT, expect.anything());
        expect(document.getText()).toContain("MINE"); // the editor content is untouched
    });

    describe("resolveDriftInteractively — user-driven only", () => {
        function pick(action: "reload" | "compare" | null) {
            (vscode.window.showQuickPick as Mock).mockImplementation(
                async (items: Array<{ action: string }>) =>
                    action === null ? undefined : items.find((i) => i.action === action),
            );
        }

        it("'reload from disk' runs the revert command on the document", async () => {
            const { controller, document } = setup();
            pick("reload");
            await controller.resolveDriftInteractively(document as unknown as vscode.TextDocument);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(REVERT, document.uri);
            expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        });

        it("'compare' opens the built-in dirty-vs-disk diff", async () => {
            const { controller, document } = setup();
            pick("compare");
            await controller.resolveDriftInteractively(document as unknown as vscode.TextDocument);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(COMPARE, document.uri);
        });

        it("dismissing the picker does nothing", async () => {
            const { controller, document } = setup();
            pick(null);
            await controller.resolveDriftInteractively(document as unknown as vscode.TextDocument);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
            expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        });
    });

    it("track() flags drift immediately when a dirty document already differs from disk (no watcher event)", async () => {
        // The hot-exit-restore / reopen-after-switch-away shape: the document
        // comes back dirty and the file already changed, with no watcher event
        // to catch it. track() must evaluate once on its own.
        diskContent = "line1\nline2\n";
        const document = makeFakeTextDocument(diskContent, vscode.Uri.file("/project/note.md"));
        const uriKey = document.uri.toString();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(0)), "MINE ");
        await vscode.workspace.applyEdit(edit);
        expect(document.isDirty).toBe(true);
        diskContent = "line1 DISK\nline2\n"; // disk already diverged before tracking

        const controller = new DiskDriftController({
            onDriftChange: (key, drifted) => transitions.push({ uriKey: key, drifted }),
        });
        controller.track(document as unknown as vscode.TextDocument, uriKey);
        await vi.advanceTimersByTimeAsync(0); // let the initial async evaluate settle

        expect(transitions).toEqual([{ uriKey, drifted: true }]);
    });

    it("track() on a clean document reads no disk (cheap mount path)", async () => {
        setup(); // clean document
        await vi.advanceTimersByTimeAsync(0);
        expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it("dispose stops watching and clears drift", async () => {
        const { document, uriKey, tracking, fireDiskChange } = setup();
        await dirtyEdit(document, 0, "MINE ");
        diskContent = "line1 DISK\nline2\n";
        await triggerDiskChange(fireDiskChange);
        expect(transitions).toEqual([{ uriKey, drifted: true }]);

        tracking.dispose();
        expect(transitions[transitions.length - 1]).toEqual({ uriKey, drifted: false });

        // A later watcher event after dispose is inert.
        transitions.length = 0;
        diskContent = "line1 DISK MORE\nline2\n";
        await triggerDiskChange(fireDiskChange);
        expect(transitions).toEqual([]);
    });
});
