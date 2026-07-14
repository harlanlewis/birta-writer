/**
 * Integration-test entry: downloads a pinned VS Code, launches it with THIS
 * extension loaded from the working tree (dist/extension.js) and runs the Mocha
 * suite inside the real Extension Host. This is the only layer that can exercise
 * VS Code behaviors the unit tests mock — onWillSaveTextDocument, waitUntil
 * edits reaching disk, the custom-editor open/save cycle with a live webview.
 *
 * Everything runs in an isolated, disposable temp dir (workspace + user profile
 * + extensions), so a run never touches the user's real VS Code state.
 */
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "birta-itest-"));
    const workspace = path.join(tmp, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspace,
                "--user-data-dir", path.join(tmp, "user-data"),
                "--extensions-dir", path.join(tmp, "extensions"),
                "--skip-welcome",
                "--skip-release-notes",
                "--disable-workspace-trust",
            ],
        });
    } catch (err) {
        console.error("Integration tests failed:", err);
        process.exit(1);
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
}

void main();
