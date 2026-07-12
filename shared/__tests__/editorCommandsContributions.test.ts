/**
 * Drift guard (MAR-9): the editor commands contributed in package.json must
 * stay in lockstep with the shared command table (shared/editorCommands.ts),
 * which is itself the source of truth for the extension registration and the
 * webview registry (typed as Record<EditorCommandId, …>).
 *
 * Verifies, in both directions:
 *   - every contributed `markdownWysiwyg.editor.*` command has a table entry;
 *   - every table entry is contributed, with an nls title, correct command
 *     palette gating, and a right-click menu item per declared section.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    EDITOR_COMMANDS,
    EDITOR_COMMAND_PREFIX,
    editorCommandName,
    TOOLBAR_MENU_COMMANDS,
    SETTINGS_TITLE_TEMPLATE,
} from "../editorCommands";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const nls = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8"));

const PALETTE_WHEN = "activeCustomEditorId == 'markdownWysiwyg.editor'";

interface Contribution { command: string; title?: string; when?: string; group?: string }

const contributedCommands: Contribution[] = pkg.contributes.commands;
const commandPalette: Contribution[] = pkg.contributes.menus.commandPalette;
const webviewContext: Contribution[] = pkg.contributes.menus["webview/context"];

const editorCommandContribs = contributedCommands.filter((c) =>
    c.command.startsWith(EDITOR_COMMAND_PREFIX),
);

describe("editor command contributions", () => {
    it("every table entry should be contributed as a command with an nls title", () => {
        for (const meta of EDITOR_COMMANDS) {
            const name = editorCommandName(meta.id);
            const contrib = contributedCommands.find((c) => c.command === name);
            expect(contrib, `missing contributes.commands entry for ${name}`).toBeDefined();
            expect(contrib!.title).toBe(`%command.editor.${meta.id}.title%`);
            expect(nls[`command.editor.${meta.id}.title`], `missing nls title for ${meta.id}`).toBe(meta.title);
        }
    });

    it("every contributed editor command should map to a table entry", () => {
        const ids = new Set(EDITOR_COMMANDS.map((m) => editorCommandName(m.id)));
        for (const contrib of editorCommandContribs) {
            expect(ids.has(contrib.command), `contributed ${contrib.command} has no table entry`).toBe(true);
        }
    });

    it("command counts should match exactly (no drift in either direction)", () => {
        expect(editorCommandContribs).toHaveLength(EDITOR_COMMANDS.length);
    });

    it("command palette gating should follow each entry's palette flag", () => {
        for (const meta of EDITOR_COMMANDS) {
            const name = editorCommandName(meta.id);
            const entry = commandPalette.find((c) => c.command === name);
            expect(entry, `missing commandPalette entry for ${name}`).toBeDefined();
            expect(entry!.when).toBe(meta.palette ? PALETTE_WHEN : "false");
        }
    });

    it("each declared section should contribute a webview/context menu item", () => {
        for (const meta of EDITOR_COMMANDS) {
            const name = editorCommandName(meta.id);
            for (const section of meta.sections) {
                const entry = webviewContext.find(
                    (c) => c.command === name && c.when?.includes(`webviewSection == '${section}'`),
                );
                expect(entry, `missing webview/context entry for ${name} in section ${section}`).toBeDefined();
                expect(entry!.when).toContain("webviewId == 'markdownWysiwyg.editor'");
            }
        }
    });

    it("the settings entry title should match the shared template (gear menu renders the same rows)", () => {
        // The product name lives in the gear menu's group header, so the row
        // title is the bare template. Table, nls, and template must agree or
        // the two menus diverge on a rename.
        const expected = SETTINGS_TITLE_TEMPLATE.replace("{product}", pkg.displayName);
        const meta = EDITOR_COMMANDS.find((m) => m.id === "openExtensionSettings");
        expect(meta?.title).toBe(expected);
        expect(nls["command.editor.openExtensionSettings.title"]).toBe(expected);
    });

    it("the native toolbar context menu order should match the shared table order", () => {
        // The gear dropdown is built straight from TOOLBAR_MENU_COMMANDS; the
        // native right-click menu orders by the `1_toolbar@N` group suffix.
        // Sorting the contributed items by that suffix must reproduce the
        // table order, so the two menus list the same items in the same order.
        const contributed = webviewContext
            .filter((c) => c.when?.includes("webviewSection == 'toolbar'"))
            .sort((a, b) =>
                Number(a.group?.split("@")[1] ?? 0) - Number(b.group?.split("@")[1] ?? 0));
        expect(contributed.map((c) => c.command)).toEqual(
            TOOLBAR_MENU_COMMANDS.map((m) => editorCommandName(m.id)),
        );
    });

    it("every webview/context item should belong to a table entry that declares that section", () => {
        for (const entry of webviewContext) {
            const meta = EDITOR_COMMANDS.find((m) => editorCommandName(m.id) === entry.command);
            expect(meta, `context item ${entry.command} has no table entry`).toBeDefined();
            const section = meta!.sections.find((s) => entry.when?.includes(`webviewSection == '${s}'`));
            expect(section, `context item ${entry.command} declares an undeclared section`).toBeDefined();
        }
    });
});

describe("editor command keybinding contributions", () => {
    interface Keybinding {
        command: string;
        key?: string;
        mac?: string;
        win?: string;
        linux?: string;
        when?: string;
    }

    const keybindings: Keybinding[] = pkg.contributes.keybindings;
    const editorKeybindings = keybindings.filter((k) =>
        k.command.startsWith(EDITOR_COMMAND_PREFIX),
    );

    /**
     * The default keybindings shipped for editor commands. These exist so
     * users can REBIND them (Keyboard Shortcuts UI) — the webview must never
     * hardcode these chords itself (see keyboardShortcuts.test.ts, which
     * asserts they propagate to the workbench).
     */
    const EXPECTED_DEFAULTS: Record<string, Partial<Keybinding>[]> = {
        openFind: [{ key: "ctrl+f", mac: "cmd+f" }],
        openFindReplace: [
            { key: "ctrl+alt+f", mac: "cmd+alt+f" },
            { win: "ctrl+h", linux: "ctrl+h" },
        ],
        insertLink: [{ key: "ctrl+k", mac: "cmd+k" }],
        findNext: [{ key: "f3" }, { mac: "cmd+g" }],
        findPrevious: [{ key: "shift+f3" }, { mac: "cmd+shift+g" }],
        findSelection: [{ key: "ctrl+d", mac: "cmd+d" }],
        deleteBlock: [{ key: "ctrl+shift+k", mac: "cmd+shift+k" }],
        // VS Code parity: Join Lines ships bound on macOS only (palette
        // elsewhere).
        joinLines: [{ mac: "ctrl+j" }],
    };

    it("every editor keybinding should reference a table entry", () => {
        const ids = new Set(EDITOR_COMMANDS.map((m) => editorCommandName(m.id)));
        for (const kb of editorKeybindings) {
            expect(ids.has(kb.command), `keybinding for unknown command ${kb.command}`).toBe(true);
        }
    });

    it("every editor keybinding should be scoped to the active custom editor", () => {
        for (const kb of editorKeybindings) {
            expect(kb.when, `keybinding for ${kb.command} must be scoped`).toBe(PALETTE_WHEN);
        }
    });

    it("the expected default keybindings should all be contributed", () => {
        for (const [id, expected] of Object.entries(EXPECTED_DEFAULTS)) {
            const name = EDITOR_COMMAND_PREFIX + id;
            const entries = editorKeybindings.filter((k) => k.command === name);
            expect(entries, `keybindings for ${name}`).toHaveLength(expected.length);
            for (const exp of expected) {
                const match = entries.find(
                    (k) =>
                        k.key === exp.key &&
                        k.mac === exp.mac &&
                        k.win === exp.win &&
                        k.linux === exp.linux,
                );
                expect(match, `missing ${JSON.stringify(exp)} for ${name}`).toBeDefined();
            }
        }
    });

    it("no editor keybinding should exist outside the expected set (update EXPECTED_DEFAULTS)", () => {
        const expectedCount = Object.values(EXPECTED_DEFAULTS).reduce((n, e) => n + e.length, 0);
        expect(editorKeybindings).toHaveLength(expectedCount);
    });
});
