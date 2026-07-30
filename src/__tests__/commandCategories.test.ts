/**
 * Command-category guardrail (MAR-70).
 *
 * Every command this extension contributes must carry a `category` so it renders
 * in the command palette as "Birta Writer: <title>" — consistent with
 * the editor-action commands, and distinct from VS Code's own same-named entries
 * (e.g. "Preferences: Color Theme"). A category-less command shows bare and reads
 * as if it belongs to the workbench, not this editor. This test fails the build if
 * a new `birta.*` command is added without one.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

    it("every birta.* command should carry a non-empty category", () => {
        const uncategorized = commands
            .filter((c) => c.command?.startsWith("birta."))
            .filter((c) => !c.category || c.category.trim() === "")
            .map((c) => c.command)
            .sort();
        expect(uncategorized).toEqual([]);
    });

    it("every category should be the single canonical editor label", () => {
        const labels = new Set(
            commands
                .filter((c) => c.command?.startsWith("birta."))
                .map((c) => c.category),
        );
        expect([...labels]).toEqual(["Birta Writer"]);
    });
});

/**
 * A contributed command that nothing registers is worse than a missing one: it
 * appears in the palette, the user picks it, and VS Code answers "command
 * 'birta.x' not found". The category guard above cannot see that — a typo in
 * either half (`birta.toggleLineNumbers` contributed, `birta.toggleLineNumber`
 * registered) leaves both files individually plausible.
 *
 * The sweep is deliberately LOOSE: it accepts the command id appearing as a
 * string literal anywhere in non-test source, because registration reaches the
 * API by several routes — a literal at the call site, a helper's first argument
 * (`registerGateToggle`), a module-level constant (`SEND_FEEDBACK_COMMAND`), or
 * a name derived from a shared table (`editorCommandName` over
 * `EDITOR_COMMANDS`). Tightening it to "argument of registerCommand" would
 * demand a real parser and would fail on the last two. Loose is the right trade
 * here: it cannot catch a command that is *mentioned* but never registered, and
 * it absolutely catches the one that is nowhere at all.
 */
function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules" || name.startsWith(".")) { continue; }
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { out.push(...sourceFiles(path)); continue; }
        if (name.endsWith(".ts")) { out.push(path); }
    }
    return out;
}

describe("contributed commands are implemented", () => {
    /** Every `birta.*` id the source names, plus the ids derived from the shared table. */
    function implementedIds(): Set<string> {
        const ids = new Set<string>();
        for (const file of [...sourceFiles(join(repoRoot, "src")), ...sourceFiles(join(repoRoot, "shared"))]) {
            const src = readFileSync(file, "utf8");
            for (const m of src.matchAll(/["'](birta\.[A-Za-z0-9_.]+)["']/g)) { ids.add(m[1]); }
        }
        // The editor-action family is registered by looping the shared table, so
        // its ids exist only as `editorCommandName(meta.id)` at runtime.
        const table = readFileSync(join(repoRoot, "shared", "editorCommands.ts"), "utf8");
        for (const m of table.matchAll(/id:\s*["']([A-Za-z0-9_]+)["']/g)) { ids.add(`birta.editor.${m[1]}`); }
        return ids;
    }

    it("the sweep should reach real source, not an empty file list", () => {
        // Without this, a moved directory would make the guard below pass by
        // finding nothing to contradict it.
        expect(sourceFiles(join(repoRoot, "src")).length).toBeGreaterThan(10);
        expect(implementedIds().size).toBeGreaterThan(50);
    });

    it("every contributed birta.* command should exist in the source", () => {
        const implemented = implementedIds();
        const orphans = contributedCommands()
            .map((c) => c.command)
            .filter((id) => id?.startsWith("birta.") && !implemented.has(id))
            .sort();
        expect(
            orphans,
            `Contributed but never registered: ${orphans.join(", ")}. A palette entry ` +
                "that answers \"command not found\" is a broken feature, not a missing one — " +
                "either register it or drop the contribution.",
        ).toEqual([]);
    });
});
