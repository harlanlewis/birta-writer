/**
 * Port guard for the syntax-target vocabulary.
 *
 * Swift cannot import TypeScript, so `mac/Sources/BirtaWriterCore/SyntaxSets.swift`
 * restates `shared/syntaxSets.ts` and the `syntax` field on `EDITOR_COMMANDS`.
 * The same family as `ProofreadFilter`, `AgentRequest` and `StyleCategories`,
 * and the same failure mode: two copies that agree today and drift the day one
 * of them gains a target, with nothing to say so.
 *
 * The drift here is quiet in a particular way. The Format menu builds and every
 * row works; it simply goes on offering a tool every other surface in the same
 * window has withdrawn, and binds a key for it that the page then refuses. So
 * this compares the tables rather than trusting either.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    ALL_SYNTAX_FEATURES,
    ALL_SYNTAX_SETS,
    SYNTAX_SET_FEATURES,
    type SyntaxFeature,
    type SyntaxSet,
} from "../syntaxSets";
import { EDITOR_COMMANDS } from "../editorCommands";

const SWIFT_PATH = "mac/Sources/BirtaWriterCore/SyntaxSets.swift";
const swift = readFileSync(resolve(__dirname, "../..", SWIFT_PATH), "utf8");

/** The `case x` members of a Swift enum, in declaration order. */
function enumCases(name: string): string[] {
    const body = new RegExp(`public enum ${name}:[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(swift);
    if (!body) { return []; }
    return [...body[1]!.matchAll(/^\s{4}case (\w+)$/gm)].map((m) => m[1]!);
}

/** `case .set: return [.a, .b]` arms of `features(of:)`, values in order. */
function featureArms(): Map<string, string[]> {
    const fn = /public static func features\(of set: SyntaxSet\) -> \[SyntaxFeature\] \{([\s\S]*?)\n {4}\}/
        .exec(swift);
    const arms = new Map<string, string[]>();
    if (!fn) { return arms; }
    for (const m of fn[1]!.matchAll(/case \.(\w+): return \[([\s\S]*?)\]/g)) {
        arms.set(m[1]!, [...m[2]!.matchAll(/\.(\w+)/g)].map((f) => f[1]!));
    }
    return arms;
}

/** `case "id": return .feature` arms of `feature(forCommand:)`. */
function commandArms(): Map<string, string> {
    const fn = /public static func feature\(forCommand id: String\) -> SyntaxFeature\? \{([\s\S]*?)\n {4}\}/
        .exec(swift);
    const arms = new Map<string, string>();
    if (!fn) { return arms; }
    for (const m of fn[1]!.matchAll(/case "(\w+)": return \.(\w+)/g)) {
        arms.set(m[1]!, m[2]!);
    }
    return arms;
}

/** What the TypeScript side says a command writes. */
const tsCommandSyntax = new Map<string, SyntaxFeature>(
    EDITOR_COMMANDS.flatMap((meta) =>
        "syntax" in meta && meta.syntax
            ? [[meta.id, meta.syntax as SyntaxFeature] as const]
            : []),
);

describe("the Swift port of the syntax-target vocabulary", () => {
    it("the file should parse into non-empty tables, or every check below is vacuous", () => {
        expect(swift.length).toBeGreaterThan(0);
        expect(enumCases("SyntaxSet").length).toBeGreaterThan(0);
        expect(enumCases("SyntaxFeature").length).toBeGreaterThan(0);
        expect(featureArms().size).toBeGreaterThan(0);
        expect(commandArms().size).toBeGreaterThan(0);
    });

    it("the sets should match, in the same order", () => {
        expect(enumCases("SyntaxSet")).toEqual([...ALL_SYNTAX_SETS]);
    });

    it("the features should match, in the same order", () => {
        expect(enumCases("SyntaxFeature")).toEqual([...ALL_SYNTAX_FEATURES]);
    });

    it("each set should provide the same features, in the same order", () => {
        const arms = featureArms();
        expect([...arms.keys()].sort()).toEqual([...ALL_SYNTAX_SETS].sort());
        for (const set of ALL_SYNTAX_SETS) {
            expect(arms.get(set), `${set} membership`)
                .toEqual([...SYNTAX_SET_FEATURES[set as SyntaxSet]]);
        }
    });

    it("the same commands should write the same syntax", () => {
        const arms = commandArms();
        expect([...arms.keys()].sort()).toEqual([...tsCommandSyntax.keys()].sort());
        for (const [id, feature] of tsCommandSyntax) {
            expect(arms.get(id), `${id}`).toBe(feature);
        }
    });
});
