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
            // BIRTA_ITEST_VSCODE selects the VS Code build under test. The
            // release job runs the suite twice — "1.95.0" (the engines floor,
            // which nothing else ever launches, so without this the floor is
            // an unverified claim) and "stable". Local default is stable.
            // History: this was pinned to 1.130.0 while
            // @vscode/test-electron@3.0.0 spawned a path 1.131.0's macOS
            // bundle stopped shipping (MAR-257); the 3.1 upgrade ended that.
            version: process.env.BIRTA_ITEST_VSCODE || "stable",
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
