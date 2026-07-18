/**
 * Integration tests in a real Extension Host. These verify the VS Code behaviors
 * the unit tests can only mock:
 *   1. the Birta custom editor registers and activates;
 *   2. onWillSaveTextDocument + waitUntil(TextEdit[]) actually mutates the saved
 *      file (the API contract the save-flush fix rests on);
 *   3. a fast save after an EXTERNAL edit is still correct even though the flush
 *      finds nothing to contribute (graceful degradation — the flush never
 *      corrupts a save);
 *   4. an edit that lives only in the webview (not yet synced to the document) is
 *      carried to disk by the save flush — the real end-to-end flush path, driven
 *      through the actual Milkdown editor via the invisible `birta._test.insertText`
 *      command.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const EXT_ID = "birtalabs.birta-writer";
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

async function readFile(uri: vscode.Uri): Promise<string> {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

/** Type text into the active Birta editor's real Milkdown view (test-only command). */
async function typeInEditor(text: string): Promise<void> {
    await vscode.commands.executeCommand("birta._test.insertText", text);
}

describe("Birta integration: save + onWillSaveTextDocument", () => {
    it("registers and activates the Birta custom editor extension", async () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        assert.ok(ext, `extension ${EXT_ID} is present`);
        await ext!.activate();
        assert.ok(ext!.isActive, "extension activated");
    });

    it("onWillSaveTextDocument waitUntil(TextEdit[]) writes the participant's edit to disk", async () => {
        // Verifies the exact VS Code contract the save-flush fix depends on:
        // a will-save participant can inject edits via waitUntil and they land on
        // disk atomically with the save. Uses a plain document + throwaway
        // participant so it isolates the API from our webview.
        const uri = await writeFixture("contract.md", "hello\n");
        const doc = await vscode.workspace.openTextDocument(uri);
        const dirtyEdit = new vscode.WorkspaceEdit();
        dirtyEdit.insert(uri, new vscode.Position(0, 5), " world");
        assert.ok(await vscode.workspace.applyEdit(dirtyEdit), "workspace edit applied");
        assert.ok(doc.isDirty, "document is dirty before save");

        const sub = vscode.workspace.onWillSaveTextDocument((e) => {
            if (e.document.uri.toString() !== uri.toString()) { return; }
            const eol = e.document.lineAt(0).text.length;
            e.waitUntil(Promise.resolve([
                vscode.TextEdit.insert(new vscode.Position(0, eol), " [flushed]"),
            ]));
        });
        try {
            assert.ok(await doc.save(), "save() reported success");
        } finally {
            sub.dispose();
        }

        const onDisk = await readFile(uri);
        assert.ok(
            onDisk.includes("hello world [flushed]"),
            `will-save edit should be on disk; got ${JSON.stringify(onDisk)}`,
        );
        assert.ok(!doc.isDirty, "document is clean after save");
    });

    it("a fast save after an external edit stays correct even when the flush finds nothing to contribute", async () => {
        // Opens in the Birta custom editor (boots the real webview + registers the
        // provider's onWillSave flush), then edits the backing document directly
        // and saves immediately. The flush stale-rejects here (the webview hasn't
        // yet received the external change), so this proves graceful degradation:
        // the provider's participant runs in a real host without hanging/crashing
        // and the save is still byte-correct.
        const uri = await writeFixture("external.md", "# Title\n\nBody\n");
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");
        await wait(4000); // let the webview reach ready/init

        const doc = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(2, 4), " edited");
        assert.ok(await vscode.workspace.applyEdit(edit), "workspace edit applied");
        assert.ok(doc.isDirty, "document is dirty after the edit");

        assert.ok(await doc.save(), "save() reported success");
        assert.ok(!doc.isDirty, "document is clean after save");
        assert.ok((await readFile(uri)).includes("edited"), "edit persisted");
    });

    it("carries an un-synced webview edit to disk via the save flush (real end-to-end)", async () => {
        // The core guarantee, exercised through the real Milkdown editor: an edit
        // that exists ONLY in the webview (not yet synced to the document) must
        // still be saved. Without the flush this is the original data-loss bug.
        const uri = await writeFixture("flush.md", "start\n");
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");
        await wait(4000); // let the webview boot before driving it (see note below)
        const doc = await vscode.workspace.openTextDocument(uri);

        // First webview edit → leading-edge sync applies it to the document; poll
        // until it lands so the next edit is a trailing (deferred) sync. NOTE: the
        // boot delay is a fixed wait on purpose. An adaptive variant that re-sends
        // the insert from before the webview is ready was tried and reliably failed
        // — the document stayed untouched and no later insert ever synced — so the
        // single post-boot insert is the known-good path. (Test-hook artifact only;
        // no production path drives the editor during boot.)
        await typeInEditor("AAA");
        for (let i = 0; i < 40 && !doc.getText().includes("AAA"); i++) { await wait(50); }
        assert.ok(doc.getText().includes("AAA"), "first webview edit synced to the document");
        assert.ok(doc.isDirty, "document is dirty");

        // Second webview edit → trailing debounce (~300ms). Right now it lives
        // ONLY in the webview; give it a moment to reach Milkdown but stay well
        // under the sync delay.
        await typeInEditor("BBB");
        await wait(120);
        assert.ok(!doc.getText().includes("BBB"), "second edit is NOT yet in the document (still webview-only)");

        // The ONLY path BBB can reach disk now is the onWillSave flush.
        assert.ok(await doc.save(), "save() reported success");
        const onDisk = await readFile(uri);
        assert.ok(
            onDisk.includes("BBB"),
            `flush must carry the un-synced webview edit to disk; got ${JSON.stringify(onDisk)}`,
        );
    });
});
