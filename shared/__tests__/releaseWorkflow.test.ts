/**
 * Guards that the release workflow is still WIRED to the things that make a
 * release correct — not that they exist somewhere in the repo (MAR-282).
 *
 * This repo has shipped guards attached to nothing before, which is the failure
 * mode these assertions are shaped around: a stamper that exists but is not
 * invoked leaves the Marketplace Changelog tab exactly as stale as it was, and
 * the suite stays green either way.
 *
 * The load-bearing one is the LAST test. The release guard decides whether to
 * cut a release at all, and it must ignore the job's own stamp commits or the
 * nightly cuts an empty release every night forever, each one stamping another
 * heading. That guard and the commit it filters are two strings, in two steps,
 * roughly 150 lines apart. Editing either alone reintroduces the loop, so the
 * test checks the pattern against the message rather than checking that each
 * looks plausible on its own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const workflow = readFileSync(
    path.resolve(__dirname, "..", "..", ".github", "workflows", "release.yml"),
    "utf8",
);

/** Line index of the step whose `name:` matches, for ordering assertions. */
function stepLine(name: string): number {
    const lines = workflow.split("\n");
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    expect(at, `no step named "${name}" in release.yml`).toBeGreaterThan(-1);
    return at;
}

describe("release.yml", () => {
    it("the changelog stamper should be invoked before the extension is packaged", () => {
        // Stamping after packaging would ship the unstamped file — the exact
        // bug — while looking, in a diff, like the fix had landed.
        expect(workflow).toContain("node scripts/stamp-changelog.mjs");
        expect(stepLine("Stamp CHANGELOG.md to the release version")).toBeLessThan(
            stepLine("Package extension"),
        );
    });

    it("the release notes should be generated after the stamp, not before", () => {
        // The generator reads `## [<version>]`, which only exists post-stamp;
        // reversed, it silently falls back to [Unreleased] and re-announces
        // every entry ever written.
        expect(stepLine("Stamp CHANGELOG.md to the release version")).toBeLessThan(
            stepLine("Generate release notes"),
        );
    });

    it("the commit being released should be verified before it is packaged", () => {
        // MAR-265: `vsce package` runs a build and nothing else, so without
        // this the nightly can cut a VSIX from a red main.
        expect(workflow).toMatch(/run: pnpm typecheck && pnpm test/);
        expect(stepLine("Verify the commit being released")).toBeLessThan(
            stepLine("Package extension"),
        );
    });

    it("the stamp commit should be pushed only after the release is published", () => {
        // It must never be able to fail a release that already shipped, so the
        // step has to be both LAST and non-fatal. Check continue-on-error
        // inside this step's own block — asserting it appears anywhere in the
        // file would pass on a continue-on-error belonging to another step.
        const commitAt = stepLine("Commit the stamped changelog to main");
        expect(commitAt).toBeGreaterThan(stepLine("Tag and create GitHub Release"));

        const block = workflow.split("\n").slice(commitAt, commitAt + 6).join("\n");
        expect(block).toMatch(/continue-on-error: true/);
    });

    it("the release guard's exclusion should match the stamp commit's subject", () => {
        const pattern = /--invert-grep --grep='([^']+)'/.exec(workflow)?.[1];
        const subject = /git commit -m "([^"]+)"/.exec(workflow)?.[1];

        expect(pattern, "release.yml no longer excludes stamp commits from the count").toBeTruthy();
        expect(subject, "release.yml no longer commits the stamped changelog").toBeTruthy();

        // The subject carries a `${{ }}` expression; the pattern must match the
        // literal prefix regardless of what the version expands to.
        const rendered = subject!.replace(/\$\{\{[^}]+\}\}/g, "2026.805.0");
        expect(new RegExp(pattern!).test(rendered)).toBe(true);
    });
});
