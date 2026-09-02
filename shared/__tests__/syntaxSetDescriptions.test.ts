/**
 * What the two settings UIs SAY each target provides, against what it actually
 * provides.
 *
 * `syntaxSetsPort.test.ts` holds the two vocabularies equal: same sets, same
 * features, same memberships, same command arms. It says nothing about the
 * sentences beside them, and those are what a reader actually decides on. The
 * VS Code description of the Birta Writer set named PlantUML diagrams, which
 * that set does not provide and which is not in the vocabulary at all; the
 * Swift caption for the same set said SVG, correctly; both shipped, and every
 * check passed.
 *
 * So this reads the user-facing strings out of `package.nls.json` and
 * `SyntaxSets.swift` and asks one question of each: does it name a syntax its
 * own target does not spell. Only that direction. A description is free to
 * describe less than its target provides (Obsidian's says "over the GitHub
 * base" rather than relisting seven features), and pinning the full list would
 * be pinning the prose rather than the claim.
 *
 * The vocabulary below is the words a person writes, not the feature ids, and
 * the phrases are matched longest-first and consumed, so "Notion callouts"
 * reads as `notionCallout` rather than as `calloutAlert` sitting next to a
 * word. `FOREIGN` is the other half: renderers this editor really has and no
 * target governs, which is the exact shape the PlantUML claim had.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_SYNTAX_SETS, SYNTAX_SET_FEATURES, type SyntaxFeature, type SyntaxSet } from "../syntaxSets";

const root = resolve(__dirname, "../..");
const nls = JSON.parse(readFileSync(resolve(root, "package.nls.json"), "utf8")) as Record<string, string>;
const swift = readFileSync(resolve(root, "mac/Sources/BirtaWriterCore/SyntaxSets.swift"), "utf8");

/** How a person spells each feature, longest phrase first. */
const PHRASES: readonly (readonly [string, SyntaxFeature])[] = [
    ["notion callout", "notionCallout"],
    ["fenced div", "fencedDiv"],
    ["task list", "taskList"],
    ["calculation", "calc"],
    ["strikethrough", "strikethrough"],
    ["wikilink", "wikiLink"],
    ["highlight", "highlight"],
    ["footnote", "footnote"],
    ["callout", "calloutAlert"],
    ["mermaid", "mermaid"],
    ["table", "table"],
    ["alert", "calloutAlert"],
    ["math", "math"],
    ["svg", "svg"],
    ["calc", "calc"],
];

/**
 * Renderers this editor has that NO target governs, so naming one in a
 * target's description is a claim no set can make. PlantUML and Graphviz draw
 * inside a fence and have no insert tool, which is why they are absent from
 * `SyntaxFeature` rather than members of the Birta Writer set.
 */
const FOREIGN = ["plantuml", "graphviz"];

/** Every feature a description names, by consuming the longest phrase first. */
function featuresNamed(description: string): Set<SyntaxFeature> {
    let text = description.toLowerCase();
    const found = new Set<SyntaxFeature>();
    for (const [phrase, feature] of PHRASES) {
        if (!text.includes(phrase)) { continue; }
        found.add(feature);
        text = text.split(phrase).join(" ");
    }
    return found;
}

/** The VS Code enum description for a set. */
function vscodeDescription(set: SyntaxSet): string {
    const value = nls[`config.syntax.sets.${set}`];
    expect(value, `no nls string for ${set}`).toBeDefined();
    return value!;
}

/** The Swift Settings caption for a set, out of the `caption` switch. */
function swiftCaption(set: SyntaxSet): string {
    const body = /public var caption: String \{([\s\S]*?)\n {4}\}/.exec(swift);
    expect(body, "no caption switch in SyntaxSets.swift").not.toBeNull();
    const arm = new RegExp(`case \\.${set}:([\\s\\S]*?)(?=\\n {8}case \\.|\\n {8}\\})`)
        .exec(body![1]!);
    expect(arm, `no caption arm for ${set}`).not.toBeNull();
    return arm![1]!;
}

const SURFACES: readonly (readonly [string, (set: SyntaxSet) => string])[] = [
    ["VS Code", vscodeDescription],
    ["Mac Settings", swiftCaption],
];

describe("the syntax-target descriptions", () => {
    it("the phrase table should recognise something in every description", () => {
        // Every verdict below is "the features it names are provided", which a
        // description naming NOTHING satisfies. So each string is asserted to
        // be readable by this vocabulary before its verdict is taken.
        for (const [surface, read] of SURFACES) {
            for (const set of ALL_SYNTAX_SETS) {
                expect(
                    featuresNamed(read(set)).size,
                    `${surface} / ${set} names no syntax this test can read`,
                ).toBeGreaterThan(0);
            }
        }
    });

    it("no description should name a syntax its own target does not provide", () => {
        for (const [surface, read] of SURFACES) {
            for (const set of ALL_SYNTAX_SETS) {
                const provided = new Set<SyntaxFeature>(SYNTAX_SET_FEATURES[set]);
                const overclaimed = [...featuresNamed(read(set))].filter((f) => !provided.has(f));
                expect(
                    overclaimed,
                    `${surface} description of ${set} claims ${overclaimed.join(", ")}`,
                ).toEqual([]);
            }
        }
    });

    it("no description should name a renderer no target governs", () => {
        for (const [surface, read] of SURFACES) {
            for (const set of ALL_SYNTAX_SETS) {
                const text = read(set).toLowerCase();
                const named = FOREIGN.filter((name) => text.includes(name));
                expect(
                    named,
                    `${surface} description of ${set} names ${named.join(", ")}, which no target provides`,
                ).toEqual([]);
            }
        }
    });

    it("the two surfaces should name the same syntaxes for the same set", () => {
        // The drift the port guard does not cover. The wordings differ on
        // purpose (one is a settings row's subtitle, the other an enum
        // description), so what is compared is the set of syntaxes each names,
        // not the sentences.
        for (const set of ALL_SYNTAX_SETS) {
            expect(
                [...featuresNamed(swiftCaption(set))].sort(),
                `the two descriptions of ${set} disagree`,
            ).toEqual([...featuresNamed(vscodeDescription(set))].sort());
        }
    });
});
