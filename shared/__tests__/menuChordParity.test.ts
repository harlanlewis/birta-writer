/**
 * Policy guard: the same gesture means the same thing on both surfaces.
 *
 * Jot's menu IS its keyboard. The extension's keyboard is `package.json`'s
 * contributed keybindings plus the editor's own fixed keymaps. Nothing but
 * this file connects them, and without it the two drift silently in the
 * direction that is hardest to notice: a chord that works in one surface and
 * does something else in the other, discovered by muscle memory rather than by
 * a failure.
 *
 * Four questions, and the last two are the ones a green suite would otherwise
 * never ask:
 *
 *  1. Does every menu row name a real editor command?
 *  2. Is that command one this host can actually honour (`hostHasCommand`), or
 *     is the menu offering something the editor will ignore?
 *  3. Does the chord match the one the extension contributes for the same
 *     command — or, for a command the extension does not contribute because
 *     the editor binds it outright, the fixed keymap's?
 *  4. Which contributed chords does Jot NOT bind? That set is written down
 *     with a reason each, so a new keybinding in package.json fails here until
 *     someone has answered "does the app want this too?". A guard that only
 *     checks what IS bound cannot ask that question, and the answer it needs
 *     is the one nobody thinks to give.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { EDITOR_COMMANDS, EDITOR_COMMAND_PREFIX } from "../editorCommands";
import { HOST_PROFILES, hostHasCommand, type HostArrangement } from "../hostProfile";
import { FIXED_COMMAND_CHORDS } from "../fixedChords";
import { KEYMAP_CHORDS } from "./keymapChords";
import { parseJotMenu, keyedRows, type JotMenuRow } from "./jotMenuTable";
import {
    ITEM_COMMANDS,
    computeDockPartition,
    hostAvailableItems,
} from "../../webview/components/toolbar/registry";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const ROWS: JotMenuRow[] = parseJotMenu(REPO_ROOT);

interface Keybinding {
    command?: string;
    key?: string;
    mac?: string;
    when?: string;
}

/**
 * A chord as a comparable string: modifiers sorted, then the key. VS Code
 * spells a chord "cmd+alt+1" and the page's notation spells the same chord
 * "Mod-Alt-1", and neither order is the other's, so both are reduced to one
 * form rather than one being rewritten into the other's dialect.
 */
function normalizeVsCode(chord: string): string {
    // Split on a "+" that is not the last character, for the reason
    // `normalizeChord` splits on a hyphen that way: each notation spells its
    // separator and one of its keys with the same character, so a chord whose
    // KEY is that character comes apart into empty segments and normalizes to
    // the modifiers alone, which is a value another chord can equal.
    const tokens = chord.split(/\+(?!$)/).map((t) => t.trim().toLowerCase());
    const key = tokens[tokens.length - 1]!;
    const mods = tokens.slice(0, -1).filter((t) => t !== "").sort();
    return [...mods, key].join("+");
}

/** The same, from the page's notation ("Mod-Alt-1", "Mod--"). */
function normalizeChord(chord: string): string {
    // Split the way prosemirror-keymap does, so a chord whose KEY is the
    // hyphen stays one part rather than two empty ones.
    const parts = chord.split(/-(?!$)/);
    const key = parts[parts.length - 1]!.toLowerCase();
    const mods = parts.slice(0, -1).map((p) => {
        switch (p) {
        case "Mod": return "cmd";
        case "Ctrl": return "ctrl";
        case "Alt": return "alt";
        case "Shift": return "shift";
        default: return p.toLowerCase();
        }
    }).sort();
    return [...mods, key].join("+");
}

/** Every mac-effective chord the extension contributes, per bare command id. */
function contributedMacChords(): Map<string, Set<string>> {
    const pkg = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { contributes: { keybindings: Keybinding[] } };
    const out = new Map<string, Set<string>>();
    for (const binding of pkg.contributes.keybindings) {
        const command = binding.command ?? "";
        if (!command.startsWith(EDITOR_COMMAND_PREFIX)) { continue; }
        // `mac` overrides `key` on macOS; an entry with only `key` applies
        // there too, which is why findNext has both f3 and ⌘G.
        const chord = binding.mac ?? binding.key;
        if (chord === undefined || chord === "") { continue; }
        const id = command.slice(EDITOR_COMMAND_PREFIX.length);
        const set = out.get(id) ?? new Set<string>();
        set.add(normalizeVsCode(chord));
        out.set(id, set);
    }
    return out;
}

const CONTRIBUTED = contributedMacChords();
const COMMAND_IDS = new Set(EDITOR_COMMANDS.map((c) => c.id as string));
const COMMAND_ROWS = keyedRows(ROWS).filter((r) => r.command !== null);
/** Every command any menu row runs, keyed or not: a row with no chord is
 *  still a way in, and coverage is about reachability rather than keys. */
const COMMAND_IDS_ON_MENUS = ROWS.filter((r) => r.command !== null).map((r) => r.command!);

/**
 * Chords Jot binds that the extension does not contribute for the same
 * command, each with the reason the two deliberately differ.
 *
 * An exemption is a decision, so it carries the decision's argument. It is
 * also checked in both directions: an entry that no longer diverges fails,
 * because an exemption nobody removed is a hole nobody can see.
 */
const INTENTIONAL_DIVERGENCE: Record<string, string> = {
    increaseFontSize:
        "⌘+ / ⌘- / ⌘0 are the standard View-menu zoom trio in a macOS app, and " +
        "inside VS Code they are the WORKBENCH's own zoom, which an editor " +
        "living in it must not take from the window around it. So the commands " +
        "ship contributed-but-unbound there and bound here.",
    decreaseFontSize: "See increaseFontSize: the same trio, the same reason.",
    resetFontSize: "See increaseFontSize: the same trio, the same reason.",
};

/**
 * Contributed chords Jot does NOT bind, with the reason each is absent.
 *
 * The half a guard forgets. Everything above measures rows that exist; this
 * measures the ones that do not, which is where a keyboard silently stops
 * being the same keyboard.
 */
const NOT_BOUND_IN_JOT: Record<string, string> = {
    openBlockMenu:
        "⌘. is the platform's Cancel. A main-menu key equivalent for it would " +
        "sit in front of every sheet this app puts up, and the block menu has " +
        "the gutter and the slash menu as its other ways in.",
    pasteAsPlainText:
        "The command takes the clipboard text as an ARGUMENT, supplied by the " +
        "host (the webview never reads the clipboard). Jot's menu rows carry a " +
        "command id and nothing else, so the row would be a no-op; in WebKit " +
        "the page's own Shift+paste path already covers the gesture.",
};

describe("the comparable form both notations reduce to", () => {
    it("a chord whose key is its own notation's separator should keep that key", () => {
        // The zoom trio is the case that needs it: "+" separates a VS Code
        // chord and "-" separates a page chord, and each is also a key the View
        // menu binds. Split on every occurrence and the key leaves with the
        // separator, so the chord reduces to its modifiers alone: a real match
        // reads as a mismatch, and "every recorded divergence should still be
        // one" can never retire the exemption it exists for.
        expect(normalizeVsCode("cmd++")).toBe("cmd++");
        expect(normalizeVsCode("cmd+-")).toBe("cmd+-");
        expect(normalizeChord("Mod-+")).toBe("cmd++");
        expect(normalizeChord("Mod--")).toBe("cmd+-");
        // And the whole point of two normalizers: one gesture, one string,
        // whichever dialect spelled it.
        expect(normalizeVsCode("shift+cmd+m")).toBe(normalizeChord("Mod-Shift-m"));
        expect(normalizeVsCode("cmd+alt+1")).toBe(normalizeChord("Mod-Alt-1"));
    });
});

describe("Jot's menu rows", () => {
    it("the table should have been read whole", () => {
        // An enumeration that reached nothing passes every check written over
        // it, so the size is asserted before anything is concluded from it.
        expect(ROWS.length).toBeGreaterThan(40);
        expect(COMMAND_ROWS.length).toBeGreaterThan(20);
        // Every menu the table declares should actually appear in it.
        expect([...new Set(ROWS.map((r) => r.menu))].sort())
            .toEqual(["app", "edit", "file", "format", "help", "view"]);
    });

    it("every command row should name a command that exists", () => {
        const unknown = ROWS
            .filter((r) => r.command !== null && !COMMAND_IDS.has(r.command))
            .map((r) => `${r.title} → ${r.command}`);
        expect(unknown).toEqual([]);
    });

    it("every command row should name one this host can honour", () => {
        // The same predicate every surface reads, asked with Jot's own
        // profile: a capability it does not declare, or an arrangement that
        // withdraws the command, means `runEditorCommand` ignores it and the
        // menu row would be dead. Full Width and Edit Raw Markdown are the
        // live examples, and this is what keeps them out.
        const declared = (globalThis as { __i18n?: unknown }).__i18n;
        (globalThis as { __i18n?: unknown }).__i18n = {
            host: {
                capabilities: HOST_PROFILES.jot,
                arrangements: jotArrangements(),
                shortcuts: [],
            },
        };
        try {
            const dead = ROWS
                .filter((r) => r.command !== null && !hostHasCommand(r.command))
                .map((r) => `${r.title} → ${r.command}`);
            expect(dead).toEqual([]);
        } finally {
            (globalThis as { __i18n?: unknown }).__i18n = declared;
        }
    });

    it("no two rows in the same menu should bind the same chord", () => {
        // A duplicate key equivalent is a row that never fires: AppKit gives
        // the key to the first item it finds.
        const seen = new Map<string, string>();
        const clashes: string[] = [];
        for (const row of keyedRows(ROWS)) {
            const chord = normalizeChord(row.chord!);
            const first = seen.get(chord);
            if (first !== undefined) {
                clashes.push(`${chord}: ${first} and ${row.title}`);
            } else {
                seen.set(chord, row.title);
            }
        }
        expect(clashes).toEqual([]);
    });
});

describe("chord parity with the extension", () => {
    it("every bound command should carry the extension's chord for it", () => {
        const mismatched: string[] = [];
        for (const row of COMMAND_ROWS) {
            const id = row.command!;
            if (id in INTENTIONAL_DIVERGENCE) { continue; }
            const jot = normalizeChord(row.chord!);
            const contributed = CONTRIBUTED.get(id);
            const fixed = FIXED_COMMAND_CHORDS[id as keyof typeof FIXED_COMMAND_CHORDS];
            const allowed = new Set<string>(contributed ?? []);
            if (fixed !== undefined) { allowed.add(normalizeChord(fixed)); }
            if (allowed.size === 0) {
                mismatched.push(
                    `${row.title} (${id}) binds ${jot}, and the extension binds nothing ` +
                        "for it — either contribute the chord there or record the " +
                        "divergence in INTENTIONAL_DIVERGENCE with its reason",
                );
            } else if (!allowed.has(jot)) {
                mismatched.push(
                    `${row.title} (${id}) binds ${jot}; the extension binds ` +
                        `${[...allowed].sort().join(", ")}`,
                );
            }
        }
        expect(mismatched).toEqual([]);
    });

    it("a menu chord the editor already binds should run that same binding", () => {
        // The third table, and the one the two above cannot see. AppKit takes
        // a menu key equivalent before the page sees the keydown, so a row
        // binding a chord some ProseMirror keymap owns REPLACES that binding in
        // Jot. Harmless where the row runs what the keymap runs, and silent
        // breakage otherwise: the keymap's binding stops happening, in one
        // surface, with nothing failing anywhere. `KEYMAP_CHORDS` records the
        // chords without their commands, so `FIXED_COMMAND_CHORDS` is the
        // command-to-chord half a row has to be found in.
        const owned = new Set(
            Object.values(KEYMAP_CHORDS)
                .flatMap((file) => Object.keys(file))
                .map(normalizeChord),
        );
        const stolen: string[] = [];
        let overlapping = 0;
        for (const row of keyedRows(ROWS)) {
            const jot = normalizeChord(row.chord!);
            if (!owned.has(jot)) { continue; }
            overlapping += 1;
            const fixed = row.command === null
                ? undefined
                : FIXED_COMMAND_CHORDS[row.command as keyof typeof FIXED_COMMAND_CHORDS];
            if (fixed === undefined || normalizeChord(fixed) !== jot) {
                stolen.push(
                    `${row.title} binds ${jot}, which a webview keymap already binds for ` +
                        "something else, so the menu takes that key and the editor's own " +
                        "binding stops firing in Jot",
                );
            }
        }
        expect(stolen).toEqual([]);
        // And the sweep has to have met the overlap it is written about: zero
        // rows compared is the state in which every line above is decoration.
        expect(overlapping).toBe(Object.keys(FIXED_COMMAND_CHORDS).length);
    });

    it("the fixed-chord table should agree with the keymap that binds them", () => {
        // `shared/fixedChords.ts` is what chrome prints and what a Bold menu
        // row is measured against. It is a claim about formatKeymap's bindings,
        // so it is checked against the inventory of them rather than trusted.
        const bound = new Set(Object.keys(KEYMAP_CHORDS["webview/plugins/formatKeymap.ts"]!));
        expect(bound.size).toBe(4);
        for (const chord of Object.values(FIXED_COMMAND_CHORDS)) {
            expect(bound).toContain(chord);
        }
        expect(Object.keys(FIXED_COMMAND_CHORDS).length).toBe(bound.size);
    });

    it("every recorded divergence should still be one", () => {
        for (const [id, reason] of Object.entries(INTENTIONAL_DIVERGENCE)) {
            expect(COMMAND_IDS.has(id), `${id} is not a command`).toBe(true);
            expect(reason.length, `${id} has no reason`).toBeGreaterThan(40);
            const row = COMMAND_ROWS.find((r) => r.command === id);
            expect(row, `${id} is exempt from parity but binds nothing in Jot`)
                .not.toBeUndefined();
            const contributed = CONTRIBUTED.get(id);
            const agrees = contributed?.has(normalizeChord(row!.chord!)) ?? false;
            expect(agrees, `${id} no longer diverges — drop the exemption`).toBe(false);
        }
    });

    it("the contributed chords Jot does not bind should be exactly the recorded ones", () => {
        const boundIds = new Set(COMMAND_ROWS.map((r) => r.command!));
        const missing = [...CONTRIBUTED.keys()].filter((id) => !boundIds.has(id)).sort();
        expect(
            missing,
            "A contributed keybinding is not on any Jot menu. Add the row, or " +
                "record it in NOT_BOUND_IN_JOT with the reason it stays absent.",
        ).toEqual(Object.keys(NOT_BOUND_IN_JOT).sort());
        for (const [id, reason] of Object.entries(NOT_BOUND_IN_JOT)) {
            expect(COMMAND_IDS.has(id), `${id} is not a command`).toBe(true);
            expect(reason.length, `${id} has no reason`).toBeGreaterThan(40);
        }
    });
});

/**
 * The menus against the panel's own controls.
 *
 * The parity checks above ask whether Jot's chords agree with the extension's.
 * This asks the other question, and nothing was asking it: whether the menu
 * REACHES what the panel already offers. A control the user can click and
 * cannot find in a menu is not a broken keyboard, it is a menu bar that is
 * quietly a subset of the toolbar, and the only thing that had ever said
 * otherwise was a changelog sentence.
 *
 * Derived from the two registry tables rather than from a list here, so a new
 * item added to the formatting row joins this by existing. Both are exhaustive
 * by type (`Record<ToolbarItemId, …>`), and `toolbarRegistry.test.ts` already
 * ties them to each other, so the enumeration cannot silently shrink.
 *
 * The row itself is asked of `computeDockPartition`, the function that builds
 * it, rather than re-derived: a guard that re-implements the partition agrees
 * with its own copy of the rule and not with the panel.
 */
describe("the menus against the panel's formatting row", () => {
    /**
     * Dock commands with no menu row, each with the reason there is none.
     *
     * Checked in both directions, like the two tables above: an entry that
     * gains a row fails, so an exemption cannot outlive the gap it records.
     */
    const NOT_ON_A_MENU: Record<string, string> = {
        toggleCallout:
            "It takes the callout KIND as an argument, supplied by the control " +
            "that runs it (the quote picker's turn-into rows). A menu row carries " +
            "a command id and nothing else, so the row would have no kind to " +
            "apply; Format's Callout row is `insertCallout`, the plain insert, which " +
            "is the whole of the gesture a menu can offer.",
    };

    /** The dock as the panel builds it, under Jot's own profile. */
    function jotDock(): string[] {
        const declared = (globalThis as { __i18n?: unknown }).__i18n;
        (globalThis as { __i18n?: unknown }).__i18n = {
            host: {
                capabilities: HOST_PROFILES.jot,
                arrangements: jotArrangements(),
                shortcuts: [],
            },
        };
        try {
            return computeDockPartition(hostAvailableItems()).dock;
        } finally {
            (globalThis as { __i18n?: unknown }).__i18n = declared;
        }
    }

    const DOCK = jotDock();
    const ON_A_MENU = new Set(COMMAND_IDS_ON_MENUS);

    it("every command the formatting row runs should be reachable from a menu", () => {
        // The sweep has to have met a row. An empty partition satisfies every
        // per-item assertion below and reports a menu bar that covers
        // everything, having compared nothing.
        expect(DOCK.length, "the formatting row came back empty").toBeGreaterThan(10);

        let checked = 0;
        const missing: string[] = [];
        for (const item of DOCK) {
            const commands = ITEM_COMMANDS[item as keyof typeof ITEM_COMMANDS];
            expect(commands, `${item} runs no command`).toBeDefined();
            for (const command of commands) {
                checked += 1;
                if (ON_A_MENU.has(command)) { continue; }
                if (command in NOT_ON_A_MENU) { continue; }
                missing.push(`${item} → ${command}`);
            }
        }
        expect(checked, "the formatting row's items name almost no commands")
            .toBeGreaterThan(20);
        expect(
            missing,
            "A control on the panel's formatting row runs a command no menu row " +
                "offers. Add the row, or record it in NOT_ON_A_MENU with the reason " +
                `it cannot be one:\n${missing.join("\n")}`,
        ).toEqual([]);
    });

    it("every recorded absence should still be one", () => {
        for (const [command, reason] of Object.entries(NOT_ON_A_MENU)) {
            expect(COMMAND_IDS.has(command), `${command} is not a command`).toBe(true);
            expect(reason.length, `${command} has no reason`).toBeGreaterThan(40);
            expect(
                ON_A_MENU.has(command),
                `${command} is now on a menu — drop the exemption`,
            ).toBe(false);
            // And it is a command the formatting row actually runs, or the
            // exemption is about something this check never looks at.
            const owner = DOCK.find((item) =>
                (ITEM_COMMANDS[item as keyof typeof ITEM_COMMANDS] as readonly string[])
                    .includes(command));
            expect(owner, `${command} is not run by anything on the formatting row`)
                .toBeDefined();
        }
    });
});

/** Jot's declared arrangements, read from the shell rather than restated. */
function jotArrangements(): HostArrangement[] {
    const bridge = fs.readFileSync(
        path.join(REPO_ROOT, "jot/Sources/BirtaJotCore/Bridge.swift"), "utf8");
    const match = bridge.match(/"arrangements":\s*\[([^\]]*)\]/);
    expect(match, "Jot's arrangements are no longer where this expects them").not.toBeNull();
    return [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1] as HostArrangement);
}
