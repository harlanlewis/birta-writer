/**
 * The syntax gate on the two surfaces the PAGE cannot reach.
 *
 * VS Code's command palette and our contributed keybindings are declared in
 * `package.json` and resolved by the workbench, so `commandAvailable` never
 * gets asked: the only way to withdraw a row there is a `when` clause over a
 * context key the extension publishes (`syntaxContextKey`, and
 * `publishSyntaxContext` in src/extension.ts).
 *
 * That makes it the one part of this feature written twice, in two languages
 * that cannot import each other, which is the shape every port guard here
 * exists for. The drift is quiet in the way that matters: nothing breaks, the
 * row simply goes on being offered and does nothing when picked, and no run
 * reports it. So the expected clause is DERIVED from `EDITOR_COMMANDS` rather
 * than listed, and a new gated command fails here until its contribution
 * carries the key.
 *
 * The reverse direction is checked too. A `when` clause naming a syntax key on
 * a command that writes CommonMark would withdraw a tool no target governs,
 * which is worse than the drift above because it is invisible until someone
 * narrows their target and loses a control that should never have gone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EDITOR_COMMANDS } from "../editorCommands";
import { ALL_SYNTAX_FEATURES, syntaxContextKey, type SyntaxFeature } from "../syntaxSets";

interface Contribution { command: string; when?: string }

const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
) as {
    contributes: {
        menus: { commandPalette: Contribution[] };
        keybindings: Contribution[];
    };
};

const palette = manifest.contributes.menus.commandPalette;
const keybindings = manifest.contributes.keybindings;

/** The syntax each command writes, where it writes one beyond CommonMark. */
const commandSyntax = new Map<string, SyntaxFeature>(
    EDITOR_COMMANDS.flatMap((meta) =>
        "syntax" in meta && meta.syntax
            ? [[meta.id, meta.syntax as SyntaxFeature] as const]
            : []),
);

/** The bare command id a contribution names, e.g. `birta.editor.insertTable`. */
function idOf(contribution: Contribution): string {
    return contribution.command.split(".").pop() ?? "";
}

/** Every syntax context key any contribution's `when` clause mentions. */
function keysIn(when: string | undefined): string[] {
    return ALL_SYNTAX_FEATURES
        .map(syntaxContextKey)
        .filter((key) => (when ?? "").includes(key));
}

describe("the syntax gate on VS Code's own surfaces", () => {
    it("the manifest should parse into non-empty contribution lists", () => {
        // Every verdict below is a filter over these two arrays, so an empty
        // one reports total agreement while having compared nothing.
        expect(palette.length).toBeGreaterThan(50);
        expect(keybindings.length).toBeGreaterThan(10);
        expect(commandSyntax.size).toBeGreaterThan(0);
    });

    it("every palette row for a gated command should carry its context key", () => {
        // A `when` of "false" is a command deliberately kept OUT of the palette
        // (toggleCallout is the toolbar's checkbox semantics, not an insert),
        // and there is nothing there to withdraw.
        const offered = palette.filter((row) => row.when !== "false" && commandSyntax.has(idOf(row)));
        // The rule is derived, so it has to have found rows to derive it over.
        expect(offered.length).toBeGreaterThan(0);
        const missing = offered
            .filter((row) => !keysIn(row.when).includes(syntaxContextKey(commandSyntax.get(idOf(row))!)))
            .map((row) => row.command);
        expect(
            missing,
            `these palette rows outlive the target that spells them: ${missing.join(", ")}`,
        ).toEqual([]);
    });

    it("every contributed keybinding for a gated command should carry its context key", () => {
        const bound = keybindings.filter((row) => commandSyntax.has(idOf(row)));
        expect(bound.length).toBeGreaterThan(0);
        const missing = bound
            .filter((row) => !keysIn(row.when).includes(syntaxContextKey(commandSyntax.get(idOf(row))!)))
            .map((row) => row.command);
        expect(
            missing,
            `these chords outlive the target that spells them: ${missing.join(", ")}`,
        ).toEqual([]);
    });

    it("no contribution for a CommonMark command should name a syntax key", () => {
        // The discriminating half. Without it both checks above would pass on a
        // manifest that had appended every key to every clause.
        const wrong = [...palette, ...keybindings]
            .filter((row) => !commandSyntax.has(idOf(row)) && keysIn(row.when).length > 0)
            .map((row) => `${row.command} (${keysIn(row.when).join(", ")})`);
        expect(
            wrong,
            `these withdraw a tool no target governs: ${wrong.join(", ")}`,
        ).toEqual([]);
    });

    it("a contribution should never name a key for a feature its command does not write", () => {
        // The other way the two can disagree while both looking gated: the
        // right shape with the wrong feature, which withdraws the row on
        // somebody else's target.
        const crossed = [...palette, ...keybindings]
            .filter((row) => {
                const feature = commandSyntax.get(idOf(row));
                if (feature === undefined) { return false; }
                return keysIn(row.when).some((key) => key !== syntaxContextKey(feature));
            })
            .map((row) => row.command);
        expect(crossed, `these name the wrong feature: ${crossed.join(", ")}`).toEqual([]);
    });
});
