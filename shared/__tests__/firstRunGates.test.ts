/**
 * Guard for the two first-run decisions in Birta Writer for Mac: whether the
 * screen goes up, and whether the tour may be written into the bound file.
 *
 * Both decisions are pure and both are covered over their whole space by
 * `FirstRunScreenTests` and `FirstRunNoteTests`. What no Swift test can reach
 * is the WIRING: `Coordinator.seedFirstRunNote` and
 * `AppDelegate.applicationDidFinishLaunching` are the two call sites, and both
 * need a panel, a web view and a preferences domain to construct. So a correct
 * rule asked the wrong question, or asked from only one of two places, is
 * exactly the shape AGENTS.md names, a guard that is ABSENT rather than wrong.
 *
 * This reads the Swift as text, the way `documentTypes.test.ts` does, because
 * that is what the two things being related have in common: neither can import
 * the other, and the drift is silent in both directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SOURCES = join(REPO, "jot", "Sources");

/** Every `.swift` file under `jot/Sources`, as repo-relative path and contents. */
function swiftSources(): { path: string; source: string }[] {
    const found: { path: string; source: string }[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".swift")) {
                found.push({ path: full.slice(REPO.length + 1), source: readFileSync(full, "utf8") });
            }
        }
    };
    walk(SOURCES);
    return found;
}

const sources = swiftSources();

describe("the first-run gates", () => {
    /** A sweep that reached nothing passes every assertion inside it. */
    it("a scan of the app's Swift should have found both call sites' files", () => {
        expect(sources.length).toBeGreaterThan(20);
        const paths = sources.map((s) => s.path);
        expect(paths).toContain("jot/Sources/BirtaJot/App.swift");
        expect(paths).toContain("jot/Sources/BirtaJot/Coordinator.swift");
    });

    /**
     * The seed asks which of the three settings names the file it is about to
     * write, and a literal there is the whole defect wearing the fix's clothes:
     * `slot: .scratchpad` compiles, satisfies every unit test of the rule, and
     * puts the tour back into a file the user pointed the app at.
     */
    it("a call to shouldWrite naming its own slot should be refused", () => {
        const calls = sources.flatMap(({ path, source }) =>
            [...source.matchAll(/shouldWrite\(([\s\S]*?)\)\s*else/g)].map((m) => ({ path, args: m[1]! })),
        );
        expect(calls).toHaveLength(1);
        for (const { path, args } of calls) {
            expect(args, `${path} passes no slot`).toMatch(/slot:/);
            expect(args, `${path} names a slot instead of deriving one`).not.toMatch(
                /slot:\s*\.(document|currentNote|scratchpad)\b/,
            );
        }
    });

    /**
     * The screen's condition is asked in one place. Re-deriving it at a second
     * site is how the two halves drift, and the half that would be forgotten is
     * the newest one: a launch pointed at a file is not the launch this screen
     * is for.
     */
    it("a source outside FirstRunScreen re-deriving the screen's condition should be refused", () => {
        const rederived = sources.filter(
            ({ path, source }) =>
                !path.endsWith("FirstRunScreen.swift") &&
                /isUserStore\s*&&\s*!\s*Prefs\.hasSeenWelcome/.test(source),
        );
        expect(rederived.map((s) => s.path)).toEqual([]);
    });

    /**
     * And the one call site still asks the whole question, of the BINDING and
     * with the answer it reads rather than one written into the call.
     *
     * Two ways to get this wrong and neither is visible to a rule test. A
     * constant passes a check on the label alone while telling the screen no
     * document is bound, and the app compiles. `launchedWith != nil` looks like
     * the same question and is a launch-shaped one: it answers this case
     * correctly once, then the wrong way on every later launch, which spends
     * the tour on a note `shouldWrite` refuses.
     */
    it("the launch should ask FirstRunScreen whether a document is bound", () => {
        const app = sources.find((s) => s.path === "jot/Sources/BirtaJot/App.swift")!.source;
        const call = /FirstRunScreen\.shouldShow\(([\s\S]*?)\)\s*\{/.exec(app);
        expect(call, "App.swift no longer asks FirstRunScreen").not.toBeNull();
        const args = call![1]!;
        expect(args).toMatch(/forced:/);
        // The stored binding, not a constant and not the launch argument.
        expect(args).toMatch(/documentBound:\s*Prefs\.documentURL\s*!=\s*nil/);
    });
});
