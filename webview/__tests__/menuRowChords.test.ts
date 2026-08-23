/**
 * Dropdown menu rows print the chord the host binds, or nothing.
 *
 * The enumeration is derived from `ITEM_COMMANDS` rather than hand-listed, so a
 * new toolbar item joins this guard by existing. A hand-written list of rows is
 * a list a new row never joins, which is the shape that let the buttons get
 * their chords while the rows silently did not.
 *
 * The load-bearing pair is the one below the coverage count: the same menus are
 * built twice, once with a host declaring the chords and once with a host
 * declaring nothing, and the second build must print nothing at all. Without it
 * every assertion here would pass on a row that printed a hardcoded string.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { createFormatMenu, createListMenu, createQuoteMenu } from "../components/toolbar/containerPickers";
import { ITEM_COMMANDS } from "../components/toolbar/registry";
import { commandChord } from "../commandChords";
import { kbd } from "../i18n";
import type { EditorCommandId } from "../../shared/editorCommands";

interface HostWindow {
    __i18n?: { host?: { capabilities?: string[]; arrangements?: string[]; shortcuts?: unknown[] } };
}

/** A host that binds these commands, the way a shell's bootstrap declares them. */
function declare(commands: readonly [EditorCommandId, string][]): void {
    (globalThis as HostWindow).__i18n = {
        host: {
            capabilities: [],
            arrangements: [],
            shortcuts: commands.map(([command, keys]) => ({ command, keys, label: command })),
        },
    };
}

/** The chords a host would plausibly bind for the rows these menus draw. */
const DECLARED: readonly [EditorCommandId, string][] = [
    ["setHeading1", "Alt-Mod-1"],
    ["setHeading2", "Alt-Mod-2"],
    ["setHeading3", "Alt-Mod-3"],
    ["toggleBulletList", "Mod-Shift-8"],
    ["toggleOrderedList", "Mod-Shift-7"],
    ["toggleTaskList", "Mod-Shift-9"],
    ["toggleBlockquote", "Mod-Shift-."],
];

let editors: Editor[] = [];

async function makeEditor(): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, "hello\n");
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

/** Every menu that draws command rows, built and concatenated. */
async function buildMenus(): Promise<HTMLElement> {
    const editor = await makeEditor();
    const getEditor = (): Editor => editor;
    const host = document.createElement("div");
    host.append(
        createFormatMenu(getEditor).el,
        createListMenu(getEditor).el,
        createQuoteMenu(getEditor).el,
    );
    document.body.appendChild(host);
    return host;
}

/** The chord text each row prints, keyed by the row's visible label. */
function printedChords(host: HTMLElement): string[] {
    return [...host.querySelectorAll(".tb-menu-chord")].map((el) => el.textContent ?? "");
}

beforeEach(() => {
    editors = [];
});

afterEach(async () => {
    for (const e of editors) await e.destroy();
    document.body.innerHTML = "";
    delete (globalThis as HostWindow).__i18n;
});

describe("dropdown menu row chords", () => {
    it("a row whose command the host binds should print that chord", async () => {
        declare(DECLARED);
        const printed = printedChords(await buildMenus());
        for (const [command, keys] of DECLARED) {
            expect(printed, `${command} should print ${keys}`).toContain(kbd(keys));
        }
    });

    it("the same menus with no host declaration should print nothing", async () => {
        // The discriminating arm. The menus here draw only rebindable commands,
        // so with nothing declared `commandChord` refuses every one of them and
        // a row that printed a hardcoded default would show up as a survivor.
        const printed = printedChords(await buildMenus());
        expect(printed).toEqual([]);
    });

    it("every ITEM_COMMANDS entry with a printable chord should be printed by some row", async () => {
        // Derived coverage. `ITEM_COMMANDS` is the table the toolbar is built
        // from, so this asks the question of the whole surface rather than of
        // the rows somebody remembered.
        declare(DECLARED);
        const host = await buildMenus();
        const printed = new Set(printedChords(host));

        const rowCommands = [
            ...ITEM_COMMANDS.format,
            ...ITEM_COMMANDS.listMenu,
            ...ITEM_COMMANDS.quote,
        ];
        const resolvable = rowCommands.filter((id) => commandChord(id) !== null);

        // Assert the sweep reached something before asserting what it found:
        // an empty `resolvable` would make the loop below vacuously true.
        expect(resolvable.length).toBeGreaterThanOrEqual(DECLARED.length - 1);

        const missing = resolvable.filter((id) => !printed.has(kbd(commandChord(id)!)));
        expect(missing, `rows for these commands print no chord: ${missing.join(", ")}`).toEqual([]);
    });

    it("a row sharing a command with an argument should NOT print the bare chord", async () => {
        // Every callout row runs toggleCallout with a different kind, so a
        // shared chord would claim each of them does what one of them does.
        declare([...DECLARED, ["toggleCallout", "Mod-Shift-c"]]);
        const host = await buildMenus();
        expect(printedChords(host)).not.toContain(kbd("Mod-Shift-c"));
        // and the argument-free Blockquote row in the same menu still prints
        expect(printedChords(host)).toContain(kbd("Mod-Shift-."));
    });

    it("a chord should be hidden from the accessibility tree, as the buttons' are", async () => {
        declare(DECLARED);
        const host = await buildMenus();
        const chords = [...host.querySelectorAll(".tb-menu-chord")];
        expect(chords.length).toBeGreaterThan(0);
        expect(chords.every((el) => el.getAttribute("aria-hidden") === "true")).toBe(true);
    });
});
