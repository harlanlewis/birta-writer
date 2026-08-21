/**
 * The host profile (MAR-373): the absent-means-the-VS-Code-profile rule, the
 * profiles table, the command predicate every surface reads, and the drift
 * guard over the three declarers that restate it by hand.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ALL_HOST_CAPABILITIES,
    HOST_PROFILES,
    hostHas,
    hostHasCommand,
    type HostCapability,
    type HostArrangement, APP_ONLY_CAPABILITIES, ALL_HOST_ARRANGEMENTS } from "../hostProfile";
import { EDITOR_COMMANDS, TOOLBAR_MENU_COMMANDS } from "../editorCommands";

type Declared = { __i18n?: { host?: { capabilities?: readonly HostCapability[] } } };
const g = globalThis as Declared;

/** Declare a profile carrying `caps`, or one with no profile at all. */
function declare(caps: readonly HostCapability[] | undefined): void {
    g.__i18n = caps === undefined ? {} : { host: { capabilities: caps } };
}

/** Declare a profile carrying every capability and the given arrangements. */
function declareArrangements(arrangements: readonly HostArrangement[]): void {
    g.__i18n = { host: { capabilities: ALL_HOST_CAPABILITIES, arrangements } };
}

/** Commands an arrangement withdraws, derived from the command table itself. */
const WITHDRAWN = EDITOR_COMMANDS.filter(
    (m): m is typeof m & { absentUnder: HostArrangement } =>
        "absentUnder" in m && !!m.absentUnder);

/** The repository root, for the two checks that read the tree. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `.ts` under the given roots, concatenated, tests excluded. */
function readSource(roots: readonly string[]): string {
    const parts: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith(".ts")) parts.push(readFileSync(full, "utf8"));
        }
    };
    for (const root of roots) walk(join(ROOT, root));
    return parts.join("\n");
}

const GATED = EDITOR_COMMANDS.filter((m) => "hostCapability" in m && m.hostCapability);
const UNGATED = EDITOR_COMMANDS.filter((m) => !("hostCapability" in m) || !m.hostCapability);

describe("hostHas", () => {
    afterEach(() => { delete g.__i18n; });

    // Absent means the VS CODE profile, not the literal union: a page with no
    // declaration is one that predates the field, which is a VS Code page, and
    // it must not inherit a capability that names a standalone app's window.
    // For every capability that existed before `APP_ONLY_CAPABILITIES`, this
    // is the same answer absent has always given.
    it("no declaration at all should mean every capability a VS Code host has", () => {
        delete g.__i18n;
        for (const cap of HOST_PROFILES.vscode) { expect(hostHas(cap), cap).toBe(true); }
        for (const cap of APP_ONLY_CAPABILITIES) { expect(hostHas(cap), cap).toBe(false); }
    });

    it("an __i18n without the field should mean the same", () => {
        declare(undefined);
        for (const cap of HOST_PROFILES.vscode) { expect(hostHas(cap), cap).toBe(true); }
        for (const cap of APP_ONLY_CAPABILITIES) { expect(hostHas(cap), cap).toBe(false); }
        // The split has to be a real one, or these two loops are one loop.
        expect(APP_ONLY_CAPABILITIES.length).toBeGreaterThan(0);
        expect(HOST_PROFILES.vscode.length).toBeGreaterThan(0);
    });

    it("an empty declaration should mean no capability", () => {
        declare([]);
        for (const cap of ALL_HOST_CAPABILITIES) { expect(hostHas(cap)).toBe(false); }
    });

    it("a partial declaration should be read literally", () => {
        declare(["toc"]);
        expect(hostHas("toc")).toBe(true);
        expect(hostHas("textEditor")).toBe(false);
    });
});

describe("HOST_PROFILES", () => {
    it("vscode should declare everything, and jot only what its shell provides", () => {
        // Everything EXCEPT the app-only ones: those name a window a
        // standalone application has and an editor pane does not, so a VS Code
        // host declaring one would offer a row that opens nothing.
        expect([...HOST_PROFILES.vscode].sort()).toEqual(
            ALL_HOST_CAPABILITIES.filter((c) => !APP_ONLY_CAPABILITIES.includes(c)).sort());
        // Jot's shell saves a pasted image beside the document and serves it
        // back over its own scheme, so it owns an image store; it has a
        // Settings window of its own; and it runs a coding agent as a child
        // process. It provides none of the others: there is no text editor to
        // switch to, no VS Code settings or keybindings UI, no proofreading
        // engine, no read-only owner, no sidebar, no editor font of its own,
        // and no pane wide enough for a reading measure to be a choice.
        expect(HOST_PROFILES.jot).toEqual(["imageUpload", "appPreferences", "agent"]);
    });

    it("every capability named on a command should be in ALL_HOST_CAPABILITIES", () => {
        expect(GATED.length).toBeGreaterThan(0);
        for (const m of GATED) {
            expect(ALL_HOST_CAPABILITIES).toContain((m as { hostCapability: HostCapability }).hostCapability);
        }
    });

    it("every app-only capability should be declared by some other profile, or it names nothing", () => {
        expect(APP_ONLY_CAPABILITIES.length).toBeGreaterThan(0);
        const others = Object.entries(HOST_PROFILES).filter(([name]) => name !== "vscode");
        expect(others.length).toBeGreaterThan(0);
        for (const cap of APP_ONLY_CAPABILITIES) {
            expect(others.some(([, caps]) => caps.includes(cap)), cap).toBe(true);
            expect(HOST_PROFILES.vscode.includes(cap), cap).toBe(false);
        }
    });

    /**
     * A capability nothing reads is a fact about a host that decides nothing,
     * and it reads exactly like one that does.
     *
     * TWO kinds of reader count, and the second is why this is not simply a
     * walk over the command table. Most capabilities gate a command, so they
     * appear in `EDITOR_COMMANDS`. One does not: `notifications` decides
     * whether the page reports a failed `/ai` run in its own corner or leaves
     * it to a host that has already said so, which is a behaviour inside a
     * plugin rather than a command anyone can run. Its reader is `hostHas`,
     * which is the ONE reader of the declaration (AGENTS.md, "One declaration,
     * one reader"), so a call to it is exactly as good a use as a command gate.
     *
     * The teeth are unchanged: a capability that neither gates a command nor
     * appears in a `hostHas` call anywhere in the tree still fails here.
     */
    it("every capability should be read by a command gate or by hostHas, or it names nothing", () => {
        const gates = new Set(GATED.map((m) => (m as { hostCapability: HostCapability }).hostCapability));
        const source = readSource(["webview", "shared", "src"]);
        const readers = new Set(
            [...source.matchAll(/hostHas\(\s*["'`]([A-Za-z]+)["'`]\s*\)/g)].map((m) => m[1]!));
        // The sweep reached something, or every capability below would be
        // failing for the same reason and this would be reporting a broken
        // instrument as a broken profile.
        expect(readers.size, "no hostHas call sites found; the sweep read nothing").toBeGreaterThan(2);
        for (const cap of ALL_HOST_CAPABILITIES) {
            expect(gates.has(cap) || readers.has(cap), cap).toBe(true);
        }
    });
});

describe("hostHasCommand", () => {
    afterEach(() => { delete g.__i18n; });

    it("an ungated command should run on every host, the empty one included", () => {
        declare([]);
        expect(UNGATED.length).toBeGreaterThan(0);
        for (const m of UNGATED) { expect(hostHasCommand(m.id), m.id).toBe(true); }
    });

    it("a gated command should run exactly when its capability is declared", () => {
        for (const m of GATED) {
            const cap = (m as { hostCapability: HostCapability }).hostCapability;
            declare([]);
            expect(hostHasCommand(m.id), `${m.id} on an empty host`).toBe(false);
            declare([cap]);
            expect(hostHasCommand(m.id), `${m.id} with ${cap}`).toBe(true);
            declare(ALL_HOST_CAPABILITIES.filter((c) => c !== cap));
            expect(hostHasCommand(m.id), `${m.id} without ${cap}`).toBe(false);
        }
    });

    it("an unknown id should be treated as ungated (a safe no-op downstream)", () => {
        declare([]);
        expect(hostHasCommand("notARealCommand")).toBe(true);
    });

    it("the gear menu should keep its layout rows and the cheatsheet on the empty host", () => {
        // The documented `settings` exception: the item stays because these
        // survive; a change here changes what a Jot user sees in the gear.
        declare([]);
        const kept = TOOLBAR_MENU_COMMANDS.filter((m) => hostHasCommand(m.id)).map((m) => m.id);
        expect(kept).toEqual(["customizeToolbar", "hideToolbar", "openShortcutsHelp"]);
    });

    /**
     * The second reason a command can be absent: an arrangement withdraws it.
     * Different in kind from a missing capability (the host COULD answer; the
     * surface has settled the question), identical in effect, and routed
     * through the same predicate so every surface that filters on it is
     * covered without a line of its own.
     */
    it("a withdrawn command should run until its arrangement is declared", () => {
        expect(WITHDRAWN.length).toBeGreaterThan(0);
        for (const m of WITHDRAWN) {
            declareArrangements([]);
            expect(hostHasCommand(m.id), `${m.id} with no arrangement`).toBe(true);
            declareArrangements([m.absentUnder]);
            expect(hostHasCommand(m.id), `${m.id} under ${m.absentUnder}`).toBe(false);
            // A DIFFERENT arrangement must not withdraw it, or the predicate is
            // answering "any arrangement at all" rather than the named one.
            const other = ALL_HOST_ARRANGEMENTS.filter((a) => a !== m.absentUnder);
            expect(other.length).toBeGreaterThan(0);
            declareArrangements(other);
            expect(hostHasCommand(m.id), `${m.id} under the others`).toBe(true);
        }
    });

    it("every absentUnder should name a real arrangement", () => {
        for (const m of WITHDRAWN) {
            expect(ALL_HOST_ARRANGEMENTS, m.id).toContain(m.absentUnder);
        }
    });

    it("an arrangement should withdraw nothing a capability already gates", () => {
        // The two reasons must stay separable: a command carrying both would
        // make "why is this absent" unanswerable from the declaration.
        for (const m of WITHDRAWN) {
            expect("hostCapability" in m && m.hostCapability, m.id).toBeFalsy();
        }
    });

    it("the gear should lose its layout rows under a fixed toolbar layout", () => {
        // The observable half of the withdrawal, at the surface a Jot user
        // actually reads. Asserted against the same host WITHOUT the
        // arrangement, so the case discriminates rather than describing a
        // menu that was short anyway.
        declareArrangements([]);
        const before = TOOLBAR_MENU_COMMANDS.filter((m) => hostHasCommand(m.id)).map((m) => m.id);
        declareArrangements(["fixedToolbarLayout"]);
        const after = TOOLBAR_MENU_COMMANDS.filter((m) => hostHasCommand(m.id)).map((m) => m.id);
        expect(before).toContain("customizeToolbar");
        expect(before).toContain("hideToolbar");
        expect(after).not.toContain("customizeToolbar");
        expect(after).not.toContain("hideToolbar");
        // Everything else survives: this withdraws two rows, not a menu.
        expect(after).toEqual(before.filter((id) => id !== "customizeToolbar" && id !== "hideToolbar"));
        expect(after.length).toBeGreaterThan(0);
    });
});

/**
 * `HOST_PROFILES.jot` is the source, and nothing imports it: the shell is Swift
 * and the harness pages are HTML, so both restate the list as a literal. This
 * is what makes it one declaration rather than three that agree by luck. Each
 * check parses its file rather than trusting a comment to be obeyed.
 */
describe("the Jot profile's copies", () => {
    const repoRoot = ROOT;
    const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

    /** The elements of the first `<key>: [ ... ]` literal in `src`. */
    function listedUnder(key: string, src: string): string[] {
        const m = new RegExp(`"?${key}"?:\\s*\\[([^\\]]*)\\]`).exec(src);
        if (!m) { throw new Error(`no ${key} literal found`); }
        return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    }

    /**
     * Capabilities, wherever the declarer spells them. Swift names the list
     * `hostCapabilities` where it builds the BootConfig and the page names it
     * `capabilities` inside the profile object; both are the same list, and
     * the point of the guard is that they hold the same entries.
     */
    function declaredIn(src: string): string[] {
        return /hostCapabilities:/.test(src)
            ? listedUnder("hostCapabilities", src)
            : listedUnder("capabilities", src);
    }

    /** The `window.__i18n = { ... }` bootstrap line, which is the declaration;
     *  prose about the field in a comment is not one. */
    function bootstrapLine(src: string): string {
        const line = src.split("\n").find((l) => l.includes("window.__i18n"));
        if (!line) { throw new Error("no window.__i18n bootstrap found"); }
        return line;
    }

    it("the Swift shell should declare exactly the profile", () => {
        const swift = read("jot/Sources/BirtaJot/Preferences.swift");
        // Fail loudly if the call moved, rather than matching some other array.
        expect(swift).toContain("func bootConfig()");
        expect(declaredIn(swift.slice(swift.indexOf("func bootConfig()")))).toEqual([...HOST_PROFILES.jot]);
    });

    it("the e2e Jot page should declare exactly the profile", () => {
        expect(declaredIn(bootstrapLine(read("e2e/jotHost/index.html")))).toEqual([...HOST_PROFILES.jot]);
    });

    it("the VS Code page should import its capabilities and declare the other two empty", () => {
        // The one declarer that does NOT restate the profile: it imports
        // `HOST_PROFILES.vscode`, so its capabilities cannot drift. The pair
        // beside them are bare literals, and this is the only thing that reads
        // them; without it they are unguarded, which no run reports.
        const html = read("src/webviewHtml.ts");
        expect(html).toContain("HOST_PROFILES.vscode");
        expect(html).toContain("arrangements: [], shortcuts: []");
    });

    it("the e2e control page should declare nothing at all, which is what absent-means-the-vscode-profile needs", () => {
        expect(bootstrapLine(read("e2e/jotHost/control.html"))).not.toContain("host:");
    });

    /**
     * The other two thirds of the profile, which had no guard at all before it
     * became one object. Arrangements and shortcuts were added as separate
     * bare fields, so Swift could have stopped declaring either and every test
     * would still have passed: the e2e page carries its own copy and nothing
     * compared them. One key is what makes one guard possible.
     */
    it("both Jot declarers should carry the same arrangements", () => {
        const swift = read("jot/Sources/BirtaJotCore/Bridge.swift");
        const page = bootstrapLine(read("e2e/jotHost/index.html"));
        const fromSwift = listedUnder("arrangements", swift);
        const fromPage = listedUnder("arrangements", page);
        expect(fromSwift.length).toBeGreaterThan(0);
        expect(fromPage).toEqual(fromSwift);
        for (const a of fromSwift) { expect(ALL_HOST_ARRANGEMENTS).toContain(a); }
    });

    it("the Jot shell should declare shortcuts, and from its own menu table", () => {
        // Not a list comparison against a literal: the shell builds these from
        // JotMenu, so the guard is that it declares SOME and that the table is
        // what feeds them. A literal list here would be a fourth copy.
        const bridge = read("jot/Sources/BirtaJotCore/Bridge.swift");
        expect(bridge).toContain('"shortcuts"');
        const prefs = read("jot/Sources/BirtaJot/Preferences.swift");
        expect(prefs).toContain("JotMenu.shortcuts");
    });

    it("the e2e page should declare the shortcuts the app actually binds", () => {
        // The comparison the check above cannot make, made against the SOURCE
        // rather than a literal, so it is still not a fourth copy. Without it
        // the harness can assert whatever it likes about a cheatsheet the app
        // never ships, and be right about neither.
        const menu = read("jot/Sources/BirtaJot/JotMenu.swift");
        const bound = [...menu.matchAll(/\.init\(title: "([^"]+)"/g)].map((m) => m[1]!);
        expect(bound.length).toBeGreaterThan(2);

        const page = bootstrapLine(read("e2e/jotHost/index.html"));
        const declared = [...page.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]!);
        expect(declared).toEqual(bound);
    });
});
