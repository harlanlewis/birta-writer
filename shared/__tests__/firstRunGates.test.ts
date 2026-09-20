/**
 * Guard for the two first-run decisions in Birta Writer for Mac: what a launch
 * opens on, and whether the tour may be written into the bound file.
 *
 * Both decisions are pure and both are covered over their whole space by
 * `FirstRunTests` and `FirstRunNoteTests`. What no Swift test can reach is
 * the WIRING: `AppDelegate.applicationDidFinishLaunching` asks the first and
 * seeds the tour for an invitation, `Coordinator` seeds it again for the
 * screen, and all three need a panel, a web view and a preferences domain to
 * construct. So a correct rule asked the wrong question, or asked from only
 * some of its places, is exactly the shape AGENTS.md names, a guard that is
 * ABSENT rather than wrong.
 *
 * This reads the Swift as text, the way `documentTypes.test.ts` does, because
 * that is what the two things being related have in common: neither can import
 * the other, and the drift is silent in both directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SOURCES = join(REPO, "mac", "Sources");

/** Every `.swift` file under `mac/Sources`, as repo-relative path and contents. */
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
        expect(paths).toContain("mac/Sources/BirtaWriter/App.swift");
        expect(paths).toContain("mac/Sources/BirtaWriter/Coordinator.swift");
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
        // Two seeds, one per way the tour arrives: the launch writes it
        // before the windows are made for an invitation, and the Coordinator
        // writes it when the screen finishes. A third caller is a new way in
        // and has to be looked at, not counted.
        expect(calls.map((c) => c.path).sort()).toEqual([
            "mac/Sources/BirtaWriter/App.swift",
            "mac/Sources/BirtaWriter/Coordinator.swift",
        ]);
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
    it("a source outside FirstRun re-deriving the opening's condition should be refused", () => {
        const rederived = sources.filter(
            ({ path, source }) =>
                !path.endsWith("FirstRun.swift") &&
                /isUserStore\s*&&\s*!\s*Prefs\.hasSeenWelcome/.test(source),
        );
        expect(rederived.map((s) => s.path)).toEqual([]);
    });

    /**
     * And the one call site still asks the whole question, of the BINDING and
     * with the answer it reads rather than one written into the call.
     *
     * A constant passes a check on the label alone while telling the rule no
     * document is bound, and the app compiles. The launch argument may be
     * added to the stored binding but never stand in for it: `launchedWith`
     * is a launch-shaped answer, true once and gone on the next launch, while
     * the binding survives quitting. What the rule protects is that the
     * stored one is always asked; the launch half only closes the window
     * between the open event arriving and the binding being stored.
     */
    it("the launch should ask FirstRun whether a document is bound, off the stored binding", () => {
        const app = sources.find((s) => s.path === "mac/Sources/BirtaWriter/App.swift")!.source;
        const call = /FirstRun\.opening\(([\s\S]*?)\)\s*\n/.exec(app);
        expect(call, "App.swift no longer asks FirstRun").not.toBeNull();
        const args = call![1]!;
        expect(args).toMatch(/forced:/);
        // The stored binding is asked, not a constant and not the launch
        // argument alone.
        expect(args).toMatch(/documentBound:\s*Prefs\.documentURL\s*!=\s*nil/);
    });
});
