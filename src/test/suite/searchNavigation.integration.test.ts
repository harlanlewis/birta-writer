/**
 * Integration test in a real Extension Host: a VS Code search-result click on a
 * `.md` file that opens in Birta lands ON the match, with it selected.
 *
 * This is the only layer that can see the bug it pins. The whole failure lived
 * in event *timing* between VS Code and the extension host — search opens a raw
 * text editor with the match selected, and the WYSIWYG swap used to close it
 * before any signal reached us, so the panel opened at the top of the file. No
 * mock reproduces that; it took a real search view and a real swap to observe.
 *
 * The webview's selection is read back through the extension's own public API
 * (src/agentBridge/), which is the only way to see inside a custom editor —
 * `vscode.window.activeTextEditor` is undefined for one.
 */
import * as assert from "assert";
import * as vscode from "vscode";

// Structural copies of the public API's shapes (src/agentBridge/api.ts). This
// suite compiles with `rootDir: src`, so it can't import across into shared/.
interface BirtaEditorContext {
    fsPath: string;
    selection: { start: { line: number; character: number }; end: { line: number; character: number } };
    selectedText: string;
    isEmpty: boolean;
}
interface BirtaApi {
    getActiveEditorContext(): Promise<BirtaEditorContext | null>;
}

const NEEDLE = "ZQXNEEDLEZQX";
/** 0-indexed source line the needle lives on (paragraphs are double-spaced). */
const NEEDLE_LINE = 78;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function workspaceUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "a workspace folder is open");
    return folders![0].uri;
}

/** An 80-paragraph file with the needle in paragraph 40. */
async function writeFixture(name: string, withNeedle = true): Promise<vscode.Uri> {
    const lines: string[] = [];
    for (let i = 1; i <= 80; i++) {
        lines.push(
            i === 40 && withNeedle
                ? `Paragraph 40 contains ${NEEDLE} here.`
                : `Paragraph ${i} filler text.`,
        );
        lines.push("");
    }
    const uri = vscode.Uri.joinPath(workspaceUri(), name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join("\n"), "utf8"));
    return uri;
}

async function birtaApi(): Promise<BirtaApi> {
    const ext = vscode.extensions.getExtension("birtalabs.birta-writer");
    assert.ok(ext, "the extension is installed in the host");
    return (await ext!.activate()) as BirtaApi;
}

/** True once `uri` is showing in a Birta custom-editor tab. */
function inBirtaTab(uri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
            (tab) =>
                tab.input instanceof vscode.TabInputCustom &&
                tab.input.viewType === "birta.editor" &&
                tab.input.uri.toString() === uri.toString(),
        ),
    );
}

/**
 * The Birta editor's context for `uri` once it reports a selection. The webview
 * boots, then places the caret; polling beats a fixed sleep on a loaded box.
 */
async function awaitSelection(
    api: BirtaApi,
    uri: vscode.Uri,
    attempts = 24,
): Promise<BirtaEditorContext | null> {
    // The API answers for the ACTIVE panel, and clicking a result can leave
    // focus in the search view. A user's next keystroke goes to the editor;
    // give the harness the same footing before reading it.
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    let context: BirtaEditorContext | null = null;
    for (let i = 0; i < attempts; i++) {
        context = await api.getActiveEditorContext();
        if (context?.fsPath === uri.fsPath && !context.isEmpty) { return context; }
        await wait(250);
    }
    return context;
}

/**
 * Click the first `NEEDLE` result in the search view and return what the Birta
 * editor ends up showing.
 *
 * Two sources of flakiness are handled rather than slept through: the results
 * must exist before walking them (poll the view's own results), and the first
 * `focusNextSearchResult` may land on the FILE row rather than the match, which
 * opens the file with no selection — so keep stepping until a match opens.
 */
async function searchJump(api: BirtaApi, uri: vscode.Uri): Promise<BirtaEditorContext | null> {
    await vscode.commands.executeCommand("workbench.action.findInFiles", {
        query: NEEDLE,
        triggerSearch: true,
    });
    for (let i = 0; i < 40; i++) {
        const results = await vscode.commands.executeCommand("search.action.getSearchResults");
        if (typeof results === "string" && results.includes(NEEDLE)) { break; }
        await wait(250);
    }
    let last: BirtaEditorContext | null = null;
    for (let step = 0; step < 3; step++) {
        await vscode.commands.executeCommand("search.action.focusNextSearchResult");
        last = await awaitSelection(api, uri);
        if (last?.fsPath === uri.fsPath && !last.isEmpty) { return last; }
    }
    return last;
}

describe("Birta integration: a search-result click lands on the match", () => {
    it("selects and reveals the match when the file is not yet open", async () => {
        const uri = await writeFixture("searchJumpFresh.md");
        const api = await birtaApi();

        const context = await searchJump(api, uri);
        assert.ok(inBirtaTab(uri), "the search hit ended up in a Birta editor");
        assert.ok(context, "the Birta editor reports a context");
        assert.strictEqual(
            context!.selectedText,
            NEEDLE,
            `the match should be selected; got ${JSON.stringify(context!.selectedText)}`,
        );
        assert.strictEqual(
            context!.selection.start.line,
            NEEDLE_LINE,
            "the selection is on the matched line",
        );
    });

    it("selects and reveals the match when the file is ALREADY open in Birta", async () => {
        // Search replaces the custom-editor tab with a text editor and the swap
        // brings it back, so this path is a second chance to lose the target.
        const uri = await writeFixture("searchJumpOpen.md");
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");
        for (let i = 0; i < 40 && !inBirtaTab(uri); i++) { await wait(250); }
        await wait(3000);
        assert.ok(inBirtaTab(uri), "the file starts out in a Birta editor");
        const api = await birtaApi();

        const context = await searchJump(api, uri);
        assert.ok(context, "the Birta editor reports a context");
        assert.strictEqual(
            context!.selectedText,
            NEEDLE,
            `the match should be selected; got ${JSON.stringify(context!.selectedText)}`,
        );
    });

    it("never closes a raw tab holding UNSAVED changes, even to render it", async () => {
        // MAR-269. The swap closes the raw tab, and closing the last text
        // editor of a dirty document is what makes VS Code ask "save?" — an
        // answer given in a hurry loses the edit, and an automated host answers
        // it destructively with no prompt at all. Reachable from an ordinary
        // search click: edit in Birta, click a hit for that same file, and
        // VS Code opens a second (raw) editor on the dirty document.
        const uri = await writeFixture("searchJumpDirty.md");
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");
        for (let i = 0; i < 40 && !inBirtaTab(uri); i++) { await wait(250); }
        await wait(3000);

        const doc = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 9), " UNSAVED");
        assert.ok(await vscode.workspace.applyEdit(edit), "the document was dirtied");
        await wait(1500);
        assert.ok(doc.isDirty, "precondition: unsaved changes are pending");

        await vscode.commands.executeCommand("vscode.open", uri, {
            selection: new vscode.Range(NEEDLE_LINE, 0, NEEDLE_LINE, 5),
        });
        await wait(4000);

        assert.ok(
            doc.getText().includes("UNSAVED"),
            "the unsaved edit survives a search-style open",
        );
        assert.ok(doc.isDirty, "and the document is still dirty (not reverted)");
        await doc.save(); // leave nothing pending for the host's shutdown
    });

    it("leaves the caret alone on an ordinary open (no navigation to honour)", async () => {
        // The capture must not turn "opened a file" into "jump to line 1" — that
        // is what discarded the panel's remembered scroll position before.
        const uri = await writeFixture("searchJumpPlain.md", false);
        await vscode.commands.executeCommand("vscode.open", uri);
        for (let i = 0; i < 40 && !inBirtaTab(uri); i++) { await wait(250); }
        assert.ok(inBirtaTab(uri), "an ordinary open still swaps into Birta");
        await wait(4000);
        await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");

        const context = await (await birtaApi()).getActiveEditorContext();
        assert.ok(context, "the Birta editor reports a context");
        assert.strictEqual(context!.fsPath, uri.fsPath, "the plain file is the active editor");
        assert.ok(
            context!.isEmpty,
            `no selection is manufactured for a plain open; got ${JSON.stringify(context!.selectedText)}`,
        );
    });
});
