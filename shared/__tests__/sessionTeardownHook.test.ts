/**
 * Guard for the session-teardown hook: it stays registered, and the script it
 * names stays runnable.
 *
 * The hook clears what a Birta Writer Jot run leaves on the machine, and its
 * failure mode is the one that has already happened twice here: a teardown
 * that silently stops running. Nothing goes red, no run reports anything, and
 * the litter accumulates somewhere nobody is looking until a person notices
 * three menu-bar icons or 220 stale plists.
 *
 * A hook is registration plus a file, and either half can go without the other
 * noticing. Deleting the `SessionEnd` entry from `settings.json` leaves the
 * script sitting there executable and never called; deleting the script leaves
 * the registration pointing at nothing, which a hook runner reports to nobody.
 * So both halves are asserted, and the wiring BETWEEN them is asserted by
 * reading the command out of the settings rather than by naming the path
 * twice: a rename that updated one and not the other is exactly the drift this
 * exists to catch.
 *
 * What this cannot do is prove the hook runs, which needs a session to end.
 * It proves the two things that make it possible, and those are the two that
 * rot.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SETTINGS = join(REPO, ".claude", "settings.json");

interface HookEntry { type?: string; command?: string }
interface HookGroup { matcher?: string; hooks?: HookEntry[] }

describe("session teardown hook", () => {
    const settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as {
        hooks?: Record<string, HookGroup[]>;
    };
    const sessionEnd = settings.hooks?.SessionEnd ?? [];
    const commands = sessionEnd.flatMap((group) => (group.hooks ?? []).map((h) => h.command ?? ""));

    it("a SessionEnd hook should be registered, or nothing clears the machine", () => {
        expect(sessionEnd.length).toBeGreaterThan(0);
        expect(commands.length).toBeGreaterThan(0);
    });

    it("the registered command should point at a script that exists and can run", () => {
        // Resolved from what settings.json actually says, so a rename has to
        // move both halves together or this fails.
        const resolved = commands.map((c) =>
            c.replace(/"?\$CLAUDE_PROJECT_DIR"?/g, REPO).replace(/^"|"$/g, "").trim(),
        );
        const reaper = resolved.find((c) => c.includes("reap"));
        expect(reaper, `no reaping hook among: ${resolved.join(", ")}`).toBeDefined();
        expect(existsSync(reaper!)).toBe(true);
        // Executable by its owner. A hook runner invokes it directly, and a
        // file without the bit is a registration pointing at nothing.
        expect(statSync(reaper!).mode & 0o100).toBe(0o100);
    });

    it("the reaper it calls should refuse to touch the app's own settings domain", () => {
        // The one line of that script that must never change meaning: every
        // throwaway domain is a suffix of the real one, so a glob over the
        // prefix takes a person's hotkey, note location and agent command.
        const reap = readFileSync(join(REPO, "jot", "scripts", "reap.sh"), "utf8");
        expect(reap).toContain('if [ "$name" = "com.birtalabs.jot" ]; then continue; fi');
        // Judged on the CODE, not on the prose. The header explains at length
        // that the installed copy is never touched, and a check over the whole
        // file would fail on the sentence saying so.
        const code = reap
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .join("\n");
        // It selects development builds by path, and never the installed copy.
        // Without the `.app`, deliberately: the development flavour's bundle
        // is "Birta Writer Jot Dev.app", so a pattern anchored on the
        // extension matches only the release name and misses the build a
        // session is most likely to have left running.
        expect(code).toContain('pgrep -f "jot/build/Birta Writer Jot"');
        expect(code).not.toContain("/Applications");
        // SIGTERM only: WebKit's helpers are not children of the app and only
        // exit because the app asks them to, so a hard kill orphans a set per
        // launch, which is the litter this whole path exists to stop.
        expect(code).not.toMatch(/kill\s+-9/);
        expect(code).not.toMatch(/\bpkill\b|\bkillall\b/);
    });
});
