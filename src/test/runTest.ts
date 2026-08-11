/**
 * Integration-test entry: downloads a pinned VS Code, launches it with THIS
 * extension loaded from the working tree (dist/extension.js) and runs the Mocha
 * suite inside the real Extension Host. This is the only layer that can exercise
 * VS Code behaviors the unit tests mock — onWillSaveTextDocument, waitUntil
 * edits reaching disk, the custom-editor open/save cycle with a live webview.
 *
 * Everything runs in an isolated, disposable temp dir (workspace + user profile
 * + extensions), so a run never touches the user's real VS Code state.
 *
 * THE TEST WINDOW MUST BE VISIBLE. Two tests gate on `editor-painted`, a mark
 * stamped from requestAnimationFrame (corpusOpen, launchPerf), and an occluded
 * or off-display window gets no frames: they go red on ANY VS Code version
 * while every other test stays green, which reads exactly like a real
 * regression. An unattended run on a locked or otherwise-occupied display can
 * also fabricate focus-sensitive failures. Before attributing a local red to a
 * tree or a VS Code build, re-run with the window raised once during the first
 * minute; CI is unaffected (its display server always paints). MAR-353 is the
 * worked example: a version-change diagnosis that dissolved under
 * window-controlled reruns.
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
            // BIRTA_ITEST_VSCODE selects the build under test; the release
            // job runs the engines floor and stable (nothing else ever
            // launches the floor). The old 1.130.0 pin (MAR-257) retired
            // with the @vscode/test-electron 3.1 upgrade.
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
