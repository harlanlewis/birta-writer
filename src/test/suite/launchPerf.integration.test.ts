/**
 * Real-VS-Code launch measurement (MAR-191).
 *
 * Opens a document in the Birta custom editor inside a REAL VS Code Electron
 * host and reads the same `mdw:` launch marks the headless harness (e2e/perf.mjs)
 * reads — via the invisible `birta._test.getPerfMarks` command. This VALIDATES
 * that the headless proxy tracks reality: in particular the `roundtrip` span is
 * the REAL extension-host↔webview IPC here, which the headless stub fakes
 * synchronously (near-zero).
 *
 * It is NOT a timing gate — absolute ms in a real Electron app are machine- and
 * version-dependent — so it asserts only structure (marks present, spans sane)
 * and logs the numbers for the maintainer to compare against `pnpm perf`.
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

/**
 * Deterministic ~large document, structurally comparable to the headless `large`
 * fixture (~140 sections of heading + prose), so the real launch numbers are
 * read on a comparable workload.
 */
function largeDoc(sections = 140): string {
    const out: string[] = [];
    for (let i = 0; i < sections; i++) {
        out.push(
            `## Section ${i}`,
            "",
            `Paragraph ${i} with some **bold** and _italic_ text and a [link](https://example.com/${i}).`,
            "",
        );
    }
    return out.join("\n");
}

/** Poll the invisible test command until the webview has stamped `editor-painted`. */
async function readLaunchMarks(timeoutMs = 20000): Promise<Record<string, number> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const marks = await vscode.commands.executeCommand<Record<string, number>>("birta._test.getPerfMarks");
        if (marks && marks["editor-painted"] != null) { return marks; }
        await wait(150);
    }
    return null;
}

describe("Birta integration: real-VS-Code launch marks (MAR-191)", () => {
    it("reads mdw: launch marks from a live webview and reports the span breakdown", async function () {
        this.timeout(40000);
        const uri = await writeFixture("launch-large.md", largeDoc());
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");

        const marks = await readLaunchMarks();
        assert.ok(marks, "webview returned mdw: marks including editor-painted");

        const span = (a: string, b: string): number | null =>
            marks![a] != null && marks![b] != null ? marks![b] - marks![a] : null;
        const report = {
            launch: marks!["editor-painted"],
            eager: span("eval-start", "ready-posted"),
            roundtrip: span("ready-posted", "init-received"),
            create: span("create-start", "create-end"),
            toc: span("toc-start", "toc-end"),
            toolbar: span("toolbar-start", "toolbar-end"),
        };
        // Logged for the maintainer to compare against `pnpm perf` (headless).
        // The `roundtrip` value here is the REAL IPC hop the headless stub fakes.
        console.log("\n[MAR-191] real VS Code launch spans (ms):", JSON.stringify(report, null, 2));

        // Structural assertions only — CI-safe, never an absolute-time gate.
        assert.ok(report.launch > 0, `launch should be positive; got ${report.launch}`);
        assert.ok(report.create != null && report.create > 0, "create span present and positive");
        assert.ok(report.roundtrip != null && report.roundtrip >= 0, "real IPC roundtrip measured");
    });
});
