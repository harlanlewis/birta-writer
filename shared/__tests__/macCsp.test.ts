/**
 * Guard for the Mac app's content-security-policy: it grants the same hosts
 * the extension's does, and the app offers no Web Inspector.
 *
 * An embed card's player is the one place in either surface where somebody
 * else's JavaScript runs inside the editor's own page, and the playground
 * providers among them (CodePen, CodeSandbox, StackBlitz) serve whatever a
 * stranger published. So WHICH hosts a document may put a frame around is the
 * whole of that containment, and the extension pins them from
 * `EMBED_CSP_FRAME_HOSTS`.
 *
 * The app restated that as `EmbedHosts` in Swift, because Swift cannot import
 * TypeScript, and this is what relates the two. It is the same arrangement as
 * `hostProfile.test.ts` and for the same reason: a second declaration with
 * nothing comparing it is a declaration free to drift, and the drift here is
 * invisible on both sides. A host missing from Swift renders a silent blank
 * frame; a host the TypeScript no longer lists stays framed on one surface
 * after being withdrawn on the other, and no test anywhere fails.
 *
 * The Swift SIDE of the policy is asserted where it can be read as a served
 * page, in `mac/Tests/BirtaWriterTests/WebHostPageTests.swift`. This file owns
 * only the cross-language equality and the two source-level absences below,
 * which no run of either suite can catch.
 *
 * SCOPE, stated because this file's name overstates it. It compares the two
 * embed-HOST lists and nothing else. The directive heads those hosts hang off
 * are not compared here, and while they were not compared anywhere the two
 * policies' `img-src` diverged on `blob:` and the agent composer's attachment
 * thumbnail drew on the Mac app and showed an empty box in VS Code, with this
 * suite green throughout. `cspDirectives.test.ts` owns the scheme grants
 * across every surface now; a new fact about a directive belongs there, and a
 * new fact about which HOSTS an embed may reach belongs here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EMBED_CSP_FRAME_HOSTS, EMBED_CSP_IMG_HOSTS } from "../embedProviders";

const REPO = join(__dirname, "..", "..");
const EMBED_HOSTS_SWIFT = "mac/Sources/BirtaWriterCore/EmbedHosts.swift";

/**
 * Every `.swift` file under `mac/Sources`, as `[repo-relative path, source]`.
 *
 * Sources and not `mac/Tests`, and the reason is the second absence below
 * rather than tidiness: a test that asserts the bare scheme is banned has to
 * spell it, so sweeping the tests would fail on the file doing the asserting.
 * That is the hazard AGENTS.md names about prose a runner reads, arriving as a
 * guard tripped by the words describing it, and it fired here on the first run.
 */
function swiftSources(): [string, string][] {
    const found: [string, string][] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(join(REPO, dir))) {
            if (name.startsWith(".")) continue;
            const rel = `${dir}/${name}`;
            if (statSync(join(REPO, rel)).isDirectory()) walk(rel);
            else if (name.endsWith(".swift")) found.push([rel, readFileSync(join(REPO, rel), "utf8")]);
        }
    };
    walk("mac/Sources");
    return found;
}

/**
 * The string literals in `public static let <name>: [String] = [ … ]`.
 *
 * Returns null when the declaration is not there at all, which the callers
 * assert on rather than skipping: a renamed constant would otherwise empty
 * this guard while every test in it went on passing.
 */
function swiftStringArray(source: string, name: string): string[] | null {
    const decl = source.match(
        new RegExp(`static let ${name}:\\s*\\[String\\]\\s*=\\s*\\[([\\s\\S]*?)\\n\\s*\\]`),
    );
    if (!decl) return null;
    return [...decl[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the Mac app's CSP host lists", () => {
    const swift = readFileSync(join(REPO, EMBED_HOSTS_SWIFT), "utf8");

    // Order and all: both sides join their list into one directive, so a
    // reordering is a different policy string even though it is the same set,
    // and holding the order is what lets the Swift test compare against the
    // directive it built rather than against a set it re-derived.
    it("the Swift frame-src list should be the extension's, in order", () => {
        const declared = swiftStringArray(swift, "frameSrc");
        expect(declared, `${EMBED_HOSTS_SWIFT} no longer declares frameSrc as a [String] literal`)
            .not.toBeNull();
        expect(declared).toEqual([...EMBED_CSP_FRAME_HOSTS]);
    });

    it("the Swift img-src list should be the extension's, in order", () => {
        const declared = swiftStringArray(swift, "imgSrc");
        expect(declared, `${EMBED_HOSTS_SWIFT} no longer declares imgSrc as a [String] literal`)
            .not.toBeNull();
        expect(declared).toEqual([...EMBED_CSP_IMG_HOSTS]);
    });

    // The lists themselves are not empty. Both assertions above hold when
    // BOTH sides are empty, which is the state a bad merge produces and the
    // one where the policy grants nothing and every embed is a blank frame.
    it("neither list should be empty", () => {
        expect(EMBED_CSP_FRAME_HOSTS.length).toBeGreaterThan(0);
        expect(EMBED_CSP_IMG_HOSTS.length).toBeGreaterThan(0);
    });
});

describe("the Mac app's Swift sources", () => {
    // Walked rather than named, because a guard that names one file is a guard
    // that MOVING the line switches off silently. The floor is what proves the
    // walk reached the tree at all: an empty sweep satisfies every `not.toMatch`
    // below by looking at nothing.
    const sources = swiftSources();

    it("the sweep should have reached the Swift tree", () => {
        expect(sources.length).toBeGreaterThan(50);
        // The two files the absences below are really about, by name: a walk
        // that reached every other Swift source and missed these two would
        // clear the floor above and check nothing that matters.
        const paths = sources.map(([path]) => path);
        expect(paths).toContain("mac/Sources/BirtaWriter/WebHost.swift");
        expect(paths).toContain(EMBED_HOSTS_SWIFT);
    });

    // The release build must not offer an attachable JavaScript console over
    // the buffer, and the shape that does is a literal rather than the gate.
    // Nothing the app can do at runtime tells you which one was written, so
    // this is the only place the difference is checkable.
    it("no source should set isInspectable to a literal true", () => {
        const offenders = sources
            .filter(([, text]) => /isInspectable\s*=\s*true/.test(text))
            .map(([path]) => path);
        expect(offenders).toEqual([]);
    });

    // Deliberately not `not.toMatch(/https:/)`: the doc comments and the host
    // lists are full of https URLs. What is banned is the bare scheme as a
    // CSP source expression, which is `https:` with a quote or a space after
    // it and no host, and it is banned because a pinned list is what it was
    // replaced by.
    //
    // What it does NOT catch, said out loud so nobody reads it as the whole
    // guard: a wildcard (`*`, `https://*`) grants the same reach by another
    // spelling and this would pass. The policy's actual grants are asserted
    // against the pinned lists in WebHostPageTests, which is where a new way
    // of writing "everything" fails; this ban only stops the one spelling
    // that was there, coming back.
    it("no source should grant the bare https: scheme in a policy", () => {
        const offenders = sources
            .filter(([, text]) => /["\s]https:(?=["\s;])/.test(text))
            .map(([path]) => path);
        expect(offenders).toEqual([]);
    });
});
