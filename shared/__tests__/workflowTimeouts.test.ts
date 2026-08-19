/**
 * Every CI job is bounded in time.
 *
 * Without `timeout-minutes` a job inherits GitHub's default of six hours, and a
 * wedged step then holds a REQUIRED check open for that long. A required check
 * that cannot fail cannot be re-run either, so from the PR it is
 * indistinguishable from a queue. That happened on `launch-perf`, wedged on a
 * third-party browser download it does not control (#364).
 *
 * The list of jobs is derived from the workflow files rather than written here,
 * so a new job or a new workflow is covered the day it lands. The counts are
 * asserted too: a sweep that reaches nothing passes every check it never ran.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(__dirname, "../../.github/workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

/**
 * The jobs in one workflow, as name plus the block beneath it. Job keys are the
 * only two-space mapping keys after `jobs:`; everything inside a job is
 * indented four or more, and the `on:` block that shares that indentation sits
 * above `jobs:` and is skipped with it.
 */
function jobsIn(text: string): { name: string; body: string }[] {
    const lines = text.split("\n");
    const start = lines.indexOf("jobs:");
    if (start === -1) { return []; }
    const jobs: { name: string; body: string[] }[] = [];
    for (const line of lines.slice(start + 1)) {
        const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (key) { jobs.push({ name: key[1]!, body: [] }); }
        else if (jobs.length) { jobs[jobs.length - 1]!.body.push(line); }
    }
    return jobs.map((j) => ({ name: j.name, body: j.body.join("\n") }));
}

describe("workflow job timeouts", () => {
    it("every job in every workflow should declare a timeout-minutes", () => {
        const missing: string[] = [];
        let seen = 0;
        for (const file of files) {
            for (const job of jobsIn(readFileSync(path.join(dir, file), "utf8"))) {
                seen++;
                if (!/^ {4}timeout-minutes: \d+$/m.test(job.body)) { missing.push(`${file}:${job.name}`); }
            }
        }
        expect(missing, `jobs with no timeout-minutes: ${missing.join(", ")}`).toEqual([]);
        // The instrument has to have reached something. A parser that silently
        // matched no jobs would report a clean sweep having checked none.
        expect(seen).toBeGreaterThanOrEqual(9);
    });

    it("the sweep should reach every workflow file", () => {
        expect(files.length).toBeGreaterThanOrEqual(5);
        // Each file must parse into at least one job, or the shape it is parsed
        // with has drifted and the check above passes over an unread file.
        for (const file of files) {
            expect(jobsIn(readFileSync(path.join(dir, file), "utf8")).length,
                `${file} parsed into no jobs`).toBeGreaterThan(0);
        }
    });
});
