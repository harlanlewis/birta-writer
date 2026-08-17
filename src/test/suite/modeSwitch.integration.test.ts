/**
 * Why the mode switch closes the source tab BEFORE opening the destination,
 * and keeps its save prompt (MAR-59).
 *
 * Switching a dirty document between the WYSIWYG editor and Raw Markdown shows
 * VS Code's native Save / Don't Save / Cancel prompt, because the switch closes
 * the source tab first and closing a dirty tab prompts. MAR-59 asked whether
 * the opposite order avoids it: open the destination FIRST, so the shared
 * `TextDocument` is still held by a live editor, and only then close the
 * source. Both editors are backed by one document, so there should be no
 * content to lose.
 *
 * The answer is no, and the reason is not the one the ticket expected. The
 * tabs behave perfectly: no prompt, no cancel, exactly one tab left. But
 * closing the source DISCARDS the unsaved edit. It is not in the document
 * afterwards and it never reached disk, so the trade is not "prompt versus no
 * prompt", it is "prompt versus silently losing the user's words". The shipped
 * order is the correct one.
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
            //    causes and the ticket's answer turns on which: a silent SAVE
            //    (the edit is on disk, and the user was never asked) or a
            //    REVERT (the edit is gone, which would make this approach worse
            //    than the prompt it replaces). Dirty state alone cannot tell
            //    them apart.
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

            // The tab half of the ticket works exactly as hoped.
            assert.strictEqual(closed, true, `close() was not refused; probe: ${JSON.stringify(probe)}`);
            assert.strictEqual(after.text.length, 0, `the source text tab is gone; probe: ${JSON.stringify(probe)}`);
            assert.strictEqual(after.custom.length, 1, `exactly one tab remains; probe: ${JSON.stringify(probe)}`);

            // And the content half is why the approach is dead. Closing the
            // source DISCARDS the unsaved edit: it is not in the document and
            // it never reached disk. No prompt, one tab, and the user's words
            // are gone, which is strictly worse than the Save / Don't Save /
            // Cancel the switch shows today.
            //
            // Asserted rather than merely logged so this stays checked. If a
            // future VS Code preserves the edit here, THIS is the assertion
            // that goes red, and MAR-59 is worth reopening on that day.
            assert.strictEqual(
                probe.docKeepsEdit, false,
                `the edit survived, so the lossless switch may now be possible; probe: ${JSON.stringify(probe)}`,
            );
            assert.strictEqual(
                probe.diskHasEditAfter, false,
                `the edit reached disk, so this was a silent save rather than a discard; probe: ${JSON.stringify(probe)}`,
            );
        } finally {
            await vscode.commands.executeCommand("workbench.action.files.revert").then(undefined, () => undefined);
            await revertAndClose(uri);
        }
    });

    it("a user CAN reach two editors on one dirty file, and closing either loses the edit (MAR-368)", async function () {
        // The discard above needed a state the product never builds: both
        // switch paths close the source BEFORE opening the destination, so
        // neither leaves two editors on one document. This asks whether a user
        // can build it anyway, because if they can the discard is a data-loss
        // bug rather than a note on a rejected prototype.
        //
        // The gesture is Open With → Text Editor from the explorer, on a file
        // already open and dirty in the WYSIWYG editor: the one route that
        // reaches two editors without going through either switch command.
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

            // The user's gesture: Open With → Text Editor, alongside.
            await vscode.commands.executeCommand(
                "vscode.openWith", uri, "default",
                { viewColumn: vscode.ViewColumn.Active, preview: false },
            );
            await wait(1500);

            const both = tabsFor(uri);
            const reachedTwoEditors = both.text.length === 1 && both.custom.length === 1;

            let survivedClosingCustom: boolean | null = null;
            if (reachedTwoEditors) {
                const customTab = tabsFor(uri).custom[0]!;
                await vscode.window.tabGroups.close(customTab);
                await wait(800);
                survivedClosingCustom = doc.getText().includes("Typed in WYSIWYG.");
            }

            const probe = { reachedTwoEditors, survivedClosingCustom, stillDirty: doc.isDirty };
            console.log("MAR-59 reachability probe:", JSON.stringify(probe));

            // The answer is yes, a user can reach it, so this is a data-loss
            // bug and not a note on a rejected prototype: MAR-368.
            assert.strictEqual(
                reachedTwoEditors, true,
                `Open With no longer reaches two editors, so MAR-368 may be moot; probe: ${JSON.stringify(probe)}`,
            );

            // KNOWN BAD, pinned rather than skipped (MAR-368). The edit SHOULD
            // survive; today it does not. Asserting the loss is what makes the
            // fix visible: the day the edit survives, this line goes red and
            // whoever fixed it has to come back and turn it into the guarantee.
            assert.strictEqual(
                survivedClosingCustom, false,
                "the edit SURVIVED — MAR-368 appears fixed, so invert this assertion and close the ticket",
            );
        } finally {
            await vscode.commands.executeCommand("workbench.action.files.revert").then(undefined, () => undefined);
            await revertAndClose(uri);
        }
    });
});
