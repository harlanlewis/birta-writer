/**
 * One declaration of the Node the TOOLING runs on, and every workflow reads it.
 *
 * Three Node versions are in play in this repo and only two of them were ever
 * written down. `engines.vscode` fixes the extension host's, and AGENTS.md
 * pins `@types/node` to it. The Mac app has none. The third, the one the CI
 * runner and a contributor's shell use to run esbuild, Vitest and the scripts,
 * answered to nothing: the workflows each carried their own `node-version`, and
 * a contributor's shell carried whatever it happened to have.
 *
 * That gap is not theoretical. It is how a shell sits below a floor a
 * dependency needs and nothing says so, which is the failure direction that
 * stays quiet: too-old Node refuses APIs that are really there, and the cost is
 * a workaround nobody knew was unnecessary.
 *
 * `.nvmrc` is the declaration and `node-version-file` is how the workflows read
 * it, so the runner and the shell cannot disagree. This guard is what keeps a
 * new workflow, or a hand-edited old one, from reintroducing a second answer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const WORKFLOW_DIR = resolve(ROOT, ".github/workflows");

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

function read(file: string): string {
    return readFileSync(resolve(WORKFLOW_DIR, file), "utf8");
}

describe(".nvmrc", () => {
    it("should declare a concrete Node version rather than a floating major", () => {
        // Arrange
        const declared = readFileSync(resolve(ROOT, ".nvmrc"), "utf8").trim();
        // Assert: a bare `22` resolves to whatever 22.x a machine already has,
        // which is exactly the stale-shell case this file exists to close.
        expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

describe("workflow Node version", () => {
    it("should have found the workflows it claims to check", () => {
        // A guard that enumerated nothing passes forever, so the corpus is
        // asserted before anything is concluded from it.
        expect(workflowFiles.length).toBeGreaterThanOrEqual(6);
    });

    it("every setup-node step should read .nvmrc, counted rather than sampled", () => {
        // Arrange
        const setupNodeUsers = workflowFiles.filter((f) => read(f).includes("actions/setup-node"));
        expect(setupNodeUsers.length).toBeGreaterThan(0);
        // Assert per STEP, not per file. A file-level "does it mention .nvmrc"
        // passes when three of its four jobs read the file and the fourth
        // hardcodes, which is the shape a hand edit actually produces.
        for (const file of setupNodeUsers) {
            const source = read(file);
            const steps = source.match(/actions\/setup-node/g)?.length ?? 0;
            const reads = source.match(/^\s*node-version-file: \.nvmrc$/gm)?.length ?? 0;
            expect(reads, `${file}: ${steps} setup-node steps but ${reads} read .nvmrc`).toBe(steps);
        }
    });

    it("no workflow should hardcode a Node version beside the declaration", () => {
        // Arrange / Act
        const offenders = workflowFiles.filter((f) => /^\s*node-version:/m.test(read(f)));
        // Assert: `node-version:` and `node-version-file:` are different keys,
        // and setup-node honours the former, so one left behind silently wins
        // over `.nvmrc` in that job alone.
        expect(offenders).toEqual([]);
    });
});
