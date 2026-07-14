/**
 * Integration test in a real Extension Host for notify-only disk-drift
 * detection (MAR-138). The whole point of the notify-only design is that the
 * extension never mutates a document in response to an external disk write —
 * it only flags drift for the webview badge. These tests verify the two claims
 * the unit tests can't reach in a real host:
 *
 *   1. A CLEAN document is reloaded by VS Code itself when its file changes on
 *      disk — so the feature correctly does nothing for clean docs (no badge,
 *      no reinventing the platform).
 *   2. A DIRTY BACKGROUND document changing on disk mutates NOTHING — neither
 *      the drifted document's unsaved edits nor the active editor. This is the
 *      guarantee that closes the old auto-revert data-loss vector.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function workspaceUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "a workspace folder is open");
    return folders![0].uri;
}

async function writeFixture(name: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(workspaceUri(), name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return uri;
}

describe("Birta integration: notify-only disk drift never mutates a document", () => {
    it("reloads a CLEAN document from disk via the platform (no extension action needed)", async () => {
        const uri = await writeFixture("driftClean.md", "# A\n\noriginal\n");
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");
        await wait(4000); // let the webview boot
        const doc = await vscode.workspace.openTextDocument(uri);
        assert.ok(!doc.isDirty, "document is clean before the external write");

        // Something external rewrites the file. VS Code auto-reloads a clean
        // TextDocument, so the model should reflect the new content on its own.
        await writeFixture("driftClean.md", "# A\n\nrewritten externally\n");
        for (let i = 0; i < 40 && !doc.getText().includes("rewritten externally"); i++) {
            await wait(100);
        }
        assert.ok(
            doc.getText().includes("rewritten externally"),
            `clean document should reload from disk; got ${JSON.stringify(doc.getText())}`,
        );
        assert.ok(!doc.isDirty, "reloaded document is still clean");
    });

    it("leaves a dirty background document AND the active editor untouched on an external write", async () => {
        // A: dirty, open in Birta, then backgrounded. B: a different active editor.
        const uriA = await writeFixture("driftDirtyA.md", "# A\n\nbody\n");
        const uriB = await writeFixture("driftDirtyB.md", "B base\n");

        await vscode.commands.executeCommand("vscode.openWith", uriA, "birta.editor", {
            viewColumn: vscode.ViewColumn.One,
        });
        await wait(4000);
        const docA = await vscode.workspace.openTextDocument(uriA);
        const editA = new vscode.WorkspaceEdit();
        editA.insert(uriA, new vscode.Position(2, 4), " edited");
        assert.ok(await vscode.workspace.applyEdit(editA), "A dirtied");
        assert.ok(docA.isDirty, "A is dirty");

        const docB = await vscode.workspace.openTextDocument(uriB);
        await vscode.window.showTextDocument(docB, {
            viewColumn: vscode.ViewColumn.Two,
            preview: false,
        });
        const editB = new vscode.WorkspaceEdit();
        editB.insert(uriB, new vscode.Position(0, 6), " MINE");
        assert.ok(await vscode.workspace.applyEdit(editB), "B dirtied");
        assert.ok(docB.isDirty, "B is dirty and active");

        // External write to A (a non-overlapping change). The drift detector may
        // flag a badge, but it must NOT revert/merge anything.
        await writeFixture("driftDirtyA.md", "# A DISK\n\nbody\n");
        await wait(3000); // watcher debounce + evaluate

        // A keeps its unsaved edit and stays dirty (VS Code doesn't auto-reload a
        // dirty doc, and the extension never reverts it).
        assert.ok(docA.isDirty, "A is still dirty (not reverted)");
        assert.ok(docA.getText().includes("body edited"), "A keeps its unsaved edit");

        // B — the active editor — is completely untouched. This is the guarantee
        // that the old auto-revert-by-URI data-loss vector is gone.
        assert.ok(docB.isDirty, "B (active editor) is still dirty");
        assert.strictEqual(docB.getText(), "B base MINE\n", "B content is intact");
    });
});
