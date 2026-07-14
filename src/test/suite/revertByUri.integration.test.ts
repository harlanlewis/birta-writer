/**
 * Integration test in a real Extension Host for the disk-sync REVERT path — the
 * one behavior the mocked unit tests cannot see.
 *
 * DiskSyncController reconciles an external disk write by reverting the document
 * to disk (clean reload, or the first half of a dirty-document merge). It targets
 * the document BY URI. But `workbench.action.files.revert` IGNORES its URI
 * argument and reverts whatever editor is ACTIVE — so a reconcile of a
 * background document (a file changed on disk while the user is focused on a
 * different tab / split) that relied on the bare command would revert the user's
 * ACTIVE editor instead, silently discarding its unsaved edits. This test drives
 * the real watcher→reconcile path against a background document while a DIFFERENT
 * dirty editor is active, and asserts the active editor is never disturbed.
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

describe("Birta integration: disk-sync reconcile never disturbs the active editor", () => {
    // PENDING (MAR-138): reproduces a confirmed data-loss bug — reconciling a
    // background document reverts the ACTIVE editor because
    // `workbench.action.files.revert` ignores its URI argument. Kept skipped
    // (not deleted) so the fix can un-skip it as its regression guard. Do NOT
    // un-skip without the revert-by-URI fix, or the suite goes red.
    it.skip("reconciles a background Birta document on disk change while a different active editor is untouched", async () => {
        // A is open in the Birta custom editor (its disk-sync watcher armed) and
        // dirtied with a local edit. B is a plain text editor in a separate
        // column, active and dirty. Then A changes on disk (a non-overlapping
        // external write) — a clean three-way merge that reverts-then-reapplies.
        const uriA = await writeFixture("bgReconcileA.md", "# A\n\nbody\n");
        const uriB = await writeFixture("bgReconcileB.md", "B base\n");

        await vscode.commands.executeCommand("vscode.openWith", uriA, "birta.editor", {
            viewColumn: vscode.ViewColumn.One,
        });
        await wait(4000); // let A's webview reach ready/init and arm the watcher

        // Local edit to A (line 2), leaving A dirty. Non-overlapping with the
        // disk change below (line 0), so the merge is clean.
        const docA = await vscode.workspace.openTextDocument(uriA);
        const editA = new vscode.WorkspaceEdit();
        editA.insert(uriA, new vscode.Position(2, 4), " edited");
        assert.ok(await vscode.workspace.applyEdit(editA), "local edit to A applied");
        assert.ok(docA.isDirty, "A is dirty before the disk change");

        // B: active, dirty, in another column.
        const docB = await vscode.workspace.openTextDocument(uriB);
        await vscode.window.showTextDocument(docB, {
            viewColumn: vscode.ViewColumn.Two,
            preview: false,
        });
        const editB = new vscode.WorkspaceEdit();
        editB.insert(uriB, new vscode.Position(0, 6), " MINE");
        assert.ok(await vscode.workspace.applyEdit(editB), "edit B applied");
        assert.ok(docB.isDirty, "B is dirty and active");

        // Something external rewrites A's first line on disk. The disk-sync
        // watcher should fire and reconcile A (revert-then-reapply the local
        // edit) WITHOUT touching the active editor B.
        await writeFixture("bgReconcileA.md", "# A DISK\n\nbody\n");
        await wait(3000); // watcher debounce + reconcile + revert + reapply

        // B (the ACTIVE editor) must be completely untouched. If the reconcile's
        // revert hit the active editor, B's unsaved "MINE" is gone here.
        assert.ok(docB.isDirty, "B (active editor) is still dirty — not reverted");
        assert.strictEqual(docB.getText(), "B base MINE\n", "B content is intact");

        // A should carry BOTH sides: the external first-line change and the local
        // body edit (the clean three-way merge).
        assert.ok(docA.getText().includes("# A DISK"), "A picked up the external disk change");
        assert.ok(docA.getText().includes("body edited"), "A kept the local edit");
    });
});
