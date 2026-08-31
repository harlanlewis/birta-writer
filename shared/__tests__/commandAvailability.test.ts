/**
 * `commandAvailable` is the ONE predicate a surface asks before offering or
 * running a command, and the failure this file exists for is a surface that
 * asks a narrower one.
 *
 * `hostHasCommand` answers two of the three reasons a command can be absent.
 * A surface calling it directly still hides a command the host cannot honour,
 * so nothing goes visibly wrong: what goes wrong is that the same surface goes
 * on offering a tool the reader's syntax target does not spell, while the
 * chord bound to it has stopped working. That is the divergence between a
 * button and its key that `hostHasCommand` was itself built to stop, and no
 * green run reports it, so the call sites are checked rather than trusted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "node:fs";
import { commandAvailable, commandSyntax } from "../commandAvailability";
import { EDITOR_COMMANDS } from "../editorCommands";
import { ALL_SYNTAX_FEATURES, type SyntaxSet } from "../syntaxSets";

const root = resolve(__dirname, "../..");

/**
 * The one module allowed to ask the host-only question, because it is what
 * turns it into the whole one.
 */
const HOST_PREDICATE_OWNERS = new Set([
    "shared/commandAvailability.ts",
    "shared/hostProfile.ts",
]);

function withSets(sets: readonly SyntaxSet[] | undefined, body: () => void): void {
    const globals = globalThis as { __i18n?: { syntaxSets?: readonly SyntaxSet[] } };
    const before = globals.__i18n;
    globals.__i18n = { syntaxSets: sets };
    try {
        body();
    } finally {
        globals.__i18n = before;
    }
}

describe("commandAvailable is the one predicate", () => {
    it("no surface should call hostHasCommand directly", () => {
        const files = globSync(["webview/**/*.ts", "src/**/*.ts", "shared/**/*.ts"], {
            cwd: root,
            exclude: (name) => name === "__tests__" || name === "node_modules",
        }).map(String);
        // A sweep that reached nothing passes, so the corpus is asserted before
        // its verdict is.
        expect(files.length).toBeGreaterThan(100);

        const offenders = files.filter((file) => {
            const path = file.split("\\").join("/");
            if (HOST_PREDICATE_OWNERS.has(path)) { return false; }
            const text = readFileSync(resolve(root, file), "utf8");
            // The import is what makes it reachable; a mention inside a comment
            // is prose about the predicate rather than a use of it.
            return /^\s*import\s[^;]*\bhostHasCommand\b/m.test(text);
        });
        expect(
            offenders,
            `these reach past commandAvailable: ${offenders.join(", ")}`,
        ).toEqual([]);
    });
});

describe("the syntax a command writes", () => {
    it("every declared syntax should be in the feature vocabulary", () => {
        const declared = EDITOR_COMMANDS.flatMap((meta) =>
            "syntax" in meta && meta.syntax ? [meta.syntax] : []);
        // A vacuous pass here would mean no command declares a syntax at all,
        // which is the state where this whole feature gates nothing.
        expect(declared.length).toBeGreaterThan(0);
        for (const feature of declared) {
            expect(ALL_SYNTAX_FEATURES).toContain(feature);
        }
    });

    it("a command that edits a construct already in the document should carry no syntax", () => {
        // The rule the `syntax` field's doc states, checked on the pairs that
        // make it real. Each of these acts on something the document already
        // holds, and the document holds it whatever the target says, so
        // withdrawing them would leave a reader looking at a construct they can
        // see and cannot edit.
        for (const id of [
            "tableInsertRowAbove",
            "tableInsertColumnLeft",
            "tableAlignColumnCenter",
            "tableDeleteRow",
            "toggleTaskChecked",
            "uncheckAllTasks",
        ]) {
            expect(commandSyntax(id), `${id} should not be syntax-gated`).toBeUndefined();
        }
        // And the discriminating half: the commands that INTRODUCE the same
        // constructs do carry one, so the assertions above are a distinction
        // rather than a table that is simply empty.
        expect(commandSyntax("insertTable")).toBe("table");
        expect(commandSyntax("toggleTaskList")).toBe("taskList");
    });
});

describe("commandAvailable", () => {
    it("a CommonMark command should survive every target being off", () => {
        withSets([], () => {
            expect(commandAvailable("toggleBold")).toBe(true);
            expect(commandAvailable("insertCodeBlock")).toBe(true);
            expect(commandAvailable("toggleBlockquote")).toBe(true);
        });
    });

    it("a command whose syntax no enabled target spells should be withdrawn", () => {
        withSets([], () => {
            expect(commandAvailable("insertTable")).toBe(false);
            expect(commandAvailable("toggleStrikethrough")).toBe(false);
            expect(commandAvailable("insertFootnote")).toBe(false);
        });
    });

    it("enabling the target that spells it should bring it back", () => {
        withSets(["gfm"], () => {
            expect(commandAvailable("insertTable")).toBe(true);
            // Obsidian's alone, so GitHub does not bring it.
            expect(commandAvailable("toggleHighlight")).toBe(false);
        });
        withSets(["obsidian"], () => {
            expect(commandAvailable("toggleHighlight")).toBe(true);
        });
    });

    it("an unknown id should be available, the way the host predicate answers it", () => {
        withSets([], () => {
            expect(commandAvailable("notACommand")).toBe(true);
        });
    });
});
