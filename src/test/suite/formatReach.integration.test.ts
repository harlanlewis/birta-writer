/**
 * Every format this editor claims to open should actually open in it.
 *
 * The claim is a REACHABILITY claim, and those are the ones that go wrong: the
 * custom editor's `contributes.customEditors` selector listed `*.mdx` and the
 * provider's own routing matched it, so every static check said MDX was
 * supported. The listener that swaps an opened text tab to the rendered editor
 * tested its own separately written pattern, which knew only the two older
 * extensions, so a `.mdx` opened from the explorer sat in the raw text editor
 * while a `.md` beside it rendered.
 *
 * Nothing but a real Extension Host can answer this: the swap is a
 * `window.tabGroups.onDidChangeTabs` reaction, and what it produces is a tab of
 * a different type. Both are invisible to jsdom and to the Chromium harness,
 * which is why the gap survived a unit-tested regex.
 *
 * Driven per format rather than asserted once, and the loop asserts its own
 * size, so a format added to the shared list without reaching this path fails
 * here instead of being discovered by a user.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const EXT_ID = "BirtaLabs.birta-writer";
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The formats to drive, read from the installed extension's own
 * `contributes.customEditors` selector.
 *
 * Taken from there rather than from `shared/documentExtensions.ts` for two
 * reasons. The integration suite compiles with `rootDir: src` and cannot import
 * it. And the selector is the authority on what VS Code will actually route
 * here, so a list copied from the shared constant could agree with the code and
 * still be wrong about the product.
 */
function selectorExtensions(): string[] {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is present`);
    const editors = ext!.packageJSON?.contributes?.customEditors as
        | { viewType?: string; selector?: { filenamePattern?: string }[] }[]
        | undefined;
    assert.ok(editors && editors.length > 0, "customEditors are contributed");
    const patterns = editors!
        .filter((e) => e.viewType === "birta.editor")
        .flatMap((e) => e.selector ?? [])
        .map((s) => s.filenamePattern ?? "");
    const exts = patterns
        .map((p) => /^\*\.([A-Za-z0-9]+)$/.exec(p)?.[1])
        .filter((e): e is string => Boolean(e));
    assert.ok(exts.length >= 3, `expected at least 3 simple patterns, got ${JSON.stringify(patterns)}`);
    return exts;
}

function workspaceUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "a workspace folder is open");
    return folders![0].uri;
}

/** Which editor kinds currently hold `uri`. */
function tabKinds(uri: vscode.Uri): { text: number; custom: number } {
    let text = 0;
    let custom = 0;
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText
                && input.uri.toString() === uri.toString()) { text++; } else if (input instanceof vscode.TabInputCustom
                && input.uri.toString() === uri.toString()) { custom++; }
        }
    }
    return { text, custom };
}

describe("Birta integration: every supported format opens in the editor", () => {
    it("opening a file of any supported extension as text should swap it to the rendered editor", async function () {
        this.timeout(120_000);

        // The swap only runs under the shipped default; say so rather than
        // depending on whatever the test workspace happens to carry.
        const mode = vscode.workspace.getConfiguration("birta").get("defaultMode");
        assert.strictEqual(mode, "preview", "the swap under test only runs in preview mode");

        const extensions = selectorExtensions();
        assert.ok(extensions.length >= 3, "formats enumerated");
        const results: Record<string, { text: number; custom: number }> = {};

        for (const ext of extensions) {
            const uri = vscode.Uri.joinPath(workspaceUri(), `reach-check.${ext}`);
            await vscode.workspace.fs.writeFile(
                uri, Buffer.from(`# Reach ${ext}\n\nBody.\n`, "utf8"),
            );
            // Open it the way the explorer does, as a text editor, and let the
            // swap listener see it. The file is CLEAN, which is the state the
            // swap acts on.
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
            await wait(2500);

            results[ext] = tabKinds(uri);

            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            await wait(400);
        }

        const summary = JSON.stringify(results);
        console.log("format reach:", summary);
        for (const ext of extensions) {
            assert.strictEqual(
                results[ext]!.custom, 1,
                `.${ext} did not open in the rendered editor; reach: ${summary}`,
            );
            assert.strictEqual(
                results[ext]!.text, 0,
                `.${ext} was left in the raw text editor as well; reach: ${summary}`,
            );
        }
    });
});
