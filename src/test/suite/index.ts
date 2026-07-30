/**
 * Mocha bootstrap, loaded inside the Extension Host by runTest.ts. Discovers and
 * runs every compiled `*.test.js` in this directory.
 */
import * as path from "path";
import { promises as fs } from "fs";
import Mocha from "mocha";

export async function run(): Promise<void> {
    const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60_000 });
    const testsRoot = __dirname;

    // `BIRTA_ITEST_ONLY=<substring>` runs just the matching file(s). The whole
    // suite boots a real VS Code and takes minutes, most of it in tests that
    // deliberately wait seconds for a webview; iterating on one file is the
    // difference between a 3-second loop and a 7-minute one.
    const only = process.env["BIRTA_ITEST_ONLY"];
    const files = (await fs.readdir(testsRoot))
        .filter((f) => f.endsWith(".test.js") && (!only || f.includes(only)));
    for (const f of files) {
        mocha.addFile(path.resolve(testsRoot, f));
    }

    await new Promise<void>((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} integration test(s) failed.`));
            } else {
                resolve();
            }
        });
    });
}
