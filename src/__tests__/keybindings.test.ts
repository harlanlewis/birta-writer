/**
 * Guards on the effective-keybinding lookup that lets VS Code tooltips print a
 * key at all.
 *
 * The invariant every case here is a form of: a chord is printed only when it
 * was positively established, and every incomplete lookup yields nothing rather
 * than the shipped default. That asymmetry is the whole feature — a bare label
 * is the behavior these tooltips already had, and a wrong chord is the outcome
 * `webview/commandChords.ts` refuses to risk.
 *
 * The profile cases are the ones worth reading. VS Code derives an extension's
 * global storage and the user's keybindings file from the same profile
 * location but under INDEPENDENT inherit flags, so the sibling of
 * `globalStorage/` is the right file only while those flags agree, and VS Code
 * ships a built-in profile where they do not.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    resolveHostShortcuts,
    resolveKeybindingsFile,
    stripJsonComments,
    toKeymapNotation,
} from "../keybindings";

let root: string;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "birta-kb-"));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** A user-data directory with the given profiles recorded in the manifest. */
function userDir(profiles: unknown[] = []) {
    const user = path.join(root, "User");
    mkdirSync(path.join(user, "globalStorage"), { recursive: true });
    writeFileSync(
        path.join(user, "globalStorage", "storage.json"),
        JSON.stringify({ userDataProfiles: profiles }),
    );
    return user;
}

const EXT_ID = "birtalabs.birta-writer";

describe("resolveKeybindingsFile", () => {
    it("the default profile should resolve to the User directory's own file", () => {
        const user = userDir();
        const storage = path.join(user, "globalStorage", EXT_ID);
        expect(resolveKeybindingsFile(storage)).toBe(path.join(user, "keybindings.json"));
    });

    it("a profile with its own shortcuts should resolve to the profile's file", () => {
        const user = userDir([{ location: "work", name: "Work", useDefaultFlags: {} }]);
        const profile = path.join(user, "profiles", "work");
        mkdirSync(path.join(profile, "globalStorage"), { recursive: true });
        expect(resolveKeybindingsFile(path.join(profile, "globalStorage", EXT_ID))).toBe(
            path.join(profile, "keybindings.json"),
        );
    });

    it("a profile inheriting shortcuts should resolve to the DEFAULT profile's file", () => {
        // The case the sibling derivation gets wrong. VS Code ships `Agents`
        // exactly like this: its own global state, the default profile's keys.
        const user = userDir([
            { location: "builtin/agents", name: "Agents", useDefaultFlags: { keybindings: true } },
        ]);
        const profile = path.join(user, "profiles", "builtin", "agents");
        mkdirSync(path.join(profile, "globalStorage"), { recursive: true });
        expect(resolveKeybindingsFile(path.join(profile, "globalStorage", EXT_ID))).toBe(
            path.join(user, "keybindings.json"),
        );
        // And specifically NOT the sibling, which is what a naive `../..` gives.
        expect(resolveKeybindingsFile(path.join(profile, "globalStorage", EXT_ID))).not.toBe(
            path.join(profile, "keybindings.json"),
        );
    });

    it("a profile the manifest does not list should end the lookup rather than guess", () => {
        const user = userDir([{ location: "work", name: "Work", useDefaultFlags: {} }]);
        const profile = path.join(user, "profiles", "unknown");
        mkdirSync(path.join(profile, "globalStorage"), { recursive: true });
        expect(resolveKeybindingsFile(path.join(profile, "globalStorage", EXT_ID))).toBeNull();
    });

    it("an unreadable manifest should end the lookup rather than fall back to the sibling", () => {
        const user = path.join(root, "User");
        mkdirSync(path.join(user, "profiles", "work", "globalStorage"), { recursive: true });
        expect(resolveKeybindingsFile(path.join(user, "profiles", "work", "globalStorage", EXT_ID))).toBeNull();
    });
});

describe("stripJsonComments", () => {
    it("the header VS Code writes into a fresh file should parse", () => {
        const text = `// Place your key bindings in this file to override the defaults\n[\n  { "key": "cmd+k", "command": "birta.editor.insertLink" }\n]`;
        expect(JSON.parse(stripJsonComments(text))).toEqual([
            { key: "cmd+k", command: "birta.editor.insertLink" },
        ]);
    });

    it("a comment marker inside a string should survive", () => {
        const text = `[{ "command": "x", "when": "a // b", "key": "/* not a comment */" }]`;
        expect(JSON.parse(stripJsonComments(text))[0].when).toBe("a // b");
        expect(JSON.parse(stripJsonComments(text))[0].key).toBe("/* not a comment */");
    });

    it("a trailing comma should parse", () => {
        expect(JSON.parse(stripJsonComments(`[{ "a": 1 }, ]`))).toEqual([{ a: 1 }]);
    });

    it("a block comment should be removed", () => {
        expect(JSON.parse(stripJsonComments(`[/* off for now */ { "a": 1 }]`))).toEqual([{ a: 1 }]);
    });
});

describe("toKeymapNotation", () => {
    it("the platform's primary modifier should become Mod", () => {
        expect(toKeymapNotation("cmd+b", true)).toBe("Mod-b");
        expect(toKeymapNotation("ctrl+b", false)).toBe("Mod-b");
    });

    it("a non-primary ctrl on mac should stay Ctrl", () => {
        expect(toKeymapNotation("ctrl+b", true)).toBe("Ctrl-b");
    });

    it("modifiers should keep the order they were written in", () => {
        expect(toKeymapNotation("cmd+shift+x", true)).toBe("Mod-Shift-x");
        expect(toKeymapNotation("alt+cmd+1", true)).toBe("Alt-Mod-1");
    });

    it("a named key should get the keymap's spelling", () => {
        expect(toKeymapNotation("cmd+enter", true)).toBe("Mod-Enter");
        expect(toKeymapNotation("shift+tab", true)).toBe("Shift-Tab");
    });

    it("a chord sequence should be refused, because the tooltip form has no room for one", () => {
        expect(toKeymapNotation("cmd+k cmd+s", true)).toBeNull();
    });

    it("a cmd binding on a non-mac platform should be refused rather than rendered", () => {
        expect(toKeymapNotation("cmd+b", false)).toBeNull();
    });

    it("a key name we would have to guess the spelling of should be refused", () => {
        expect(toKeymapNotation("cmd+f13", true)).toBeNull();
        expect(toKeymapNotation("hyper+b", true)).toBeNull();
    });
});

const WHEN = "activeCustomEditorId == 'birta.editor'";
const CONTRIBUTED = [
    { command: "birta.editor.insertLink", key: "ctrl+k", mac: "cmd+k", when: WHEN },
    { command: "birta.editor.toggleBold", key: "ctrl+b", mac: "cmd+b", when: WHEN },
    { command: "birta.notAnEditorCommand", key: "ctrl+q", when: WHEN },
];

const chordFor = (list: readonly { command?: string; keys: string }[], id: string) =>
    list.find((s) => s.command === id)?.keys ?? null;

describe("resolveHostShortcuts", () => {
    it("a user with no overrides should get the shipped defaults, which is the whole point", () => {
        // The positive arm. Every other case here asserts a refusal, and a
        // resolver that returned nothing unconditionally would pass all of them.
        const out = resolveHostShortcuts(CONTRIBUTED, [], "darwin");
        expect(chordFor(out, "insertLink")).toBe("Mod-k");
    });

    it("a command the editor binds outright should NOT be declared as the host's", () => {
        // `commandChord` asks the host before the fixed keymap, so declaring
        // Bold here would let a rebound contributed command shadow ⌘B, which
        // the ProseMirror keymap goes on firing whatever VS Code is bound to.
        const rebound = resolveHostShortcuts(
            CONTRIBUTED,
            [{ command: "birta.editor.toggleBold", key: "cmd+alt+b", when: WHEN }],
            "darwin",
        );
        expect(chordFor(rebound, "toggleBold")).toBeNull();
        expect(chordFor(resolveHostShortcuts(CONTRIBUTED, [], "darwin"), "toggleBold")).toBeNull();
    });

    it("a rebound command should print the user's key, not ours", () => {
        const out = resolveHostShortcuts(
            CONTRIBUTED,
            [{ command: "birta.editor.insertLink", key: "cmd+shift+u", when: WHEN }],
            "darwin",
        );
        expect(chordFor(out, "insertLink")).toBe("Mod-Shift-u");
    });

    it("a removal should leave the command with no printable key", () => {
        const out = resolveHostShortcuts(
            CONTRIBUTED,
            [{ command: "-birta.editor.insertLink", key: "cmd+k", when: WHEN }],
            "darwin",
        );
        expect(chordFor(out, "insertLink")).toBeNull();
    });

    it("a user binding scoped by a when clause we did not ship should print nothing", () => {
        // Applicability is not evaluable here, so the command becomes
        // unknowable rather than falling back to our default.
        const out = resolveHostShortcuts(
            CONTRIBUTED,
            [{ command: "birta.editor.insertLink", key: "cmd+shift+u", when: "editorTextFocus" }],
            "darwin",
        );
        expect(chordFor(out, "insertLink")).toBeNull();
    });

    it("an unreadable user file should print nothing for every command", () => {
        expect(resolveHostShortcuts(CONTRIBUTED, null, "darwin")).toEqual([]);
    });

    it("a command that is not an editor command should not reach the profile", () => {
        const out = resolveHostShortcuts(CONTRIBUTED, [], "darwin");
        expect(out.some((s) => s.command === "notAnEditorCommand")).toBe(false);
        expect(out.some((s) => s.label === undefined)).toBe(false);
    });

    it("the mac binding should be preferred on mac and the base one elsewhere", () => {
        expect(chordFor(resolveHostShortcuts(CONTRIBUTED, [], "darwin"), "insertLink")).toBe("Mod-k");
        expect(chordFor(resolveHostShortcuts(CONTRIBUTED, [], "linux"), "insertLink")).toBe("Mod-k");
    });

    it("a platform-specific binding with no base key should apply only on that platform", () => {
        // Four shipped contributions are shaped this way (`mac` or `win`/`linux`
        // and no `key`), and reading `key` unconditionally crashed on them.
        const platformOnly = [
            { command: "birta.editor.findNext", mac: "cmd+g", when: WHEN },
            { command: "birta.editor.openFindReplace", win: "ctrl+h", linux: "ctrl+h", when: WHEN },
        ];
        const mac = resolveHostShortcuts(platformOnly, [], "darwin");
        expect(chordFor(mac, "findNext")).toBe("Mod-g");
        expect(chordFor(mac, "openFindReplace")).toBeNull();

        const linux = resolveHostShortcuts(platformOnly, [], "linux");
        expect(chordFor(linux, "openFindReplace")).toBe("Mod-h");
        expect(chordFor(linux, "findNext")).toBeNull();

        expect(chordFor(resolveHostShortcuts(platformOnly, [], "win32"), "openFindReplace")).toBe("Mod-h");
    });

    it("every shortcut should carry the command's own title as its label", () => {
        const out = resolveHostShortcuts(CONTRIBUTED, [], "darwin");
        expect(out.find((s) => s.command === "insertLink")?.label).toBe("Insert/Edit Link");
    });

    it("the real contributions should light up a useful number of commands", () => {
        // A sweep that reached nothing passes, and every case above uses a
        // three-entry fixture. This one runs the shipped package.json, so a
        // resolver that silently dropped most commands is visible here.
        const shipped = JSON.parse(
            readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"),
        ).contributes.keybindings;
        const out = resolveHostShortcuts(shipped, [], "darwin");
        expect(out.length).toBeGreaterThanOrEqual(15);
        expect(out.every((s) => s.keys.length > 0 && s.label.length > 0)).toBe(true);
    });
});
