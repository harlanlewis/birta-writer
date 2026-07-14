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

    const files = (await fs.readdir(testsRoot)).filter((f) => f.endsWith(".test.js"));
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
