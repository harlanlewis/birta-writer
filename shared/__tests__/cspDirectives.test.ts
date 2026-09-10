/**
 * The scheme grants in `img-src`, across every surface that serves the editor
 * page under a policy.
 *
 * `workerCsp.test.ts` is the pattern and the reason it exists applies here
 * unchanged: a policy is written once per host, in a different language each
 * time, and a grant one host has and another lacks fails as a missing picture
 * rather than as an error. The Mac app granted `blob:` on `img-src` and the
 * extension did not, so the agent composer's attachment thumbnail drew on one
 * surface and showed an empty box on the other, for as long as both shipped.
 *
 * Nothing caught it, and the near miss is worth naming because it looked like
 * coverage. `macCsp.test.ts` compares the two policies' embed-HOST lists and
 * nothing else, so the directive heads those hosts hang off were free to
 * diverge with that suite green. It is named for the Mac app's CSP, which
 * reads as though it covers the policy; it covers the host lists. That is the
 * "a guard names what it reads" shape from AGENTS.md, wearing a broad name.
 *
 * The declarers are DISCOVERED rather than listed, and that is not a style
 * choice. `workerCsp.test.ts` hand-lists seven files, so a harness page added
 * after it was written is a page that guard never learned about, which is
 * AGENTS.md's own "a hand-written list of cases is a list a new case never
 * joins". It also stops two concurrent branches from breaking each other: a
 * session adding a harness page does not have to edit a guard it never read,
 * and whichever branch merges second does not fail on a list the other grew.
 * The floor below is what keeps discovery honest, because a walk that finds
 * nothing satisfies every comparison by having nothing to compare.
 *
 * Hosts are deliberately NOT compared, and that is not laziness. A harness
 * page that never renders an embed has no business granting the YouTube
 * thumbnail host, so host sets legitimately differ per page and
 * `macCsp.test.ts` owns the one pair where they must match. What may never
 * differ is the SCHEME vocabulary: `'self'`, `data:` and `blob:` are facts
 * about what kind of image the editor builds, and the editor is the same code
 * on every one of these pages.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/** The two hosts that ship. Neither is discoverable by walking `e2e/`. */
const SHIPPED_HOSTS = [
    "src/webviewHtml.ts",
    "mac/Sources/BirtaWriter/WebHost.swift",
];

/** Every `.html` under `e2e/`, repo-relative. */
function harnessPages(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(join(root, dir))) {
            if (name.startsWith(".") || name === "node_modules") continue;
            const rel = `${dir}/${name}`;
            if (statSync(join(root, rel)).isDirectory()) walk(rel);
            else if (name.endsWith(".html")) found.push(rel);
        }
    };
    walk("e2e");
    return found;
}

/**
 * Every file that serves the editor page under a policy: it says
 * `default-src 'none'`.
 *
 * A harness page with no policy at all is not a declarer and is not judged.
 * `e2e/svgRender/index.html` is the deliberate one, and its own header says
 * why: it exists to prove the sanitizer holds where no policy is helping.
 */
function declarers(): [file: string, source: string][] {
    return [...SHIPPED_HOSTS, ...harnessPages()]
        .map((file) => [file, readFileSync(join(root, file), "utf8")] as [string, string])
        .filter(([, source]) => source.includes("default-src 'none'"));
}

/**
 * The scheme and keyword sources an `img-src` grants, hosts dropped, or null
 * when the policy declares no `img-src` at all.
 *
 * Null rather than empty, because the two mean different things and only one
 * is a finding. No `img-src` means `default-src 'none'` covers images, which
 * is a stricter choice a page is free to make; an `img-src` that parsed to
 * nothing means this function is broken.
 *
 * `${webview.cspSource}` and `'self'` are the same claim spelled for two
 * hosts (the page's own origin), so they normalize to one token; without that
 * the extension could never compare equal to anything. Anything containing
 * `//` is a host and is dropped, which is what leaves the scheme vocabulary.
 *
 * The match is anchored to a DIRECTIVE position, after the `;` that ends the
 * previous one or the `"` that opens the string, rather than to the bare name.
 * A policy never leads with this directive, so the anchor always has one of
 * those to sit on. Unanchored, the first hit in `src/webviewHtml.ts` is the
 * comment ABOVE the policy explaining the `blob:` grant, and the guard would
 * then be reading an English sentence and reporting on it: the same hazard
 * AGENTS.md names for a runner that reads directives out of comments, reached
 * here by a guard reading a directive out of one.
 */
function imgSchemeGrants(source: string): string[] | null {
    const directive = source.match(/(?:^|[;"])\s*img-src ([^;"]*)/);
    if (!directive) return null;
    return directive[1]!
        .replace(/\$\{webview\.cspSource\}/g, "'self'")
        .replace(/\\\(imgHosts\)/g, "")
        .replace(/\$\{embedImgHosts\}/g, "")
        .split(/\s+/)
        .filter((token) => token.length > 0 && !token.includes("//"))
        .sort();
}

describe("img-src across the surfaces that serve the editor page", () => {
    const found = declarers();
    const withImgSrc = found
        .map(([file, source]) => [file, imgSchemeGrants(source)] as const)
        .filter((entry): entry is [string, string[]] => entry[1] !== null);

    // Discovery reached the tree, and reached both halves of it. Without this
    // every comparison below is satisfied by an empty list, which is what a
    // renamed directory or a broken walk produces.
    it("should have found the shipped hosts and the harness pages", () => {
        const files = found.map(([file]) => file);
        for (const host of SHIPPED_HOSTS) {
            expect(files, `${host} declares no policy, or was not found`).toContain(host);
        }
        expect(files.filter((f) => f.startsWith("e2e/")).length,
            "no harness page declares a policy; the walk found nothing").toBeGreaterThan(3);
    });

    // An `img-src` that parsed to zero sources is this file being broken, not
    // a policy being strict. The strict case is no `img-src` at all, which is
    // filtered out above rather than counted here.
    it("should parse every declared img-src to at least one source", () => {
        for (const [file, grants] of withImgSrc) {
            expect(grants.length, `${file} has an img-src that parsed to nothing`).toBeGreaterThan(0);
        }
    });

    // The grant this file was written for, asserted on its own as well as
    // through the set equality below, because the set can be made to agree by
    // taking `blob:` OUT of every declarer. That would be green, and would put
    // the empty box back on both surfaces instead of one.
    it("every declared img-src should grant blob:, for the composer's attachment thumbnail", () => {
        expect(withImgSrc.length, "nothing declares an img-src").toBeGreaterThan(3);
        for (const [file, grants] of withImgSrc) {
            expect(grants,
                `${file} refuses the object URL the agent composer's thumbnail uses; ` +
                "add blob: to its img-src").toContain("blob:");
        }
    });

    it("every declared img-src should grant the same image schemes", () => {
        const [, first] = withImgSrc[0]!;
        for (const [file, grants] of withImgSrc) {
            expect(grants, `${file} grants a different set of image schemes`).toEqual(first);
        }
    });
});
