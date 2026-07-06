/**
 * Drift guard (MAR-9): the editor commands contributed in package.json must
 * stay in lockstep with the shared command table (shared/editorCommands.ts),
 * which is itself the source of truth for the extension registration and the
 * webview registry (typed as Record<EditorCommandId, …>).
 *
 * Verifies, in both directions:
 *   - every contributed `markdownWriter.editor.*` command has a table entry;
 *   - every table entry is contributed, with an nls title, correct command
 *     palette gating, and a right-click menu item per declared section.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { EDITOR_COMMANDS, EDITOR_COMMAND_PREFIX, editorCommandName } from "../editorCommands";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const nls = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8"));

const PALETTE_WHEN = "activeCustomEditorId == 'markdownWriter.editor'";

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
                expect(entry!.when).toContain("webviewId == 'markdownWriter.editor'");
            }
        }
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
