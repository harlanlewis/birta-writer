/**
 * Guard for the app flavours: Swift and the shell scripts agree about the two
 * builds' names.
 *
 * `build-app.sh` stamps the bundle id, the display name and the executable
 * name into the app; `AppFlavor` reads the id back at runtime to decide which
 * note to open, which hotkey to claim and whether the build may replace
 * itself; `install-app.sh` asks a running copy to quit by executable name.
 * Neither language can import the other, so the same four strings are written
 * in three files and nothing but this relates them.
 *
 * The drift fails DANGEROUSLY, which is why it is worth a test rather than
 * care. `AppFlavor.forBundle` returns `.release` for anything it does not
 * recognise, and release is the flavour that opens the user's note, claims the
 * release hotkey and updates itself. A development build stamped with an id
 * Swift no longer knows would therefore behave as the release: open somebody's
 * note, take their hotkey, and offer to replace itself with a real release.
 *
 * The commit that added the flavours cited this file before it existed, which
 * is the "a guard that is ABSENT rather than wrong" shape AGENTS.md names: the
 * citation read as coverage and nothing was checking anything.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const swift = readFileSync(join(REPO, "jot/Sources/BirtaJotCore/AppFlavor.swift"), "utf8");
const buildScript = readFileSync(join(REPO, "jot/scripts/build-app.sh"), "utf8");
const installScript = readFileSync(join(REPO, "jot/scripts/install-app.sh"), "utf8");
const updateScript = readFileSync(join(REPO, "jot/scripts/update-jot.sh"), "utf8");
const handoff = readFileSync(join(REPO, "scripts/install-local.mjs"), "utf8");
const releaseWorkflow = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");
const feed = readFileSync(join(REPO, "jot/Sources/BirtaJotCore/ReleaseFeed.swift"), "utf8");
const product = readFileSync(join(REPO, "shared/product.ts"), "utf8")
    .match(/JOT_PRODUCT_NAME\s*=\s*"([^"]+)"/)?.[1];
if (!product) {
    // Thrown with a message rather than left as a non-null assertion: every
    // test here reads it, so an unreadable constant takes the whole file down
    // and the reason has to survive that.
    throw new Error("shared/product.ts no longer declares JOT_PRODUCT_NAME as a string literal");
}

/** Every `NAME="value"` assignment in a shell script, by name. */
function shellAssignments(text: string, name: string): string[] {
    return [...text.matchAll(new RegExp(`^\\s*${name}="([^"]*)"`, "gm"))].map((m) => m[1]!);
}

/**
 * The same, split by which side of the flavour branch it is on.
 *
 * Both scripts set the release value at the top level and overwrite it inside
 * `if [ "$FLAVOR" = dev ]; then … fi`, so WHICH value belongs to which flavour
 * is a fact about position. Comparing the two as a set cannot see them
 * swapped, and a swap is the catastrophe this file's header describes: a dev
 * build stamped with the release id opens the user's note, claims their hotkey
 * and offers to replace itself.
 */
function byFlavour(text: string, name: string): { release?: string; dev?: string } {
    const branch = text.match(/if \[ "\$FLAVOR" = dev \]; then\n([\s\S]*?)\nfi/);
    const inside = branch?.[1] ?? "";
    const all = shellAssignments(text, name);
    const dev = shellAssignments(inside, name);
    return { release: all.find((v) => !dev.includes(v)), dev: dev[0] };
}

/** A `static let name = "value"` in Swift. */
function swiftConstant(name: string): string | undefined {
    return swift.match(new RegExp(`static let ${name}\\s*=\\s*"([^"]+)"`))?.[1];
}

describe("app flavours", () => {
    it("the bundle ids Swift knows should be the ones the build script stamps", () => {
        const release = swiftConstant("releaseBundleID");
        const dev = swiftConstant("devBundleID");
        expect(release).toBeDefined();
        expect(dev).toBeDefined();
        const stamped = byFlavour(buildScript, "BUNDLE_ID");
        expect(stamped.release).toBe(release);
        expect(stamped.dev).toBe(dev);
    });

    it("the app names should agree across Swift and both scripts", () => {
        // Swift composes the names rather than spelling them, so the expected
        // pair is derived the same way the app derives them.
        const suffix = swift.match(/case \.dev: return "([^"]+)"/)?.[1];
        expect(suffix, "AppFlavor should carry a dev name suffix").toBeDefined();
        for (const script of [buildScript, installScript]) {
            const names = byFlavour(script, "APP_NAME");
            expect(names.release).toBe(product);
            expect(names.dev).toBe(product + suffix!);
        }
    });

    it("the executable names should agree between the two scripts", () => {
        // Nothing in Swift names these, and that is exactly why they need a
        // check: `install-app.sh` asks a running copy to quit BY executable
        // name, so two flavours sharing one means installing the development
        // build quits the release. Only the pair being equal makes that safe.
        const built = byFlavour(buildScript, "EXEC_NAME");
        const installed = byFlavour(installScript, "EXEC_NAME");
        expect(built.release).toBeDefined();
        expect(built.dev).toBeDefined();
        expect(built.release).not.toBe(built.dev);
        // Per flavour, not as a set: swapped, `install-app.sh --dev` would ask
        // the RELEASE executable to quit, which is the app somebody is using.
        expect(installed.release).toBe(built.release);
        expect(installed.dev).toBe(built.dev);
    });

    it("the development id should sit outside the namespace the reaper clears", () => {
        // `reap.sh` clears every defaults domain strictly under
        // `com.birtalabs.jot.`, so a development build parked there would have
        // its settings deleted at the end of every session. Asserted here as
        // well as in Swift, because this file is the one that reads the SHELL
        // side, and the id could drift there alone.
        const release = swiftConstant("releaseBundleID")!;
        const ids = shellAssignments(buildScript, "BUNDLE_ID");
        // A floor, because the loop below is vacuous on an empty match and an
        // empty sweep reads exactly like a clean one.
        expect(ids.length).toBe(2);
        for (const id of ids) {
            if (id === release) { continue; }
            expect(id.startsWith(release + "."), `${id} is inside the namespace reap.sh clears`)
                .toBe(false);
        }
    });

    it("the handoff should print the name of the app it actually installs", () => {
        // `install-local.mjs` names the development build in what it prints,
        // and the name it prints has to be the bundle it installs. Nothing
        // else relates the two, so a rename that misses this file leaves
        // user-facing messages naming an app that does not exist, with every
        // gate green.
        const suffix = swift.match(/case \.dev: return "([^"]+)"/)?.[1];
        const printed = handoff.match(/JOT_APP_NAME\s*=\s*"([^"]+)"/)?.[1];
        expect(printed, "install-local.mjs should name the app in one constant").toBeDefined();
        expect(printed).toBe(product + suffix!);
        // And the constant should be the only place that file spells the name,
        // or it is decoration standing beside literals nothing checks.
        //
        // Comments are stripped first: naming the release app in a sentence
        // about why the handoff does not touch it is correct prose. What is
        // left is code, and the only occurrence code may contain is the
        // assignment itself. Filtering on the character AFTER the name cannot
        // do this job, because the two shapes that actually occur are a name
        // followed by a space and a name that is the whole literal.
        const code = handoff
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
        const spellings = [...code.matchAll(new RegExp(product!, "g"))];
        expect(spellings.length, `${product} is spelled ${spellings.length} times in code`).toBe(1);
        expect(code).toContain(`JOT_APP_NAME = "${printed}"`);
    });

    it("the by-hand updater should only ever name the release app", () => {
        // `update-jot.sh` installs the RELEASE and has no flavour branch, so
        // every bundle it names is the plain product name. A flavour suffix
        // reaching this file would point the by-hand update path at the wrong
        // bundle, and `byFlavour` above cannot see a file with no branch.
        //
        // Matched up to `.app`, capturing what sits BETWEEN the product name
        // and the extension, which is where a suffix would land. Matching the
        // product name alone cannot discriminate: a suffix begins with a
        // space, so `Birta Writer Jot [DEV].app` would be read as the release
        // name followed by text the pattern never sees.
        const named = [...updateScript.matchAll(new RegExp(`${product}([^"\\n]*?)\\.app`, "g"))];
        expect(named.length).toBeGreaterThan(3);
        for (const [whole, between] of named) {
            expect(between, `${whole} is not the release app`).toBe("");
        }
    });

    it("the release asset name should be the one both updaters look for", () => {
        // Three places produce or select this name and nothing related any
        // two: the release job's `ditto`, the shell updater's `grep`, and
        // `ReleaseFeed.assetPrefix`. Attach a second .zip to a release and a
        // loose predicate downloads the wrong one, then verifies it against
        // the right one's checksum.
        const prefix = feed.match(/assetPrefix\s*=\s*"([^"]+)"/)?.[1];
        expect(prefix, "ReleaseFeed should name the asset prefix").toBeDefined();
        expect(releaseWorkflow).toContain(`"${prefix}$VERSION.zip"`);
        expect(releaseWorkflow).toContain(`"${prefix}$VERSION.zip.sha256"`);
        expect(updateScript).toContain(prefix!);
    });
});
