/**
 * Why the mode switch closes the source tab BEFORE opening the destination,
 * and keeps its save prompt (MAR-59), and why two editors on one dirty file
 * are not a data-loss bug (MAR-368).
 *
 * Switching a dirty document between the WYSIWYG editor and Raw Markdown shows
 * VS Code's native Save / Don't Save / Cancel prompt, because the switch closes
 * the source tab first and closing a dirty tab prompts. MAR-59 asked whether
 * the opposite order avoids it: open the destination FIRST, so the shared
 * `TextDocument` is still held by a live editor, and only then close the
 * source. Both editors are backed by one document, so there should be no
 * content to lose.
 *
 * The answer is no. VS Code skips the prompt only when the SAME editor input
 * is still open in another group (`doHandleCloseConfirmation` in
 * `editorGroupView.ts` matches the exact input, and a text editor never
 * matches a custom editor on the same file), so closing either half of a
 * text-plus-WYSIWYG pair prompts exactly as a lone tab does. Destination-first
 * buys nothing, and the shipped order is the correct one.
 *
 * READ THE PROBE OUTPUT WITH THIS IN MIND: in this host the prompt never
 * appears and the document comes back clean. That is the harness, not the
 * product. Under `extensionTestsLocationURI`, `FileDialogService.showSaveConfirm`
 * logs "refused to show save confirmation dialog in tests" and returns
 * DONT_SAVE (`skipDialogs()` in `abstractFileDialogService.ts`), and Don't
 * Save reverts the shared text model, which is what empties the edit out of
 * BOTH editors. Verified by running this file under `--log trace` and reading
 * the renderer log: one such line per close, each a few hundred milliseconds
 * before the probe that reports the edit gone. So "the edit did not survive"
 * here is the answer an interactive user gives by clicking Don't Save, and a
 * silent loss cannot be observed from inside this harness at all. Assert the
 * things this host CAN witness: which tab states are reachable, that the two
 * editors share one document, and that Birta itself never wrote to disk.
 *
 * This has to run in a real Extension Host: it is a question about VS Code's
 * tab and save machinery, which neither a unit test nor the headless-Chromium
 * harness can reach.
 *
 * Setup gotcha, and the whole reason this file looks the way it does: the
 * extension swaps any CLEAN `.md` text tab to the WYSIWYG editor on open, so a
 * plain `showTextDocument` here is closed underneath the test before it can
 * type. The document is dirtied through a workspace edit FIRST, which the swap
 * skips, and that is also the state the ticket is about.
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

async function readFile(uri: vscode.Uri): Promise<string> {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

/** Every open tab for `uri`, by kind. */
function tabsFor(uri: vscode.Uri): { text: vscode.Tab[]; custom: vscode.Tab[] } {
    const text: vscode.Tab[] = [];
    const custom: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText
                && input.uri.toString() === uri.toString()) {
                text.push(tab);
            } else if (input instanceof vscode.TabInputCustom
                && input.uri.toString() === uri.toString()) {
                custom.push(tab);
            }
        }
    }
    return { text, custom };
}

/**
 * Open `uri` as a DIRTY raw text editor, which is the state the switch is
 * about and the only one the extension's clean-tab swap leaves alone.
 */
async function openDirtyTextEditor(uri: vscode.Uri, insert: string): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(doc.lineCount - 1, 0), insert);
    assert.ok(await vscode.workspace.applyEdit(edit), "the fixture was dirtied");
    assert.ok(doc.isDirty, "the document is dirty before any editor opens");
    await vscode.window.showTextDocument(doc, { preview: false });
    await wait(1200); // long enough for the clean-tab swap to have fired if it were going to
    return doc;
}

/**
 * Leave no dirty fixture behind for the suites that follow. Reverting BEFORE
 * closing is what keeps this from prompting on its own teardown, and closing
 * only this file's tabs is what keeps it from disturbing another suite's state.
 */
async function revertAndClose(uri: vscode.Uri): Promise<void> {
    const { text, custom } = tabsFor(uri);
    for (const tab of [...text, ...custom]) {
        if (tab.group.viewColumn !== undefined) {
            await vscode.window.tabGroups.close(tab, true).then(undefined, () => undefined);
        }
    }
    await wait(200);
}

describe("Birta integration: lossless mode switch (MAR-59)", () => {
    it("the same file open as text and custom at once should be ONE TextDocument", async function () {
        // The premise the whole approach rests on: if the two editors were
        // backed by different documents the dirty content could not survive,
        // whatever the tabs did. Asserted first, because every later claim is
        // meaningless if this is false.
        this.timeout(90_000);
        const uri = await writeFixture("modeswitch-shared.md", "# Shared\n\nBody.\n");
        const doc = await openDirtyTextEditor(uri, "A dirty line.\n");
        try {
            await vscode.commands.executeCommand(
                "vscode.openWith", uri, "birta.editor",
                { viewColumn: vscode.ViewColumn.Active, preview: false },
            );
            await wait(3000);
            const again = await vscode.workspace.openTextDocument(uri);
            assert.strictEqual(again, doc, "both editors resolve to the same TextDocument instance");
            assert.ok(again.isDirty, "and it is still the dirty one");
        } finally {
            await vscode.commands.executeCommand("workbench.action.files.revert").then(undefined, () => undefined);
            await revertAndClose(uri);
        }
    });

    it("opening the destination first should let the dirty source tab close without a prompt", async function () {
        this.timeout(90_000);

        const uri = await writeFixture("modeswitch.md", "# Switch me\n\nBody text.\n");
        const doc = await openDirtyTextEditor(uri, "An unsaved line.\n");

        try {
            const before = tabsFor(uri);
            assert.strictEqual(before.text.length, 1, "exactly one text tab before the switch");
            assert.strictEqual(before.custom.length, 0, "no custom tab before the switch");
            const viewColumn = before.text[0]!.group.viewColumn;

            // 1. Destination first.
            await vscode.commands.executeCommand(
                "vscode.openWith", uri, "birta.editor", { viewColumn, preview: false },
            );
            await wait(3000);

            const mid = tabsFor(uri);
            assert.strictEqual(mid.custom.length, 1, "the custom editor opened");
            assert.strictEqual(
                mid.text.length, 1,
                "the text tab is still open — the two-tab state the switch must not leave behind",
            );
            assert.ok(doc.isDirty, "the shared document is still dirty with both editors open");

            // 2. Re-query the source fresh. Tab identity is not stable across an
            //    await on every supported VS Code, so a pre-open handle is a
            //    stale reference rather than the tab now on screen.
            const stale = before.text[0]!;
            const fresh = tabsFor(uri).text[0];
            assert.ok(fresh, "the source text tab is still findable by uri after the open");

            // 3. The question. Read the disk before and after, because "the
            //    document stopped being dirty" has two completely different
            //    causes: a SAVE (the edit is on disk) or a REVERT (the edit is
            //    gone). Dirty state alone cannot tell them apart, and only the
            //    second is what this host's auto-answered Don't Save produces.
            const diskBefore = await readFile(uri);
            const closed = await vscode.window.tabGroups.close(fresh!);
            await wait(800);
            const diskAfter = await readFile(uri);

            const after = tabsFor(uri);
            const probe = {
                closeReturned: closed,
                textTabsLeft: after.text.length,
                customTabsLeft: after.custom.length,
                stillDirty: doc.isDirty,
                docKeepsEdit: doc.getText().includes("An unsaved line."),
                diskHadEditBefore: diskBefore.includes("An unsaved line."),
                diskHasEditAfter: diskAfter.includes("An unsaved line."),
                staleHandleWasSameObject: stale === fresh,
            };
            console.log("MAR-59 lossless switch probe:", JSON.stringify(probe));

            // The tab half behaves: the source closes and one tab remains.
            assert.strictEqual(closed, true, `close() was not refused; probe: ${JSON.stringify(probe)}`);
            assert.strictEqual(after.text.length, 0, `the source text tab is gone; probe: ${JSON.stringify(probe)}`);
            assert.strictEqual(after.custom.length, 1, `exactly one tab remains; probe: ${JSON.stringify(probe)}`);

            // The content half is the prompt, answered for us. VS Code asked
            // to save the dirty text tab even though the WYSIWYG editor still
            // held the document, this host answered Don't Save, and the revert
            // emptied the shared model. An interactive user sees the same
            // Save / Don't Save / Cancel the switch shows today, so the
            // reversed order buys nothing.
            //
            // If the edit ever SURVIVES here, VS Code has stopped prompting for
            // a text-plus-custom pair, and MAR-59's lossless switch is worth
            // asking again on that day; this is the assertion that goes red.
            assert.strictEqual(
                probe.docKeepsEdit, false,
                `the edit survived the close without a prompt, so the lossless switch may now be possible; probe: ${JSON.stringify(probe)}`,
            );
            // And Birta never wrote the file on its own: the answer was Don't
            // Save, so the bytes on disk are the bytes from before.
            assert.strictEqual(
                probe.diskHasEditAfter, false,
                `the edit reached disk without a save gesture; probe: ${JSON.stringify(probe)}`,
            );
        } finally {
            await vscode.commands.executeCommand("workbench.action.files.revert").then(undefined, () => undefined);
            await revertAndClose(uri);
        }
    });

    it("a user CAN reach two editors on one dirty file, and closing one is a prompt the host answers, not a silent loss (MAR-368)", async function () {
        // Both switch paths close the source BEFORE opening the destination, so
        // neither leaves two editors on one document. This asks whether a user
        // can build that state anyway, and what happens to the edit when they
        // close one half of it.
        //
        // The gesture is Open With, Text Editor, from the explorer, on a file
        // already open and dirty in the WYSIWYG editor: the one route that
        // reaches two editors without going through either switch command.
        //
        // What it must NOT be read as: a silent discard. The edit disappears
        // here because this host answers VS Code's save prompt with Don't Save
        // (see the file header); MAR-368 was filed on that reading and closed
        // once the trace log showed the prompt being requested and refused.
        this.timeout(90_000);

        const uri = await writeFixture("modeswitch-reach.md", "# Reachable\n\nBody.\n");
        const doc = await vscode.workspace.openTextDocument(uri);
        try {
            await vscode.commands.executeCommand(
                "vscode.openWith", uri, "birta.editor",
                { viewColumn: vscode.ViewColumn.Active, preview: false },
            );
            await wait(3000);

            // Dirty it while only the WYSIWYG editor holds it.
            const edit = new vscode.WorkspaceEdit();
            edit.insert(uri, new vscode.Position(doc.lineCount - 1, 0), "Typed in WYSIWYG.\n");
            assert.ok(await vscode.workspace.applyEdit(edit), "the document was dirtied");
            await wait(500);
            assert.ok(doc.isDirty, "dirty with only the custom editor open");
            assert.ok(doc.getText().includes("Typed in WYSIWYG."), "the edit is in the document before the second open");

            // The user's gesture: Open With, Text Editor, alongside.
            await vscode.commands.executeCommand(
                "vscode.openWith", uri, "default",
                { viewColumn: vscode.ViewColumn.Active, preview: false },
            );
            await wait(1500);

            const both = tabsFor(uri);
            const reachedTwoEditors = both.text.length === 1 && both.custom.length === 1;
            assert.strictEqual(
                reachedTwoEditors, true,
                `Open With no longer reaches two editors; tabs: text=${both.text.length} custom=${both.custom.length}`,
            );
            assert.ok(doc.isDirty, "still dirty with both editors open: the open itself loses nothing");

            // Close the WYSIWYG half. VS Code prompts for the dirty document
            // (the raw tab is a different editor input, so it does not count
            // as "still open elsewhere"); this host answers Don't Save.
            const diskBefore = await readFile(uri);
            const customTab = tabsFor(uri).custom[0]!;
            const closed = await vscode.window.tabGroups.close(customTab);
            await wait(800);
            const diskAfter = await readFile(uri);
            const after = tabsFor(uri);

            const probe = {
                closeReturned: closed,
                textTabsLeft: after.text.length,
                customTabsLeft: after.custom.length,
                stillDirty: doc.isDirty,
                docKeepsEdit: doc.getText().includes("Typed in WYSIWYG."),
                diskHasEditAfter: diskAfter.includes("Typed in WYSIWYG."),
                diskUnchanged: diskBefore === diskAfter,
            };
            console.log("MAR-368 reachability probe:", JSON.stringify(probe));

            assert.strictEqual(closed, true, `close() was not refused; probe: ${JSON.stringify(probe)}`);
            assert.strictEqual(after.custom.length, 0, `the WYSIWYG tab is gone; probe: ${JSON.stringify(probe)}`);
            assert.strictEqual(after.text.length, 1, `the raw tab is still open; probe: ${JSON.stringify(probe)}`);
            // Don't Save reverted the shared model out from under the raw tab
            // too, which is what the answer means. If the edit SURVIVES, VS Code
            // has stopped prompting for a text-plus-custom pair: re-read the
            // header, and re-ask MAR-59 rather than re-filing MAR-368.
            assert.strictEqual(
                probe.docKeepsEdit, false,
                `the edit survived the close without a prompt; probe: ${JSON.stringify(probe)}`,
            );
            // Birta never writes on its own: the bytes on disk are untouched.
            assert.strictEqual(probe.diskUnchanged, true, `disk changed across a Don't Save close; probe: ${JSON.stringify(probe)}`);
        } finally {
            await vscode.commands.executeCommand("workbench.action.files.revert").then(undefined, () => undefined);
            await revertAndClose(uri);
        }
    });
});
