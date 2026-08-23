/**
 * src/keybindings.ts
 *
 * What key ACTUALLY runs each editor command in this VS Code, for the chrome
 * that prints one.
 *
 * WHY THIS IS A FILE READ AND NOT AN API CALL
 * -------------------------------------------
 * VS Code exposes no API for effective keybindings. `webview/commandChords.ts`
 * therefore refuses to print a contributed command's default, because a default
 * is a guess and a tooltip naming a key the user has rebound is worse than one
 * naming none. This module is the source that lets the refusal be lifted: it
 * merges what we contribute (which we ship, so we know it exactly) with what
 * the user's `keybindings.json` overrides, and hands the result to the host
 * profile as declared shortcuts.
 *
 * THE RULE, WHICH IS THE WHOLE DESIGN
 * -----------------------------------
 * Print only what was positively established. Every step below either produces
 * a chord we can defend or produces nothing, and nothing degrades to today's
 * behavior (a bare label) rather than to a confident lie. There is no branch
 * that falls back to the shipped default after a lookup it could not complete.
 *
 * FINDING THE FILE, WHICH IS THE PART THAT IS NOT OBVIOUS
 * ------------------------------------------------------
 * VS Code builds both paths from the active profile's location:
 *
 *   globalStorageHome:   useDefaultFlags.globalState  ? <default>/globalStorage   : <profile>/globalStorage
 *   keybindingsResource: useDefaultFlags.keybindings  ? <default>/keybindings.json : <profile>/keybindings.json
 *
 * and `context.globalStorageUri` is `<globalStorageHome>/<publisher>.<name>`.
 * So `../..` reaches the profile whose global storage we were given, and its
 * sibling `keybindings.json` is the right file ONLY while those two flags
 * agree. They are independent, and VS Code ships a built-in profile where they
 * differ (`Agents`: its own global state, the default profile's shortcuts), so
 * the sibling is not merely a theoretical mismatch.
 *
 * `<User>/globalStorage/storage.json` carries the `userDataProfiles` manifest
 * with those flags, which is what turns the guess into a lookup: resolve the
 * profile, read its `useDefaultFlags.keybindings`, and take the default
 * profile's file when it is set. Anything unreadable ends the lookup.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { EDITOR_COMMANDS, type EditorCommandId } from "../shared/editorCommands";
import { FIXED_COMMAND_CHORDS } from "../shared/fixedChords";
import type { HostShortcut } from "../shared/hostProfile";

/** The prefix every contributed editor command carries (`shared/editorCommands.ts`). */
const COMMAND_PREFIX = "birta.editor.";

/**
 * A `contributes.keybindings` entry. Every key field is optional: `key` is the
 * fallback and `mac`/`win`/`linux` override it, so an entry may carry a
 * platform-specific binding and no `key` at all, and then it is simply not
 * bound on the other platforms. Four of ours are shaped that way.
 */
interface ContributedBinding {
    readonly command: string;
    readonly key?: string;
    readonly mac?: string;
    readonly win?: string;
    readonly linux?: string;
    readonly when?: string;
}

interface UserBinding {
    readonly command?: unknown;
    readonly key?: unknown;
    readonly when?: unknown;
}

/**
 * The active profile's `keybindings.json`, or null where the lookup could not
 * be completed.
 *
 * Exported for the tests, which drive it against fixture directories rather
 * than against whatever profile the machine running them happens to be in.
 */
export function resolveKeybindingsFile(globalStorageFsPath: string): string | null {
    const cached = resolvedFiles.get(globalStorageFsPath);
    if (cached !== undefined) return cached;
    const resolved = resolveUncached(globalStorageFsPath);
    resolvedFiles.set(globalStorageFsPath, resolved);
    return resolved;
}

/**
 * VS Code disposes the webview when you switch away from the rendered editor,
 * so this whole path runs again on every switch back, and the profile manifest
 * it reads is the largest file involved. The active profile cannot change
 * without a new extension host, so the answer is fixed for the process.
 *
 * The user's `keybindings.json` is deliberately NOT cached: it is small, and it
 * is the thing that changes while the process lives.
 */
const resolvedFiles = new Map<string, string | null>();

function resolveUncached(globalStorageFsPath: string): string | null {
    // <profile>/globalStorage/<ext-id> -> <profile>
    const profileDir = path.resolve(globalStorageFsPath, "..", "..");
    const own = path.join(profileDir, "keybindings.json");

    // The default profile IS the User directory, so there is no manifest entry
    // for it and no inherit flag that could redirect it.
    if (path.basename(profileDir) === "User") return own;

    // Otherwise this is <User>/profiles/<location>, where <location> may itself
    // have separators ("builtin/agents"), so walk up to the User directory
    // rather than counting segments.
    const userDir = ancestorNamed(profileDir, "User");
    if (userDir === null) return null;

    const manifest = readJson(path.join(userDir, "globalStorage", "storage.json"));
    const profiles = (manifest as { userDataProfiles?: unknown } | null)?.userDataProfiles;
    if (!Array.isArray(profiles)) return null;

    const location = path.relative(path.join(userDir, "profiles"), profileDir);
    const entry = profiles.find((p) => typeof p?.location === "string" && p.location === location);
    // A profile we cannot find in the manifest is one whose inherit flags we do
    // not know, and the sibling file would be a guess.
    if (entry === undefined) return null;

    return entry.useDefaultFlags?.keybindings === true ? path.join(userDir, "keybindings.json") : own;
}

/** The nearest ancestor of `dir` (inclusive) whose basename is `name`. */
function ancestorNamed(dir: string, name: string): string | null {
    let current = dir;
    for (;;) {
        if (path.basename(current) === name) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function readJson(file: string): unknown {
    try {
        return JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
    } catch {
        return null;
    }
}

/**
 * `keybindings.json` is JSONC, and VS Code writes comments into it itself (the
 * "Place your key bindings in this file" header on a fresh one), so a plain
 * `JSON.parse` fails on the common case rather than the exotic one.
 *
 * Comment runs are replaced by spaces rather than removed so that a `//` inside
 * a string literal, which this must not treat as a comment, is the only thing
 * the string-tracking below has to get right.
 */
export function stripJsonComments(text: string): string {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += text[i + 1] ?? "";
                i += 2;
                continue;
            }
            if (ch === '"') inString = false;
            i += 1;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i += 1;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i += 1;
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
            i += 2;
            continue;
        }
        // A trailing comma is legal in JSONC and fatal to JSON.parse.
        if (ch === ",") {
            const rest = text.slice(i + 1);
            const next = rest.replace(/^(\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, "")[0];
            if (next === "}" || next === "]") {
                out += " ";
                i += 1;
                continue;
            }
        }
        out += ch;
        i += 1;
    }
    return out;
}

/**
 * VS Code's keybinding syntax to ProseMirror keymap notation, which `kbd()`
 * parses and which `HostShortcut.keys` is declared in.
 *
 * Returns null for anything this cannot render faithfully: a chord sequence
 * ("cmd+k cmd+s"), which the tooltip form has no room for, and any key name we
 * would have to guess the spelling of.
 */
export function toKeymapNotation(binding: string, isMac: boolean): string | null {
    const trimmed = binding.trim();
    if (trimmed === "" || /\s/.test(trimmed)) return null;

    const parts = trimmed.split("+");
    const key = parts.pop();
    if (key === undefined || key === "") return null;

    const mods: string[] = [];
    for (const raw of parts) {
        switch (raw.toLowerCase()) {
            // `Mod` is Cmd on macOS and Ctrl elsewhere, which is exactly what
            // VS Code's own `key`/`mac` split already encodes, so the primary
            // modifier of the platform we are on becomes Mod.
            case "cmd":
            case "meta":
            case "win":
                if (!isMac) return null;
                mods.push("Mod");
                break;
            case "ctrl":
                mods.push(isMac ? "Ctrl" : "Mod");
                break;
            case "shift":
                mods.push("Shift");
                break;
            case "alt":
            case "option":
                mods.push("Alt");
                break;
            default:
                return null;
        }
    }

    const named = KEY_NAMES[key.toLowerCase()];
    if (named === undefined && !/^[a-z0-9]$/i.test(key)) return null;
    return [...mods, named ?? key.toLowerCase()].join("-");
}

/** The key spellings ProseMirror's keymap uses, for the names VS Code spells differently. */
const KEY_NAMES: Record<string, string> = {
    escape: "Escape",
    enter: "Enter",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
};

/**
 * The shortcuts this VS Code actually runs, for `window.__i18n.host.shortcuts`.
 *
 * `contributed` and `userFile` are parameters rather than reads so the tests
 * drive real package.json contributions against fixture keybinding files; the
 * caller below supplies both from the running extension.
 */
export function resolveHostShortcuts(
    contributed: readonly ContributedBinding[],
    userEntries: readonly UserBinding[] | null,
    platform: string,
): HostShortcut[] {
    const isMac = platform === "darwin";
    const titles = new Map(EDITOR_COMMANDS.map((c) => [c.id, c.title]));

    // Our own defaults, keyed by the full VS Code command id.
    const effective = new Map<string, { binding: string; when: string | undefined }>();
    for (const c of contributed) {
        if (!c.command.startsWith(COMMAND_PREFIX)) continue;
        const specific = isMac ? c.mac : platform === "win32" ? c.win : c.linux;
        const binding = specific ?? c.key;
        // Bound only on other platforms, so there is nothing to print here.
        if (typeof binding !== "string") continue;
        effective.set(c.command, { binding, when: c.when });
    }

    // A user file we could not read leaves every default unconfirmed, and an
    // unconfirmed default is exactly what this module refuses to print.
    if (userEntries === null) return [];

    for (const entry of userEntries) {
        if (typeof entry.command !== "string") continue;
        const removal = entry.command.startsWith("-");
        const command = removal ? entry.command.slice(1) : entry.command;
        if (!command.startsWith(COMMAND_PREFIX)) continue;

        if (removal) {
            effective.delete(command);
            continue;
        }
        if (typeof entry.key !== "string") continue;

        // A `when` we did not ship is a scope we cannot evaluate here, so the
        // command's key becomes unknowable rather than defaulting to ours.
        const shipped = effective.get(command)?.when;
        const when = typeof entry.when === "string" ? entry.when : undefined;
        if (when !== shipped) {
            effective.delete(command);
            continue;
        }
        effective.set(command, { binding: entry.key, when });
    }

    const shortcuts: HostShortcut[] = [];
    for (const [command, { binding }] of effective) {
        const id = command.slice(COMMAND_PREFIX.length) as EditorCommandId;
        const title = titles.get(id);
        if (title === undefined) continue;
        // A command the editor binds outright keeps the editor's chord.
        // `commandChord` asks the host FIRST, which is right on a surface whose
        // menu intercepts the keydown before the page sees it, and would be
        // wrong here: a ProseMirror keymap fires whatever the user rebinds the
        // contributed command to, so declaring the contributed key would print
        // one true chord in place of the one that cannot be moved.
        if (FIXED_COMMAND_CHORDS[id] !== undefined) continue;
        const keys = toKeymapNotation(binding, isMac);
        if (keys === null) continue;
        shortcuts.push({ keys, label: title, command: id });
    }
    return shortcuts;
}

/**
 * The running extension's answer: its own contributions against the active
 * profile's file.
 *
 * Every field it needs is read defensively for the same reason the rest of this
 * module refuses rather than guesses: a context that cannot answer where its
 * storage is, or what this extension contributes, is a lookup that did not
 * complete, and the caller gets the empty list that prints bare labels.
 */
export function hostShortcutsFor(context: vscode.ExtensionContext, platform: string): HostShortcut[] {
    const contributed = context.extension?.packageJSON?.contributes?.keybindings as
        | ContributedBinding[]
        | undefined;
    const globalStorage = context.globalStorageUri?.fsPath;
    if (!Array.isArray(contributed) || typeof globalStorage !== "string") return [];

    const file = resolveKeybindingsFile(globalStorage);
    if (file === null) return [];

    // A file that does not exist is a positive answer, not a failed lookup:
    // VS Code creates it on the first override, so its absence means none.
    const entries = fs.existsSync(file) ? readJson(file) : [];
    if (!Array.isArray(entries)) return [];

    return resolveHostShortcuts(contributed, entries as UserBinding[], platform);
}
