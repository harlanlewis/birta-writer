/**
 * Guards for what `measure.sh` requires before its output means anything: a
 * build that is this tree's, and a screen that is unlocked.
 *
 * The failure both cover is a report that is WRONG rather than absent, which is
 * the expensive kind. Every arm in that script reports on the product, so a run
 * whose preconditions do not hold still prints a full page of verdicts, and the
 * arms that go red are whichever ones happen to depend on what is broken about
 * the run. Both preconditions were found the same way: the spelling and grammar
 * arms blaming `NSSpellChecker` while `SpellServiceTests` stayed green.
 *
 * A locked screen is the one that actually bites, because a full pass takes
 * minutes and an unattended display sleeps inside that. Nothing can take
 * activation past the login window, so the panel never dismisses and WebKit
 * suspends idle callbacks for it, while keys and autosave go on working. The
 * arms that read anything the page schedules on idle are the first to notice,
 * and they describe it as a checker that answered nothing.
 *
 * What is asserted here is what a test can reach. `build-fresh.sh` is a program
 * with inputs, so it is RUN, against a fixture repo, once per hop and once in
 * the passing state: a predicate that refuses everything would satisfy every
 * stale case, so the fresh fixture asserting PASS is what makes the rest mean
 * something. The screen-lock preflight cannot be driven from a test without a
 * locked screen, so what is held is that it is still there and still ahead of
 * the launch, which is the way a guard usually dies. Both call sites are
 * asserted for the same reason: a guard that exists and is never reached is
 * invisible to every run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SCRIPT = join(REPO, "mac", "scripts", "build-fresh.sh");

/** Seconds since the epoch, as `utimesSync` takes them. */
const T = Math.floor(Date.now() / 1000);

/** Every file the preflight reads, and how old each is in the fresh fixture. */
const OLD = T - 600;
const NEW = T - 60;

/**
 * A repo shaped the way the preflight walks it, with every artifact newer than
 * the sources behind it. `stale` moves one file forward, which is the only
 * difference between the passing case and each failing one.
 */
function fixture(stale?: { path: string; at: number }): string {
    const root = mkdtempSync(join(tmpdir(), "mac-fresh-"));
    const app = join(root, "mac", "build", "Birta Writer.app");
    const write = (rel: string, at: number, mode?: number) => {
        const full = join(root, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "x");
        if (mode !== undefined) { chmodSync(full, mode); }
        utimesSync(full, at, at);
    };

    // Sources, oldest.
    write("webview/index.ts", OLD);
    write("shared/product.ts", OLD);
    write("packages/minimal-diff/src/index.ts", OLD);
    write("esbuild.mjs", OLD);
    write("mac/Sources/BirtaWriter/Preferences.swift", OLD);
    write("mac/Package.swift", OLD);
    write("mac/Resources/index.html", OLD);
    // A test file, which never reaches the bundle: pruned, so it may be newer
    // than every artifact without making the build stale.
    write("webview/__tests__/some.test.ts", T);
    // Artifacts, newer.
    write("dist/webview.js", NEW);
    write("mac/build/Birta Writer.app/Contents/Resources/web/dist/webview.js", NEW);
    write("mac/build/Birta Writer.app/Contents/MacOS/BirtaWriter", NEW, 0o755);

    if (stale) { utimesSync(join(root, stale.path), stale.at, stale.at); }
    expect(app).toBeTruthy();
    return root;
}

function run(root: string): { code: number; err: string } {
    const r = spawnSync("bash", [SCRIPT, "--repo", root], { encoding: "utf8" });
    return { code: r.status ?? -1, err: r.stderr ?? "" };
}

describe("measure.sh preconditions", () => {
    const roots: string[] = [];
    const make = (stale?: { path: string; at: number }) => {
        const root = fixture(stale);
        roots.push(root);
        return root;
    };

    afterAll(() => {
        for (const r of roots) { rmSync(r, { recursive: true, force: true }); }
    });

    it("a build newer than every source should be accepted", () => {
        const { code, err } = run(make());
        expect(err).toBe("");
        expect(code).toBe(0);
    });

    /**
     * One row per hop the bundle is assembled across. Each moves a single file
     * forward from the fixture above, so a refusal can only come from that hop.
     */
    const HOPS: ReadonlyArray<{ what: string; path: string; names: RegExp }> = [
        {
            what: "a page source newer than dist",
            path: "webview/index.ts",
            names: /dist\/ is older than webview\/index\.ts/,
        },
        {
            what: "a shared source newer than dist",
            path: "shared/product.ts",
            names: /dist\/ is older than shared\/product\.ts/,
        },
        {
            what: "a workspace package newer than dist",
            path: "packages/minimal-diff/src/index.ts",
            names: /dist\/ is older than packages\//,
        },
        {
            what: "dist newer than the page inside the bundle",
            path: "dist/webview.js",
            names: /the bundle's page is older than dist\/webview\.js/,
        },
        {
            what: "a Swift source newer than the binary",
            path: "mac/Sources/BirtaWriter/Preferences.swift",
            names: /the app binary is older than mac\/Sources\//,
        },
        {
            what: "a bundle resource newer than the binary",
            path: "mac/Resources/index.html",
            names: /the app binary is older than mac\/Resources\//,
        },
    ];

    for (const hop of HOPS) {
        it(`${hop.what} should be refused, naming that hop`, () => {
            const { code, err } = run(make({ path: hop.path, at: T }));
            expect(code).toBe(1);
            expect(err).toMatch(hop.names);
            expect(err).toMatch(/refusing to measure a build that is not this tree's/);
        });
    }

    it("every hop the bundle is assembled across should be covered", () => {
        // The enumeration's own size, so a hop that stops being checked is a
        // red rather than a quietly smaller list.
        expect(HOPS).toHaveLength(6);
        expect(new Set(HOPS.map((h) => h.path)).size).toBe(HOPS.length);
    });

    it("a missing app should be refused rather than measured", () => {
        const root = make();
        rmSync(join(root, "mac", "build"), { recursive: true, force: true });
        const { code, err } = run(root);
        expect(code).toBe(1);
        expect(err).toMatch(/no runnable app at/);
    });

    it("a root the tree does not have should be skipped, not fatal", () => {
        // The roots are a fixed list and a tree need not have all of them.
        // Under `set -e` a missing one is one shell rule away from aborting the
        // preflight, which would read as a refusal nobody could act on.
        const root = make();
        rmSync(join(root, "packages"), { recursive: true, force: true });
        const { code, err } = run(root);
        expect(err).toBe("");
        expect(code).toBe(0);
    });

    it("a test file newer than the build should not refuse it", () => {
        // The prune is what keeps the guard from firing on an edit that cannot
        // reach the bundle. Without it the guard is noise, and noise gets
        // routed around.
        const { code } = run(make({ path: "webview/__tests__/some.test.ts", at: T }));
        expect(code).toBe(0);
    });

    /** The one read of `measure.sh`, shared by the call-site assertions below. */
    const measure = readFileSync(join(REPO, "mac", "scripts", "measure.sh"), "utf8");
    /** Where the run stops being preparation and starts being measurement. */
    const launch = measure.search(/^BIRTA_MAC_MEASURE=1 "\$APP"/m);

    it("the launch line should be findable, or the ordering assertions prove nothing", () => {
        // The anchor every check below is measured against. Pinned on its own
        // so a rename of the launch line reads as what it is, rather than as
        // each guard having moved.
        expect(launch).toBeGreaterThan(-1);
    });

    it("a locked screen should be refused before the app is ever launched", () => {
        // The check itself needs a locked screen to exercise, which a test
        // cannot arrange. What it can hold is that the guard is present and
        // ahead of the launch, which is how it would actually be lost.
        const locked = measure.search(/^screen_is_locked\(\) \{/m);
        expect(locked).toBeGreaterThan(-1);
        expect(measure).toMatch(/CGSSessionScreenIsLocked/);
        const refusal = measure.search(/^if screen_is_locked; then/m);
        expect(refusal).toBeGreaterThan(-1);
        expect(launch).toBeGreaterThan(refusal);
    });

    it("a screen that locks mid-run should be caught where the panel stops dismissing", () => {
        // The preflight only covers a screen that was locked at the start, and
        // the run it has to survive is longer than a display-sleep timer. The
        // backstop lives in hide_panel, which is the first thing a panel that
        // will not dismiss breaks.
        const hide = measure.search(/^hide_panel\(\) \{/m);
        expect(hide).toBeGreaterThan(-1);
        const detector = measure.indexOf("activation           FAILED");
        expect(detector).toBeGreaterThan(hide);
        // Bounded by where the function actually ends rather than by a count of
        // characters, which drifts the moment the message is reworded.
        const end = measure.indexOf("\n}\n", hide);
        expect(end).toBeGreaterThan(detector);
        // It has to tell the two causes apart, or it sends the reader to move
        // windows around when the screen had simply gone to sleep.
        expect(measure.slice(detector, end)).toMatch(/screen_is_locked/);
    });

    /** The two arms that read a lint line, and the variable each types from. */
    const ARMS = ["SPELL_TEXT", "GRAMMAR_TEXT"] as const;

    it("a lint arm should never read whichever line is newest", () => {
        // The shape of the original defect, in both directions. Reading the
        // last line lets an arm pass on the previous arm's block; reading the
        // first line after a marker lets it read the rescan the panel's own
        // show causes. Neither is the arm's own subject.
        // Matched by shape rather than by the exact line that used to be here,
        // so a reintroduction spelled differently is still caught.
        expect(measure).not.toMatch(/birta-trace lint.*\|\s*tail -1/);
    });

    for (const arm of ARMS) {
        it(`${arm} should supply both the keys typed and the length matched`, () => {
            // One string, two uses. Typing one thing and matching the length of
            // another is a silent no-match, which reads as a checker that never
            // answered.
            expect(measure).toContain(`keys_json "$${arm}"`);
            expect(measure).toContain(`"\${#${arm}}"`);
        });
    }

    it("the two arms should type texts of different lengths", () => {
        // Length is how each arm finds its own line, so equal lengths would let
        // either arm read the other's, and the pair would still look green.
        const texts = ARMS.map((arm) => {
            const m = measure.match(new RegExp(`^${arm}="([^"]*)"$`, "m"));
            expect(m, `${arm} should be a plain double-quoted literal`).not.toBeNull();
            return m![1];
        });
        expect(texts[0].length).not.toBe(texts[1].length);
    });

    it("measure.sh should run the preflight, or the guard protects nothing", () => {
        expect(measure).toMatch(/bash mac\/scripts\/build-fresh\.sh/);
        // Before any app is launched: a preflight that ran after the first arm
        // would let that arm report on the stale build it exists to refuse.
        // Anchored to the launch COMMAND rather than to the variable's name,
        // which the script's own header mentions in prose long before it runs
        // anything.
        const preflight = measure.indexOf("mac/scripts/build-fresh.sh");
        expect(preflight).toBeGreaterThan(-1);
        expect(launch).toBeGreaterThan(preflight);
    });
});
