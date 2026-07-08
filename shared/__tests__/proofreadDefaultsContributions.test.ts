/**
 * Drift guard: the proofread (style/spell check) defaults are declared in
 * TWO places — the `markdownWysiwyg.styleCheck.*` / `spellCheck.*` setting
 * defaults in package.json (what the Settings UI shows) and the inline
 * fallbacks in `MarkdownEditorProvider.getProofreadConfig` (what the editor
 * uses when a read fails). They must agree, or the Settings UI lies.
 *
 * The central vscode mock's `cfg.get(key, fallback)` returns the fallback,
 * so calling getProofreadConfig() under the mock yields exactly the code
 * fallbacks — compared here against the contributed defaults.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { MarkdownEditorProvider } from "../../src/MarkdownEditorProvider";
import type { ProofreadConfig } from "../messages";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props: Record<string, { default?: unknown }> =
    pkg.contributes.configuration.properties;

/** ProofreadConfig field → contributed setting key (sans prefix). */
const FIELD_TO_SETTING: Record<keyof ProofreadConfig, string> = {
    styleCheck: "styleCheck.enabled",
    fillers: "styleCheck.fillers",
    redundancies: "styleCheck.redundancies",
    cliches: "styleCheck.cliches",
    wordiness: "styleCheck.wordiness",
    aiVocabulary: "styleCheck.aiVocabulary",
    aiArtifacts: "styleCheck.aiArtifacts",
    passive: "styleCheck.passive",
    negativeParallelism: "styleCheck.negativeParallelism",
    longSentences: "styleCheck.longSentences",
    ruleOfThree: "styleCheck.ruleOfThree",
    emDash: "styleCheck.emDash",
    nonAsciiPunct: "styleCheck.nonAsciiPunct",
    styleExceptions: "styleCheck.exceptions",
    spellCheck: "spellCheck.enabled",
    grammarCheck: "spellCheck.grammar",
    userWords: "spellCheck.userWords",
};

describe("proofread defaults", () => {
    it("code fallbacks should match the contributed setting defaults", () => {
        const fallbacks = MarkdownEditorProvider.getProofreadConfig();
        for (const [field, setting] of Object.entries(FIELD_TO_SETTING)) {
            const prop = props[`markdownWysiwyg.${setting}`];
            expect(prop, `missing setting markdownWysiwyg.${setting}`).toBeDefined();
            expect(
                fallbacks[field as keyof ProofreadConfig],
                `fallback for ${field} drifted from markdownWysiwyg.${setting}`,
            ).toEqual(prop!.default);
        }
    });

    // `passive` and `negativeParallelism` ship OFF because they over-flag
    // ordinary correct English (copular/locative "was born"/"is located" and the
    // correlative "not only X but also Y"); every other style check ships ON.
    const OFF_BY_DEFAULT = new Set([
        "markdownWysiwyg.styleCheck.passive",
        "markdownWysiwyg.styleCheck.negativeParallelism",
    ]);

    it("style checks should default ON except the known over-flagging ones", () => {
        for (const [key, prop] of Object.entries(props)) {
            if (key.startsWith("markdownWysiwyg.styleCheck.") && typeof prop.default === "boolean") {
                const expected = !OFF_BY_DEFAULT.has(key);
                expect(prop.default, `${key} should default ${expected}`).toBe(expected);
            }
        }
    });
});
