/**
 * Resolving the left-hand side of the rendered diff (MAR-55).
 *
 * The interesting assertion here is not what comes back, it is what was ASKED.
 * `git show` will happily answer a differently-shaped question - an absolute
 * path run from the wrong directory resolves for most repositories, and a
 * backslashed path resolves for none - and in both cases a test that only
 * checked the returned text would stay green while the panel showed the wrong
 * file or no file. So the fake runner records every invocation and the
 * assertions are about the argv and the cwd.
 *
 * The other half is that two failures mean different things. A repository that
 * does not exist is unavailable; a file the repository has never committed is
 * an EMPTY base, because "every line is new" is the honest diff for a new file
 * and reporting it as an error would hide a working feature behind a message.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { repoRelativePath, resolveBaseContent, type GitRunner } from "../gitBaseContent";

const ROOT = path.join(path.sep, "repo");
const FILE = path.join(ROOT, "docs", "notes.md");

/** A runner that records its calls and answers from a table. */
function fakeGit(answers: {
    toplevel?: string | Error;
    show?: string | Error;
}): GitRunner & { calls: Array<{ args: readonly string[]; cwd: string }> } {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const run = ((args, cwd) => {
        calls.push({ args, cwd });
        const answer = args[0] === "rev-parse" ? answers.toplevel : answers.show;
        return answer instanceof Error || answer === undefined
            ? Promise.reject(answer ?? new Error("not stubbed"))
            : Promise.resolve(answer);
    }) as GitRunner & { calls: typeof calls };
    run.calls = calls;
    return run;
}

describe("resolveBaseContent", () => {
    it("a file inside a repository should be asked for by its repo-relative path, from the repo root", async () => {
        const run = fakeGit({ toplevel: `${ROOT}\n`, show: "# Notes\n" });
        const result = await resolveBaseContent(FILE, run);

        expect(result).toEqual({ ok: true, text: "# Notes\n", origin: "head" });
        // The question, not just the answer: a posix path relative to the
        // root, resolved from the root itself.
        expect(run.calls[1].args).toEqual(["show", "HEAD:docs/notes.md"]);
        expect(run.calls[1].cwd).toBe(ROOT);
        // And the discovery ran from the file's own directory, which is what
        // makes it find the nested repository rather than an outer one.
        expect(run.calls[0]).toEqual({
            args: ["rev-parse", "--show-toplevel"],
            cwd: path.dirname(FILE),
        });
    });

    it("a file the repository has no commit for should resolve to an empty untracked base", async () => {
        const run = fakeGit({ toplevel: ROOT, show: new Error("path does not exist in HEAD") });
        await expect(resolveBaseContent(FILE, run)).resolves.toEqual({
            ok: true,
            text: "",
            origin: "untracked",
        });
    });

    it("a file in no repository should be unavailable and should never reach git show", async () => {
        const run = fakeGit({ toplevel: new Error("not a git repository") });
        const result = await resolveBaseContent(FILE, run);

        expect(result.ok).toBe(false);
        expect(run.calls.map((c) => c.args[0])).toEqual(["rev-parse"]);
    });

    it("a rev-parse answering with an unrelated root should not be asked about the file", async () => {
        // The guard that stops a stale or wrong toplevel turning into a
        // `HEAD:../../..` question git would resolve somewhere else entirely.
        const run = fakeGit({ toplevel: path.join(path.sep, "elsewhere"), show: "leaked" });
        const result = await resolveBaseContent(FILE, run);

        expect(result.ok).toBe(false);
        expect(run.calls.map((c) => c.args[0])).toEqual(["rev-parse"]);
    });

    it("an empty toplevel should be unavailable rather than a repository at the filesystem root", async () => {
        const run = fakeGit({ toplevel: "\n", show: "leaked" });
        expect((await resolveBaseContent(FILE, run)).ok).toBe(false);
    });
});

describe("repoRelativePath", () => {
    it("a nested file should come back posix-separated whatever the platform separator is", () => {
        expect(repoRelativePath(ROOT, FILE)).toBe("docs/notes.md");
        expect(repoRelativePath(ROOT, path.join(ROOT, "top.md"))).toBe("top.md");
    });

    it("a path outside the root, or the root itself, should be refused", () => {
        expect(repoRelativePath(ROOT, path.join(path.sep, "other", "x.md"))).toBeNull();
        expect(repoRelativePath(ROOT, ROOT)).toBeNull();
    });
});
