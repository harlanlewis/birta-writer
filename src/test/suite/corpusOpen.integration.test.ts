/**
 * Real-VS-Code corpus open: a real-shaped document — wide tables, HTML-labeled
 * mermaid, 900-char lines, and one DELIBERATELY INVALID diagram — opens in the
 * real custom editor, paints, and the webview keeps answering afterwards.
 *
 * This is the release-blocking form of the e2e/corpus suite: same document
 * (webview/__tests__/fixtures/mixed-real-document.md), but through the real
 * Extension Host, the real IPC hop, the real CSP, and whichever VS Code build
 * BIRTA_ITEST_VSCODE selected. The motivating failure froze the webview's main
 * thread about a second AFTER first paint (the lazily loaded mermaid chunk
 * had to arrive before the broken render loop could start), which is why this
 * test keeps polling the live `birta._test.getPerfMarks` round trip for
 * several seconds after paint instead of declaring victory at the paint mark:
 * a frozen webview never answers the next poll, the poll loop stops
 * completing, and the Mocha timeout converts that silence into a failure.
 */
import * as assert from "assert";
import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long the webview must keep answering after paint. The motivating
 *  freeze began ~1 s after paint; 8 s covers slow chunk loads on CI. */
const LIVENESS_WINDOW_MS = 8000;
const LIVENESS_POLL_MS = 500;

function workspaceUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "a workspace folder is open");
    return folders![0].uri;
}

describe("Birta integration: a real-shaped document opens and stays alive", () => {
    it("mixed-real-document.md (invalid mermaid included) should paint and keep answering", async function () {
        this.timeout(60000);

        // __dirname is out/test/suite at runtime; the fixture lives in the
        // extension development tree three levels up.
        const fixture = path.resolve(
            __dirname, "../../..", "webview", "__tests__", "fixtures", "mixed-real-document.md",
        );
        const content = await fs.readFile(fixture, "utf8");
        assert.ok(content.includes("```mermaid"), "fixture still carries its mermaid blocks");

        const uri = vscode.Uri.joinPath(workspaceUri(), "corpus-open.md");
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
        await vscode.commands.executeCommand("vscode.openWith", uri, "birta.editor");

        // Paint first: poll until the webview stamps editor-painted.
        const paintDeadline = Date.now() + 20000;
        let painted = false;
        while (Date.now() < paintDeadline && !painted) {
            const marks = await vscode.commands.executeCommand<Record<string, number>>(
                "birta._test.getPerfMarks",
            );
            painted = marks?.["editor-painted"] != null;
            if (!painted) { await wait(150); }
        }
        assert.ok(painted, "editor painted the real-shaped document");

        // Then liveness: every poll is a full extension-host → webview → back
        // round trip, so each completed iteration proves the webview main
        // thread escaped whatever the previous 500 ms scheduled on it. A
        // wedged webview stops answering and the test dies on its timeout —
        // which is the assertion.
        const until = Date.now() + LIVENESS_WINDOW_MS;
        let polls = 0;
        while (Date.now() < until) {
            await vscode.commands.executeCommand("birta._test.getPerfMarks");
            polls += 1;
            await wait(LIVENESS_POLL_MS);
        }
        assert.ok(
            polls >= LIVENESS_WINDOW_MS / LIVENESS_POLL_MS / 2,
            `webview answered throughout the liveness window (${polls} polls)`,
        );
    });
});
