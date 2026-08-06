/**
 * Release-blocking form of the e2e/corpus suite: the real-shaped fixture
 * (invalid mermaid included) opens in the real custom editor on whichever
 * VS Code BIRTA_ITEST_VSCODE selected, paints, and keeps answering. The
 * motivating freeze started ~1s AFTER paint (lazy mermaid chunk), so the test
 * polls getPerfMarks past that window. The provider resolves a poll with `{}`
 * after its own 3s timeout when the webview never replies, so liveness is
 * counted in ANSWERED polls (marks present), not completed calls.
 */
import * as assert from "assert";
import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long the webview must keep answering after paint. The motivating
 *  freeze began ~1 s after paint; 10 s covers slow chunk loads on CI. */
const LIVENESS_WINDOW_MS = 10000;
const LIVENESS_POLL_MS = 500;
/** A frozen webview answers ~2 polls before the freeze; a healthy one on a
 *  slow runner (500 ms per command round trip) still clears 10. */
const MIN_ANSWERED_POLLS = 8;

function workspaceUri(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "a workspace folder is open");
    return folders![0].uri;
}

describe("Birta integration: a real-shaped document opens and stays alive", () => {
    it("mixed-real-document.md (invalid mermaid included) should paint and keep answering", async function () {
        this.timeout(60000);

        // __dirname at runtime is out/test/suite; the repo root is ../../..
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

        // Each poll is a full host→webview→back round trip. A wedged webview
        // makes the provider's 3s timeout return `{}` — an UNANSWERED poll.
        const until = Date.now() + LIVENESS_WINDOW_MS;
        let answered = 0;
        while (Date.now() < until) {
            const marks = await vscode.commands.executeCommand<Record<string, number>>(
                "birta._test.getPerfMarks",
            );
            if (marks?.["editor-painted"] != null) { answered += 1; }
            await wait(LIVENESS_POLL_MS);
        }
        assert.ok(
            answered >= MIN_ANSWERED_POLLS,
            `webview answered throughout the liveness window (${answered} answered polls)`,
        );
    });
});
