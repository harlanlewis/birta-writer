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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The publish jobs, comments stripped BEFORE chunking. Stripping is what keeps
 * these assertions about the workflow rather than its prose: the comment block
 * introducing a job would otherwise land in the PREVIOUS job's chunk, and a
 * phrase like "vsce package" inside a comment would trip a matcher meant for a
 * run: line.
 */
function publishJobs(): Array<{ name: string; body: string }> {
    const stripped = workflow
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
    const jobs = stripped
        .split(/^  (?=\w[\w-]*:$)/m)
        .filter((j) => /^publish/.test(j))
        .map((j) => ({ name: j.slice(0, j.indexOf(":")), body: j }));
    expect(jobs.length, "no publish jobs found in release.yml").toBeGreaterThan(1);
    return jobs;
}

/** A step's `run:` script, dedented out of the YAML block scalar. */
function runScript(name: string): string {
    const lines = workflow.split("\n").slice(stepLine(name) + 1);
    const at = lines.findIndex((l) => /^\s*run: \|/.test(l));
    expect(at, `step "${name}" has no run: | block`).toBeGreaterThan(-1);

    const body = lines.slice(at + 1);
    const indent = /^ */.exec(body[0])![0];
    const end = body.findIndex((l) => l.trim() !== "" && !l.startsWith(indent));
    return body
        .slice(0, end === -1 ? undefined : end)
        .map((l) => l.slice(indent.length))
        .join("\n");
}

/**
 * The verification section the checksum step appends, produced by RUNNING that
 * step rather than by re-reading its format strings. The bug this guards is a
 * shell semantic (a command substitution strips the trailing newline its
 * `printf` argument appeared to carry), so a test that re-implements `printf`
 * in TypeScript would be asserting the same belief that was wrong.
 *
 * `sha256sum` is GNU-only and absent on macOS, so the stub on PATH is what
 * keeps this runnable off CI; it also fixes the digest, which no assertion
 * here should depend on anyway.
 */
function renderChecksumNotes(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "birta-relnotes-"));
    try {
        mkdirSync(path.join(dir, "releases"));
        mkdirSync(path.join(dir, "bin"));
        writeFileSync(path.join(dir, "releases", "birta-writer-2026.805.0.vsix"), "vsix");
        writeFileSync(path.join(dir, "RELEASE_NOTES.md"), "## Birta Writer 2026.805.0\n");
        writeFileSync(
            path.join(dir, "bin", "sha256sum"),
            "#!/bin/sh\nprintf '%s  %s\\n' 0000000000000000 \"$1\"\n",
            { mode: 0o755 },
        );

        execFileSync("bash", ["-euo", "pipefail", "-c", runScript("Record the VSIX checksum")], {
            cwd: dir,
            env: {
                ...process.env,
                PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
                GITHUB_REPOSITORY: "harlanlewis/birta-writer",
            },
        });
        return readFileSync(path.join(dir, "RELEASE_NOTES.md"), "utf8");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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

    it("every publish job should upload the release job's artifact, never package its own", () => {
        // One build, one attestation, three destinations. `vsce package` stamps
        // each zip entry with the wall clock, so a job that packages for itself
        // ships an archive whose digest no attestation describes — and it looks
        // right in a diff, because the CONTENTS would be identical.
        for (const { name, body } of publishJobs()) {
            expect(body, `${name} does not download the release job's VSIX`).toContain(
                "actions/download-artifact",
            );
            expect(body, `${name} builds its own VSIX`).not.toMatch(/pnpm run package|vsce package/);
        }
    });

    it("each registry should publish behind its own dormancy guard", () => {
        // The two credentials fail independently, and a missing one must SKIP
        // rather than fail — that is what lets the repo add one registry at a
        // time. Keyed on the secret existing, so a broken credential still
        // fails loudly instead of quietly skipping.
        expect(workflow).toMatch(/HAS_AZURE: \$\{\{ secrets\.AZURE_CLIENT_ID != '' \}\}/);
        expect(workflow).toMatch(/HAS_OVSX: \$\{\{ secrets\.OVSX_PAT != '' \}\}/);
    });

    it("every step of a publish job should be gated on that job's own dormancy guard", () => {
        // The guard's DEFINITION is asserted above; this is its WIRING. A step
        // that drops its `if:` still leaves that test green, and then the
        // nightly hard-fails on the missing secret instead of skipping — the
        // guard-attached-to-nothing failure mode this file's header describes.
        for (const { name, body } of publishJobs()) {
            const guard = /HAS_\w+/.exec(body)?.[0];
            expect(guard, `${name} declares no HAS_* dormancy guard`).toBeTruthy();

            const lines = body.split("\n");
            const steps = lines.filter((l) => /^      - (name|uses):/.test(l)).length;
            const gated = lines.filter((l) => l.trim() === `if: env.${guard} == 'true'`).length;
            expect(steps, `${name} has no steps`).toBeGreaterThan(0);
            expect(gated, `${name}: ${steps} steps, ${gated} gated on ${guard}`).toBe(steps);
        }
    });

    it("the appended verification section should close every code fence on its own line", () => {
        // A fence is only a fence at the start of a line, so a format string
        // that appends ``` straight after a `%s` renders the closing fence as
        // literal text and swallows the block. The trap is that the argument
        // looks like it carries the newline: `$(cat …)` strips it.
        const notes = renderChecksumNotes();
        const fenced = notes.split("\n").filter((l) => l.includes("```"));

        expect(fenced.length, `no fenced block in:\n${notes}`).toBeGreaterThan(0);
        expect(fenced.length % 2, `unbalanced fences in:\n${notes}`).toBe(0);
        for (const line of fenced) {
            expect(line.trim(), `fence not alone on its line:\n${notes}`).toBe("```");
        }
    });

    it("the verification section should be appended to the generated notes, not replace them", () => {
        // The step redirects into the file the generator already wrote, so a
        // `>` where `>>` belongs would drop every entry of the release and
        // leave a body that still looks well formed.
        const notes = renderChecksumNotes();

        expect(notes.startsWith("## Birta Writer 2026.805.0\n")).toBe(true);
        expect(notes).toContain("### Verifying this release");
        expect(notes).toMatch(/0000000000000000 {2}birta-writer-2026\.805\.0\.vsix/);
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
