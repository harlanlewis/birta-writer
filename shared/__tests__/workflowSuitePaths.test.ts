/**
 * A workflow that names e2e suites names them twice, and the two lists agree.
 *
 * `mac-app.yml` runs four suites in WebKit by name, and its `paths` filter
 * lists the same four directories so the job fires when one of them changes.
 * Nothing related the two, and drift is green in BOTH directions, which is
 * what makes it worth a test rather than care:
 *
 *   A suite added to the run list and not to `paths` still runs, but the job
 *   no longer fires on changes to that suite alone. It is covered incidentally
 *   by the broad source entries (`webview/**`, `shared/**`) and not by its own,
 *   so editing only the suite skips the job that exists to run it.
 *
 *   A directory added to `paths` and not to the run list fires the job on
 *   every change to it and never runs it. The check is green and reports on
 *   nothing.
 *
 * Neither shows up as a failure anywhere, which is the shape AGENTS.md names
 * about a guard that is ABSENT rather than wrong: no run reports a coverage of
 * zero, and auditing the checks you have never finds it.
 *
 * Derived from the workflow files rather than written here, so a second
 * workflow that starts naming suites is covered the day it lands, and the
 * counts are asserted because a sweep that reaches nothing passes every check
 * it never ran. `workflowTimeouts.test.ts` is the pattern.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const workflowDir = path.resolve(__dirname, "../../.github/workflows");
const repoRoot = path.resolve(__dirname, "../..");

const workflows = readdirSync(workflowDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((file) => ({ file, text: readFileSync(path.join(workflowDir, file), "utf8") }));

/** Suite names in `paths:` entries of the shape `e2e/<name>/**`. */
function pathsEntries(text: string): string[] {
    return [...text.matchAll(/^\s*-\s*['"]?e2e\/([A-Za-z0-9_-]+)\/\*\*['"]?\s*$/gm)]
        .map((m) => m[1]!);
}

/**
 * Suite names passed to `e2e/run.mjs`.
 *
 * Deliberately does not match a bare `node e2e/run.mjs` with no argument,
 * which is the whole sweep rather than a named suite and has nothing to pair
 * with. The capture requires a name on the same line.
 */
function invokedSuites(text: string): string[] {
    return [...text.matchAll(/node\s+e2e\/run\.mjs\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

const naming = workflows
    .map(({ file, text }) => ({ file, paths: pathsEntries(text), invoked: invokedSuites(text) }))
    .filter((w) => w.paths.length > 0 || w.invoked.length > 0);

describe("workflows that name e2e suites", () => {
    // The sweep reached a workflow that actually names suites. Without this,
    // every comparison below is over an empty list: a renamed workflow
    // directory, or a regex that stopped matching, reads as total agreement.
    it("should have found at least one workflow naming suites", () => {
        expect(naming.length, "no workflow names an e2e suite; the sweep found nothing")
            .toBeGreaterThan(0);
        const total = naming.reduce((n, w) => n + w.invoked.length, 0);
        expect(total, "no workflow invokes a named suite; the invocation regex found nothing")
            .toBeGreaterThan(0);
    });

    // Asked only of workflows that RUN named suites, and the exclusion is a
    // finding rather than a convenience. `typing-perf.yml` lists `e2e/perf/**`
    // because the perf HARNESS lives there, and it invokes no suite at all: it
    // runs `pnpm perf:typing:ab`. So a paths entry under `e2e/` means "this
    // code changes my answer", not "this is a suite I run", and the first
    // draft of this guard read the second and failed on a correct workflow.
    //
    // That is the same mistake, in the same week, that the declarer walk made
    // by reading `default-src 'none'` as "stands in for a host" when it means
    // "is under a policy". Both times a predicate borrowed a signal that
    // usually coincides with what it wanted and does not always.
    it.each(naming.filter((w) => w.invoked.length > 0).map((w) => [w.file, w] as const))(
        "%s should run every suite its paths filter names",
        (file, w) => {
            const unrun = w.paths.filter((name) => !w.invoked.includes(name));
            expect(unrun,
                `${file} fires on changes to these suites and never runs them: ${unrun.join(", ")}. ` +
                "Either invoke them, or drop the paths entry.").toEqual([]);
        },
    );

    it.each(naming.map((w) => [w.file, w] as const))(
        "%s should fire on changes to every suite it runs",
        (file, w) => {
            const untriggered = w.invoked.filter((name) => !w.paths.includes(name));
            expect(untriggered,
                `${file} runs these suites but does not list them in paths: ${untriggered.join(", ")}. ` +
                "Editing only such a suite skips the job that exists to run it.").toEqual([]);
        },
    );

    // Both lists can agree with each other and point at nothing. A rename
    // leaves `run.mjs` exiting 2 with "no suite named", which is at least
    // loud; the paths entry just stops matching, silently, forever.
    it.each(naming.map((w) => [w.file, w] as const))(
        "%s should name suites that exist",
        (file, w) => {
            const missing = [...new Set([...w.paths, ...w.invoked])]
                .filter((name) => !existsSync(path.join(repoRoot, "e2e", name, "checks.mjs")));
            expect(missing,
                `${file} names suites with no e2e/<name>/checks.mjs: ${missing.join(", ")}`)
                .toEqual([]);
        },
    );
});
