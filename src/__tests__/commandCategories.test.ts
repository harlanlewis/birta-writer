/**
 * Command-category guardrail (MAR-70).
 *
 * Every command this extension contributes must carry a `category` so it renders
 * in the command palette as "WYSIWYG Markdown Editor: <title>" — consistent with
 * the editor-action commands, and distinct from VS Code's own same-named entries
 * (e.g. "Preferences: Color Theme"). A category-less command shows bare and reads
 * as if it belongs to the workbench, not this editor. This test fails the build if
 * a new `markdownWysiwyg.*` command is added without one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface CommandContribution {
    command: string;
    title?: string;
    category?: string;
}

function contributedCommands(): CommandContribution[] {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return pkg?.contributes?.commands ?? [];
}

describe("contributed command categories", () => {
    const commands = contributedCommands();

    it("package.json should contribute the editor commands", () => {
        // Sanity check that we're reading the right shape — an empty list would
        // make the guardrail below vacuously pass.
        expect(commands.length).toBeGreaterThan(0);
    });

    it("every markdownWysiwyg.* command should carry a non-empty category", () => {
        const uncategorized = commands
            .filter((c) => c.command?.startsWith("markdownWysiwyg."))
            .filter((c) => !c.category || c.category.trim() === "")
            .map((c) => c.command)
            .sort();
        expect(uncategorized).toEqual([]);
    });

    it("every category should be the single canonical editor label", () => {
        const labels = new Set(
            commands
                .filter((c) => c.command?.startsWith("markdownWysiwyg."))
                .map((c) => c.category),
        );
        expect([...labels]).toEqual(["WYSIWYG Markdown Editor"]);
    });
});
