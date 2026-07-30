/**
 * Integration test in a real Extension Host: what VS Code's read-only signals
 * actually tell an extension (MAR-255).
 *
 * MAR-255 asked for a read-only `.md` to open locked in Birta, on the premise
 * that a custom editor gets no enforcement from the platform, so a read-only
 * file "opens fully editable and the edits are silently discarded" —
 * `applyEdit` rejected, the document never dirtied, Cmd+S writing nothing while
 * nobody says so. The ticket named the check that would confirm or kill it, and
 * this file is that check.
 *
 * IT KILLED IT. Measured against VS Code 1.130.0 on darwin-arm64, 2026-07-29:
 *
 *   - `stat().permissions` carries NO `FilePermission.Readonly` bit for a
 *     `chmod 444` file — with `files.readonlyFromPermissions` on OR off — nor
 *     for a `files.readonlyInclude` match. `workspace.fs` talks to the
 *     filesystem PROVIDER, and the built-in disk provider is not read-only; the
 *     workbench's own read-only notions sit above it and are not exposed.
 *   - `workspace.applyEdit` is NOT rejected in any of those configurations. The
 *     document takes the edit and goes dirty, exactly as a writable file would.
 *   - `doc.save()` then returns **false** and the bytes on disk do not change.
 *     That is where the failure lands, and in the UI it lands loudly — VS Code
 *     raises its own save-failure notification with Retry/Overwrite. Nothing is
 *     silently discarded, and Birta's `applyEdit`-rejection path never runs.
 *   - `isWritableFileSystem` returns `undefined`, not `false`, for a provider
 *     registered `isReadonly: true` from this same extension host, and `true`
 *     for `file`.
 *
 * Two consequences, which are why MAR-255 shipped no behavior change:
 *
 *   1. There is no public signal by which Birta could know. Detection would
 *      mean re-deriving the workbench's verdict from its own inputs
 *      (`files.readonly*` plus a Node `fs.access` check), i.e. reimplementing
 *      platform logic that can drift.
 *   2. There is nothing silent to fix. The remaining defect is an affordance
 *      one — the editor invites typing that the save will refuse — with the
 *      same severity as the raw text editor's own behavior at the default
 *      `files.readonlyFromPermissions: false`.
 *
 * This file stays as the executable record. Every claim above that VS Code
 * could reverse is an ASSERTION, so a future version that starts exposing the
 * signal turns this suite red — which is the trigger to reopen the feature, not
 * a failure. The `reports:` lines print the values the platform is free to
 * choose either way.
 */
import * as assert from "assert";
import { chmodSync } from "fs";
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

async function isReadonlyByStat(uri: vscode.Uri): Promise<boolean> {
    const stat = await vscode.workspace.fs.stat(uri);
    return ((stat.permissions ?? 0) & vscode.FilePermission.Readonly) !== 0;
}

/** Insert a character and report whether the document actually took it. */
async function tryEdit(uri: vscode.Uri): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const before = doc.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), "X");
    await vscode.workspace.applyEdit(edit);
    const took = doc.getText() !== before;
    if (took) {
        const undo = new vscode.WorkspaceEdit();
        undo.delete(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)));
        await vscode.workspace.applyEdit(undo);
    }
    return took;
}

describe("Birta integration: what VS Code's read-only signals tell an extension", () => {
    const chmodded: vscode.Uri[] = [];

    afterEach(async () => {
        // Make every fixture writable again or the workspace cannot be cleaned.
        for (const uri of chmodded.splice(0)) {
            try { chmodSync(uri.fsPath, 0o644); } catch { /* already gone */ }
        }
        const files = vscode.workspace.getConfiguration("files");
        await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Global);
        await files.update("readonlyFromPermissions", undefined, vscode.ConfigurationTarget.Global);
    });

    it("the local file scheme — the only one Birta's editor ever opens — is writable", async () => {
        // resolveCustomTextEditor renders a blank page and returns for any
        // scheme other than `file`, so the whole-scheme signal can never fire
        // for a document Birta is actually editing. That is half of why the
        // read-only lock would have been dead code.
        assert.strictEqual(
            vscode.workspace.fs.isWritableFileSystem("file"),
            true,
            "the local file scheme reports writable",
        );

        // And for reference: registering a read-only provider from this host
        // does not make the scheme report `false` either — it reports
        // `undefined`, indistinguishable from a scheme VS Code does not know.
        const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        const provider: vscode.FileSystemProvider = {
            onDidChangeFile: emitter.event,
            watch: () => new vscode.Disposable(() => { /* nothing to unwatch */ }),
            stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 }),
            readDirectory: () => [],
            createDirectory: () => { /* unsupported */ },
            readFile: () => new Uint8Array(),
            writeFile: () => { /* unsupported */ },
            delete: () => { /* unsupported */ },
            rename: () => { /* unsupported */ },
        };
        const reg = vscode.workspace.registerFileSystemProvider("birta-test-ro", provider, {
            isReadonly: true,
        });
        try {
            console.log(`  reports: isWritableFileSystem("birta-test-ro") = ${
                String(vscode.workspace.fs.isWritableFileSystem("birta-test-ro"))}`);
            console.log(`  reports: isWritableFileSystem("vscode-unknown") = ${
                String(vscode.workspace.fs.isWritableFileSystem("vscode-unknown"))}`);
        } finally {
            reg.dispose();
            emitter.dispose();
        }
    });

    it("filesystem permissions are invisible through workspace.fs.stat", async () => {
        // The per-file signal MAR-255 expected to use, and the other half of why
        // the lock would have been dead code.
        const uri = await writeFixture("readOnlyPerm.md", "# locked\n\nbody\n");
        assert.strictEqual(await isReadonlyByStat(uri), false, "0644 is not read-only");

        chmodSync(uri.fsPath, 0o444);
        chmodded.push(uri);
        assert.strictEqual(
            await isReadonlyByStat(uri),
            false,
            "0444 is ALSO not reported read-only",
        );

        await vscode.workspace
            .getConfiguration("files")
            .update("readonlyFromPermissions", true, vscode.ConfigurationTarget.Global);
        await wait(1000);
        assert.strictEqual(
            await isReadonlyByStat(uri),
            false,
            "files.readonlyFromPermissions does not change what fs.stat reports",
        );
    });

    it("a files.readonlyInclude match is invisible through workspace.fs.stat too", async () => {
        const uri = await writeFixture("readOnlyGlob.md", "# glob\n\nbody\n");
        await vscode.workspace
            .getConfiguration("files")
            .update("readonlyInclude", { "**/readOnlyGlob.md": true }, vscode.ConfigurationTarget.Global);
        await wait(1000);
        assert.strictEqual(
            await isReadonlyByStat(uri),
            false,
            "a workbench glob is not a filesystem-provider fact",
        );
        console.log(`  reports: applyEdit against a readonlyInclude match took the edit = ${
            String(await tryEdit(uri))}`);
    });

    it("an edit against a read-only file is taken, not rejected", async () => {
        // The claim MAR-255 rested on, inverted. Birta's `applyEdit` rejection
        // handler never runs for these files, so making it notify would have
        // fixed nothing.
        const uri = await writeFixture("readOnlyApply.md", "# locked\n\nbody\n");
        chmodSync(uri.fsPath, 0o444);
        chmodded.push(uri);
        assert.strictEqual(
            await tryEdit(uri),
            true,
            "applyEdit against a 0444 file is NOT rejected",
        );

        await vscode.workspace
            .getConfiguration("files")
            .update("readonlyFromPermissions", true, vscode.ConfigurationTarget.Global);
        await wait(1000);
        assert.strictEqual(
            await tryEdit(uri),
            true,
            "nor is it rejected with files.readonlyFromPermissions on",
        );
    });

    it("the failure lands at SAVE, where the platform reports it", async () => {
        // So the typing is not "silently discarded": the document dirties like
        // any other, and the save fails — which the workbench surfaces with its
        // own retry/overwrite notification.
        const uri = await writeFixture("readOnlySave.md", "# save\n\nbody\n");
        const doc = await vscode.workspace.openTextDocument(uri);
        chmodSync(uri.fsPath, 0o444);
        chmodded.push(uri);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), "X");
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true, "the edit applies");
        assert.strictEqual(doc.isDirty, true, "the document dirties normally");

        assert.strictEqual(await doc.save(), false, "the save FAILS — this is the real failure point");
        const onDisk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        assert.strictEqual(onDisk.startsWith("X"), false, "and the bytes on disk are unchanged");
    });
});
