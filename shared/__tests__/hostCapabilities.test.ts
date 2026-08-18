/**
 * The host-capability registry (MAR-373): the absent-means-all rule, the
 * profiles table, and the command predicate every surface reads.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ALL_HOST_CAPABILITIES,
    HOST_PROFILES,
    hostHas,
    hostHasCommand,
    type HostCapability,
} from "../hostCapabilities";
import { EDITOR_COMMANDS, TOOLBAR_MENU_COMMANDS } from "../editorCommands";

type Declared = { __i18n?: { hostCapabilities?: readonly HostCapability[] } };
const g = globalThis as Declared;

function declare(caps: readonly HostCapability[] | undefined): void {
    g.__i18n = caps === undefined ? { } : { hostCapabilities: caps };
}

const GATED = EDITOR_COMMANDS.filter((m) => "hostCapability" in m && m.hostCapability);
const UNGATED = EDITOR_COMMANDS.filter((m) => !("hostCapability" in m) || !m.hostCapability);

describe("hostHas", () => {
    afterEach(() => { delete g.__i18n; });

    it("no declaration at all should mean every capability", () => {
        delete g.__i18n;
        for (const cap of ALL_HOST_CAPABILITIES) { expect(hostHas(cap)).toBe(true); }
    });

    it("an __i18n without the field should mean every capability", () => {
        declare(undefined);
        for (const cap of ALL_HOST_CAPABILITIES) { expect(hostHas(cap)).toBe(true); }
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
        expect([...HOST_PROFILES.vscode].sort()).toEqual([...ALL_HOST_CAPABILITIES].sort());
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

    it("every capability should gate at least one command, or it names nothing", () => {
        const used = new Set(GATED.map((m) => (m as { hostCapability: HostCapability }).hostCapability));
        for (const cap of ALL_HOST_CAPABILITIES) { expect(used.has(cap), cap).toBe(true); }
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
});

/**
 * `HOST_PROFILES.jot` is the source, and nothing imports it: the shell is Swift
 * and the harness pages are HTML, so both restate the list as a literal. This
 * is what makes it one declaration rather than three that agree by luck. Each
 * check parses its file rather than trusting a comment to be obeyed.
 */
describe("the Jot profile's copies", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

    /** The elements of the first `hostCapabilities: [ ... ]` literal in `src`. */
    function declaredIn(src: string): string[] {
        const m = /hostCapabilities:\s*\[([^\]]*)\]/.exec(src);
        if (!m) { throw new Error("no hostCapabilities literal found"); }
        return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
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

    it("the e2e control page should declare nothing at all, which is what absent-means-all needs", () => {
        expect(bootstrapLine(read("e2e/jotHost/control.html"))).not.toContain("hostCapabilities");
    });
});
