/**
 * The syntax-target vocabulary, and the two ways it can rot silently.
 *
 * A set that provides no feature and a feature no set provides are both dead
 * declarations that every other test passes over, because nothing in the type
 * system says a union member has to appear in a table. The same hazard
 * `hostProfile.test.ts` names for a capability that gates no command: a gate
 * that withdraws nothing names nothing.
 *
 * The third and least visible one is a feature no SURFACE declares. That is a
 * feature the vocabulary can express and no tool is gated on, so narrowing a
 * target that provides it changes nothing on screen while looking like it
 * should. It is checked by reading the files that declare a gate, because
 * there is no registry to walk: the declarations are spread across the command
 * table, the slash registry, the two toolbar registries, the block menu's
 * conversion table and the link popup, which is what "declare what it NEEDS
 * and filter once" produces when the things being gated are not one kind of
 * thing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    ALL_SYNTAX_FEATURES,
    ALL_SYNTAX_SETS,
    DEFAULT_SYNTAX_SETS,
    SYNTAX_SET_FEATURES,
    enabledSyntaxSets,
    normalizeSyntaxSets,
    setsProviding,
    syntaxAllows,
    type SyntaxFeature,
    type SyntaxSet,
} from "../syntaxSets";

const root = resolve(__dirname, "../..");

/**
 * Every file that may gate something on a syntax feature.
 *
 * A list rather than a sweep of the tree, so the guard says WHERE a gate is
 * expected to live and a new gating surface has to join it deliberately. The
 * cost of getting that wrong is the failure this file is about, so the list is
 * asserted non-trivial below rather than trusted.
 */
const DECLARING_FILES = [
    "shared/editorCommands.ts",
    "webview/components/slashMenu/registry.ts",
    "webview/components/toolbar/containerPickers.ts",
    "webview/components/selectionToolbar/registry.ts",
    "webview/components/blockMenu/menu.ts",
    "webview/components/linkPopup/formatSwitch.ts",
];

/**
 * The Record literals whose VALUES are gates, by the name they are declared
 * under. Both map some other vocabulary onto a feature, so neither writes the
 * word `syntax` beside the value the way every other gate does.
 */
const SYNTAX_TABLES = ["KIND_SYNTAX", "ITEM_SYNTAX"];

/** The body of `const <name> ... = { ... };`, or "" where the file has none. */
function tableBody(text: string, name: string): string {
    const start = text.indexOf(`const ${name}`);
    if (start === -1) { return ""; }
    const open = text.indexOf("{", start);
    const close = text.indexOf("\n};", open);
    return open === -1 || close === -1 ? "" : text.slice(open, close);
}

/**
 * Whether `text` gates something on `feature`, by the SHAPE of the declaration
 * rather than by the feature's name appearing anywhere in the file.
 *
 * Three shapes, and only three:
 *
 *   syntax: "table"            a field on a command, a slash row or a menu row
 *   syntaxAllows("wikiLink")   a surface asking directly
 *   taskList: "taskList"       a value inside one of SYNTAX_TABLES, which map
 *                              another vocabulary (a conversion kind, a
 *                              palette item) onto a feature
 *
 * A substring test was the first version of this and it did not work. Feature
 * names are also fence languages, keywords, block-menu section names and
 * WebviewSection names, so `args: "svg"` and `section: "table"` both read as
 * gates: deleting the real gate beside them left this check green, which is
 * the exact failure it was written to catch. Restricting the value form to the
 * two named tables is what keeps a field called `section` out of it.
 */
function declaresGate(text: string, feature: SyntaxFeature): boolean {
    const direct = new RegExp(
        `(?:\\bsyntax\\s*:\\s*|\\bsyntaxAllows\\(\\s*)"${feature}"`,
    );
    if (direct.test(text)) { return true; }
    const value = new RegExp(`:\\s*"${feature}"`);
    return SYNTAX_TABLES.some((name) => value.test(tableBody(text, name)));
}

const declarations = DECLARING_FILES.map((path) => ({
    path,
    text: readFileSync(resolve(root, path), "utf8"),
}));

/** Run `body` with `sets` declared, restoring whatever was there before. */
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

describe("the syntax-target vocabulary", () => {
    it("every set should provide at least one feature", () => {
        for (const set of ALL_SYNTAX_SETS) {
            expect(SYNTAX_SET_FEATURES[set].length, `${set} provides nothing`).toBeGreaterThan(0);
        }
    });

    it("every feature should be provided by at least one set", () => {
        for (const feature of ALL_SYNTAX_FEATURES) {
            expect(setsProviding(feature), `no set provides ${feature}`).not.toHaveLength(0);
        }
    });

    it("every feature should be WITHDRAWABLE by some choice of sets", () => {
        // A feature every set provides can never be off while any target is on,
        // which makes it a floor member wearing a feature's clothes: it belongs
        // in CommonMark rather than in this union.
        for (const feature of ALL_SYNTAX_FEATURES) {
            expect(
                setsProviding(feature).length,
                `${feature} is provided by every set, so nothing can withdraw it`,
            ).toBeLessThan(ALL_SYNTAX_SETS.length);
        }
    });

    it("every feature should gate at least one surface", () => {
        // The list itself has to be real, or the sweep below finds nothing and
        // reports every feature as gated by reaching zero files.
        expect(declarations).toHaveLength(DECLARING_FILES.length);
        for (const { text } of declarations) {
            expect(text.length).toBeGreaterThan(0);
        }
        const ungated = ALL_SYNTAX_FEATURES.filter(
            (feature) => !declarations.some(({ text }) => declaresGate(text, feature)),
        );
        expect(
            ungated,
            `these features are in the vocabulary and gate nothing: ${ungated.join(", ")}`,
        ).toEqual([]);
    });

    it("the sweep should not read a feature's name in a non-gate position as a gate", () => {
        // The discriminating half, and the reason `declaresGate` is a shape
        // rather than a substring. A bare `text.includes('"svg"')` passed on
        // `args: "svg"` and on `section: "table"`, so deleting the gate beside
        // them left this check green: the guard had stopped being about its
        // subject and no run said so.
        //
        // Each fixture is a real line from a declaring file with the gate
        // taken out of it, so what is asserted is what a deleted gate leaves.
        const notGates = [
            '{ id: "svgBlock", commandId: "insertCodeBlock", args: "svg" },',
            '{ id: "mermaid", keywords: ["mermaid", "diagram"], args: "mermaid" },',
            '{ id: "insertTable", title: "Insert Table", sections: ["table"] },',
            '                section: "table",',
            'keywords: ["math", "latex", "katex"],',
        ];
        for (const line of notGates) {
            for (const feature of ALL_SYNTAX_FEATURES) {
                expect(declaresGate(line, feature), `${feature} in: ${line}`).toBe(false);
            }
        }
        // And the gate shapes themselves are recognised, or the assertions
        // above would hold for a predicate that is simply always false.
        expect(declaresGate('sections: [], syntax: "table" },', "table")).toBe(true);
        expect(declaresGate('const offer = allowed && syntaxAllows("wikiLink");', "wikiLink")).toBe(true);
        expect(declaresGate('const KIND_SYNTAX = {\n    taskList: "taskList",\n};\n', "taskList")).toBe(true);
    });

    it("each named syntax table should be found and be non-empty", () => {
        // `tableBody` returns "" for a table it cannot find, and a gate read
        // out of "" is a gate that silently stopped counting. Renaming either
        // table has to fail here rather than quietly narrow the sweep above.
        for (const name of SYNTAX_TABLES) {
            const found = declarations.filter(({ text }) => tableBody(text, name).length > 0);
            expect(found, `no declaring file holds ${name}`).toHaveLength(1);
        }
    });

    it("no set's feature list should repeat a feature", () => {
        for (const set of ALL_SYNTAX_SETS) {
            const list = SYNTAX_SET_FEATURES[set];
            expect(new Set(list).size, `${set} lists a feature twice`).toBe(list.length);
        }
    });

    it("every listed feature should be in the feature union", () => {
        for (const set of ALL_SYNTAX_SETS) {
            for (const feature of SYNTAX_SET_FEATURES[set]) {
                expect(ALL_SYNTAX_FEATURES, `${set} names ${feature}`).toContain(feature);
            }
        }
    });

    it("the shipped default should be every set, so nothing is withdrawn until asked", () => {
        expect([...DEFAULT_SYNTAX_SETS]).toEqual([...ALL_SYNTAX_SETS]);
    });
});

describe("normalizeSyntaxSets", () => {
    it("a list of known sets should survive, in vocabulary order", () => {
        expect(normalizeSyntaxSets(["pandoc", "gfm"])).toEqual(["gfm", "pandoc"]);
    });

    it("an unknown entry should be dropped without taking the known ones with it", () => {
        expect(normalizeSyntaxSets(["gfm", "markdownExtra", 7, null])).toEqual(["gfm"]);
    });

    it("a duplicate should collapse", () => {
        expect(normalizeSyntaxSets(["gfm", "gfm"])).toEqual(["gfm"]);
    });

    it("an empty list should stay empty, because that is the CommonMark target", () => {
        expect(normalizeSyntaxSets([])).toEqual([]);
    });

    it("a non-array should fall back to the default rather than to nothing", () => {
        // The distinction that matters: an empty ARRAY is a choice, and a value
        // that is not a list at all cannot mean anything, so reading it as
        // "CommonMark only" would silently strip a reader's whole toolbar on a
        // settings.json typo.
        for (const value of [undefined, null, "gfm", { gfm: true }, 3]) {
            expect(normalizeSyntaxSets(value)).toEqual([...DEFAULT_SYNTAX_SETS]);
        }
    });
});

describe("syntaxAllows", () => {
    it("an absent declaration should offer everything", () => {
        withSets(undefined, () => {
            expect(enabledSyntaxSets()).toEqual([...ALL_SYNTAX_SETS]);
            for (const feature of ALL_SYNTAX_FEATURES) {
                expect(syntaxAllows(feature), feature).toBe(true);
            }
        });
    });

    it("an empty declaration should offer nothing beyond CommonMark", () => {
        withSets([], () => {
            expect(syntaxAllows(undefined)).toBe(true);
            for (const feature of ALL_SYNTAX_FEATURES) {
                expect(syntaxAllows(feature), feature).toBe(false);
            }
        });
    });

    it("one set should offer exactly what it provides", () => {
        for (const set of ALL_SYNTAX_SETS) {
            withSets([set], () => {
                for (const feature of ALL_SYNTAX_FEATURES) {
                    expect(syntaxAllows(feature), `${set} / ${feature}`).toBe(
                        SYNTAX_SET_FEATURES[set].includes(feature),
                    );
                }
            });
        }
    });

    it("two sets should offer the union, never the intersection", () => {
        // The pair is chosen because it discriminates: highlight is Obsidian's
        // alone and fenced divs are Pandoc's alone, so an intersection would
        // withdraw both and an "any set provides it" answer keeps both.
        withSets(["obsidian", "pandoc"], () => {
            expect(syntaxAllows("highlight")).toBe(true);
            expect(syntaxAllows("fencedDiv")).toBe(true);
            // And something neither provides is still gone, so the union is not
            // simply reading as "any set at all is on".
            expect(syntaxAllows("calc")).toBe(false);
        });
    });

    it("a feature named by no enabled set should be off even with sets enabled", () => {
        withSets(["gfm"], () => {
            expect(syntaxAllows("wikiLink" satisfies SyntaxFeature)).toBe(false);
        });
    });
});
