/**
 * Every harness entry point parses, and every one that should take the lock
 * takes it.
 *
 * Both halves exist because of the same miss. The lock was wired into four
 * runners in one pass and only one of them was ever executed: an import landed
 * INSIDE a multi-line `import { … } from` in two files, which is a syntax
 * error, and it reached CI. `pnpm test`, `pnpm typecheck` and the whole e2e
 * sweep were all green, because none of them loads a perf runner.
 *
 * These runners cannot simply be imported to test them — they drive Playwright
 * and call `process.exit` at module scope, which is why they are excluded from
 * Vitest in the first place. `node --check` parses without executing, which is
 * exactly the gap: it is the cheapest thing that would have caught it.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = dirname(fileURLToPath(import.meta.url));

/** Every runner in e2e/, plus the modules they pull in. */
const modules = readdirSync(e2eDir)
    .filter((f) => f.endsWith(".mjs"))
    .concat(readdirSync(join(e2eDir, "perf")).filter((f) => f.endsWith(".mjs")).map((f) => join("perf", f)));

/**
 * The runners that must refuse to start beside another harness, with the kind
 * each holds as (e2e/harnessLock.mjs, "The record, and the kinds"). Every
 * perf runner reads a timing, so every one is a capture; the e2e sweep is
 * held as one because its verdict is load-sensitive. The vitest end is the
 * one sweep, and it is in UNLOCKED below because it is not a runner.
 */
const LOCKED = {
    "run.mjs": "capture",
    "perf.mjs": "capture",
    "perf-typing.mjs": "capture",
    "perf-scroll.mjs": "capture",
    "perf-gesture.mjs": "capture",
    "perf-ab.mjs": "capture",
};

/**
 * Deliberately unlocked, each for a stated reason (AGENTS.md, "One harness at a
 * time"). Listed so that adding a runner is a decision rather than an omission.
 */
const UNLOCKED = {
    "perf-bundle.mjs": "browser-free byte count; contends with nothing",
    "perf-counts.mjs": "browser-free count check over a JSON another runner wrote; contends with nothing",
    "harnessLock.mjs": "the lock itself",
    "harnessLock.globalSetup.mjs": "vitest's end of the lock, exempt in watch mode",
};

describe("harness entry points", () => {
    for (const file of modules) {
        it(`${file} should parse`, () => {
            // --check parses without executing, which these cannot survive.
            expect(() => execFileSync("node", ["--check", join(e2eDir, file)], { stdio: "pipe" })).not.toThrow();
        });
    }

    for (const [file, kind] of Object.entries(LOCKED)) {
        it(`${file} should take the harness lock as a ${kind}`, () => {
            const src = readFileSync(join(e2eDir, file), "utf8");
            // The call carries its kind on the same statement, so a runner
            // that took the lock as nothing in particular is a red here rather
            // than a throw the first time somebody runs it.
            expect(src).toMatch(new RegExp(`acquireHarnessLock\\([^;]*\\{ kind: "${kind}" \\}\\);`));
        });
    }

    it("vitest's end should take the lock as a sweep", () => {
        const src = readFileSync(join(e2eDir, "harnessLock.globalSetup.mjs"), "utf8");
        expect(src).toMatch(/acquireHarnessLock\([^;]*\{ kind: "sweep" \}\);/);
    });

    it("every runner should either take the lock or be listed as exempt", () => {
        const runners = modules.filter((f) => !f.includes("/") && !f.endsWith(".test.mjs"));
        const unaccounted = runners.filter((f) => !(f in LOCKED) && !(f in UNLOCKED));
        expect(unaccounted).toEqual([]);
    });
});
