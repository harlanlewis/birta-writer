/**
 * Every surface that serves the editor page under a content-security-policy,
 * discovered rather than listed.
 *
 * Two guards ask this question and used to answer it differently.
 * `workerCsp.test.ts` hand-listed seven files, so a harness page added after it
 * was written was a page it never learned about: unlisted means unchecked, and
 * unchecked is green. `cspDirectives.test.ts` walked for them. One walk is the
 * end state both wanted, and this is it.
 *
 * The absence that motivates it is the shape AGENTS.md names: a hand-written
 * list of cases is a list a new case never joins, so derive the enumeration and
 * let its own size be the assertion. It also stops concurrent branches from
 * breaking each other. A session adding a harness page no longer edits a guard
 * it never read, and neither branch fails on the other's growth, which is not
 * hypothetical: two sessions added a harness page each on the afternoon this
 * was written.
 *
 * Discovery has its own failure mode and the callers must close it. A walk that
 * finds nothing satisfies every comparison by having nothing to compare, so a
 * guard reading this owes a floor: assert the shipped hosts are present by
 * name, and assert the harness pages are more than a handful. `assertReached`
 * is that floor, offered here so neither caller has to remember it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The repository root, from this file's own location. */
export const REPO_ROOT = join(__dirname, "..", "..");

/**
 * The two hosts that ship a policy. Neither is under `e2e/`, so neither is
 * discoverable by walking it, and both must be named.
 */
export const SHIPPED_HOSTS: readonly string[] = [
    "src/webviewHtml.ts",
    "mac/Sources/BirtaWriter/WebHost.swift",
];

/**
 * Pages that must not stop declaring a policy, each with the reason it would
 * matter, and a hand-written list on purpose.
 *
 * Discovery alone cannot see a SWAP. A floor counting eight declarers is
 * satisfied when one page joins and another leaves on the same day, same
 * count and a different set, and the one that left takes its suite's meaning
 * with it. So leaving has to require deleting a name here rather than
 * deleting a line in an HTML file.
 *
 * This is deliberately NOT the exhaustive declarer list that used to live in
 * `workerCsp.test.ts`, and the difference is the whole point. That list was
 * the only source, so a page it did not name was unchecked. This one is a
 * FLOOR: discovery still finds and holds every other declarer, and this says
 * only which ones may never quietly leave the set. A new declarer joins
 * without being added here.
 *
 * An exemption list was the other candidate and does not fit this tree: 93 of
 * the 99 harness pages carry no policy, because declaring one is the exception
 * and not the rule, so "declare a policy or name your exemption" would be a
 * 93-entry list nobody could read and every new suite would have to join.
 */
export const POLICY_REQUIRED: ReadonlyArray<[file: string, why: string]> = [
    ...SHIPPED_HOSTS.map((f) => [f, "a shipped surface"] as [string, string]),
    ["e2e/agentAttachPreview/index.html",
        "its whole check is whether a policy permits the composer's object URL; " +
        "on an unconstrained page that check passes whatever the extension grants"],
    ["e2e/verifyWorker/index.html",
        "its suite is the Blob worker starting under a policy that says default-src 'none'"],
    ["e2e/perf/index.html",
        "the launch measurement mirrors the shipped page, and a policy is part of what is measured"],
    ["e2e/corpus/index.html", "mirrors the shipped page for the round-trip corpus"],
    ["e2e/mdx/index.html", "mirrors the shipped page for the mdx format"],
    ["e2e/frameHost/editor.html", "the hosting contract in docs/HOSTING.md includes the policy"],
];

export interface CspDeclarer {
    /** Repo-relative path, used in assertion messages so a failure names it. */
    file: string;
    source: string;
}

/** Every `.html` under `e2e/`, repo-relative. */
function harnessPages(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(join(REPO_ROOT, dir))) {
            if (name.startsWith(".") || name === "node_modules") continue;
            const rel = `${dir}/${name}`;
            if (statSync(join(REPO_ROOT, rel)).isDirectory()) walk(rel);
            else if (name.endsWith(".html")) found.push(rel);
        }
    };
    walk("e2e");
    return found;
}

/**
 * The shipped hosts and every harness page that declares `default-src 'none'`.
 *
 * A harness page with no policy at all is not a declarer and is not judged;
 * `e2e/svgRender/index.html` is the deliberate one, and its own header says
 * why. Declaring `default-src 'none'` is what makes a page a mirror of the
 * shipped surfaces rather than merely a page that loads the bundle.
 */
export function cspDeclarers(): CspDeclarer[] {
    return [...SHIPPED_HOSTS, ...harnessPages()]
        .map((file) => ({ file, source: readFileSync(join(REPO_ROOT, file), "utf8") }))
        .filter(({ source }) => source.includes("default-src 'none'"));
}

/**
 * The floor every caller owes: discovery reached both halves of the tree.
 *
 * Without it a renamed directory or a broken walk produces an empty list, and
 * every assertion over that list passes by looking at nothing. Takes vitest's
 * `expect` rather than importing it, so this module stays a plain helper and
 * is not itself collected as a suite.
 */
export function assertReached(
    found: readonly CspDeclarer[],
    expect: (actual: unknown, message?: string) => {
        toContain(expected: unknown): void;
        toBeGreaterThan(n: number): void;
    },
): void {
    const files = found.map((d) => d.file);

    // Every page that may not leave silently is still here. This is the half
    // a count cannot do: a swap keeps the count and changes the set.
    for (const [file, why] of POLICY_REQUIRED) {
        expect(
            files,
            `${file} no longer declares a policy. It is required because ${why}. ` +
            "If that is deliberate, remove it from POLICY_REQUIRED in cspDeclarers.ts " +
            "and say why in the commit, rather than only deleting the policy.",
        ).toContain(file);
    }

    // And the walk reached the tree at all, which is the separate failure of
    // a renamed directory or a broken traversal.
    expect(
        files.filter((f) => f.startsWith("e2e/")).length,
        "no harness page declares a policy; the walk found nothing",
    ).toBeGreaterThan(3);
}
