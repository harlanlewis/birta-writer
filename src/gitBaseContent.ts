/**
 * src/gitBaseContent.ts - the left-hand side of the rendered diff (MAR-55).
 *
 * Resolving "what did this file look like at HEAD" is two `git` calls and a
 * path normalization, and every interesting case is a failure case, so the
 * resolution is separated from the spawning: `resolveBaseContent` takes the
 * runner as a parameter and is exercised against fakes, `runGit` is the one
 * function that touches a process.
 *
 * We shell out rather than going through the built-in git extension's exported
 * API. That API would hand us repository discovery for free, but it ships no
 * types, so consuming it means either vendoring a copy of its `.d.ts` or
 * casting through `any` at exactly the boundary where a silent shape drift
 * costs the most. Two plumbing commands with an injected runner is less code
 * and is checkable here. The cost is a dependency on `git` being on PATH,
 * which `unavailable` reports rather than swallows.
 *
 * Nothing here reaches the network: `rev-parse` and `show` read the local
 * object store only, so this stays outside the consent ladder in
 * docs/NETWORK_POSTURE.md.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import type { DiffBaseOrigin } from "../shared/diffMessages";

/** A git invocation that resolves to stdout, or rejects for any failure. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** A file this big at HEAD is not a document anyone is reviewing rendered. */
const MAX_BASE_BYTES = 8 * 1024 * 1024;
/** Git that has not answered by now is wedged; the panel says so rather than hanging. */
const GIT_TIMEOUT_MS = 5000;

export type BaseContent =
    /** The file's bytes at HEAD, or the empty base of a file HEAD has never seen. */
    | { ok: true; text: string; origin: DiffBaseOrigin }
    /** No comparison is possible; `reason` is shown to the user verbatim. */
    | { ok: false; reason: string };

/** Run `git args...` in `cwd`, resolving stdout and rejecting on any failure. */
export const runGit: GitRunner = (args, cwd) =>
    new Promise((resolve, reject) => {
        execFile(
            "git",
            [...args],
            { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BASE_BYTES, windowsHide: true },
            (error, stdout) => {
                if (error) { reject(error); return; }
                resolve(stdout);
            },
        );
    });

/**
 * The file's content at HEAD.
 *
 * Three outcomes, and the middle one is the one worth naming: a file inside a
 * repository that HEAD does not contain (newly added, or the repository has no
 * commits yet) has an empty base rather than an error, because "every line is
 * new" is the honest diff for a new file. Only a file that is in no repository
 * at all, or a git that will not run, is unavailable.
 */
export async function resolveBaseContent(
    fsPath: string,
    run: GitRunner = runGit,
): Promise<BaseContent> {
    const dir = path.dirname(fsPath);

    let root: string;
    try {
        root = (await run(["rev-parse", "--show-toplevel"], dir)).trim();
    } catch {
        return { ok: false, reason: "This file is not in a git repository." };
    }
    if (root === "") {
        return { ok: false, reason: "This file is not in a git repository." };
    }

    const relative = repoRelativePath(root, fsPath);
    if (relative === null) {
        return { ok: false, reason: "This file is not in a git repository." };
    }

    try {
        return { ok: true, text: await run(["show", `HEAD:${relative}`], root), origin: "head" };
    } catch {
        // `git show` fails identically for "not in HEAD" and "no commits yet",
        // and both mean the same thing to a reader: there is no earlier version.
        return { ok: true, text: "", origin: "untracked" };
    }
}

/**
 * The path `git show HEAD:<path>` wants: posix-separated and relative to the
 * repository root. Returns null when the file is not under that root, which is
 * how a stale or unrelated `rev-parse` answer stops before asking git for a
 * path it would resolve somewhere else.
 */
export function repoRelativePath(root: string, fsPath: string): string | null {
    const relative = path.relative(root, fsPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return null;
    }
    return relative.split(path.sep).join("/");
}
