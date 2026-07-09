import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/prose/model";
import { computeDecorations, DEFAULT_CONFIG } from "../plugins/proofread";
import type { ProofreadConfig } from "../../shared/messages";

/**
 * End-to-end check of the decoration pipeline against a real ProseMirror
 * document: block traversal, inline-code masking, image placeholders, and
 * the offset→position mapping (blockPos + 1 + offset).
 * Spell check stays off here (the dictionary is lazy-loaded at runtime).
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        code_block: { group: "block", content: "text*", marks: "" },
        text: { group: "inline" },
        image: { group: "inline", inline: true },
    },
    marks: {
        inlineCode: {},
        strong: {},
    },
});

const CONFIG: ProofreadConfig = {
    styleCheck: true,
    fillers: true,
    redundancies: true,
    cliches: true,
    // New categories default off in these decoration tests so existing
    // assertions (which only expect filler/redundancy/cliche/repeated hits)
    // stay exact; individual tests opt one in via { ...CONFIG, passive: true }.
    wordiness: false,
    aiVocabulary: false,
    aiArtifacts: false,
    passive: false,
    longSentences: false,
    negativeParallelism: false,
    ruleOfThree: false,
    emDash: false,
    nonAsciiPunct: false,
    styleExceptions: [],
    spellCheck: false,
    grammarCheck: false,
    userWords: [],
};

function decoratedTexts(doc: import("@milkdown/prose/model").Node, config = CONFIG): string[] {
    const set = computeDecorations(doc, config);
    return set.find().map((d) => doc.textBetween(d.from, d.to));
}

describe("DEFAULT_CONFIG fallback", () => {
    // The webview-side fallback (used when the injected __i18n.proofread snapshot
    // is missing) must agree with the package.json setting defaults. Every check
    // defaults ON except `passive` and `negativeParallelism`, which ship OFF
    // because they over-flag ordinary correct English.
    const OFF_BY_DEFAULT = new Set(["passive", "negativeParallelism"]);

    it("boolean defaults should match the contributed setting defaults", () => {
        for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
            if (typeof value === "boolean") {
                const expected = !OFF_BY_DEFAULT.has(key);
                expect(value, `DEFAULT_CONFIG.${key} should default ${expected}`).toBe(expected);
            }
        }
    });
});

describe("computeDecorations", () => {
    it("a filler in a paragraph should be decorated at the exact document range", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really good.")]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["really"]);
    });

    it("offsets in a later paragraph should account for preceding blocks", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("Clean first paragraph.")]),
            schema.node("paragraph", null, [schema.text("The end result was fine.")]),
        ]);

        // iA-style sub-span strike: only the deletable "end" is flagged
        expect(decoratedTexts(doc)).toEqual(["end"]);
    });

    it("a filler inside a code block should not be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("code_block", null, [schema.text("really = very + just")]),
        ]);

        expect(decoratedTexts(doc)).toEqual([]);
    });

    it("a filler inside inline code should not be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [
                schema.text("run "),
                schema.text("really", [schema.mark("inlineCode")]),
                schema.text(" fast"),
            ]),
        ]);

        expect(decoratedTexts(doc)).toEqual([]);
    });

    it("an inline image before a filler should not shift the decorated range", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [
                schema.text("see "),
                schema.node("image"),
                schema.text(" this is really it"),
            ]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["really"]);
    });

    it("a bold (non-code) filler should still be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [
                schema.text("very", [schema.mark("strong")]),
                schema.text(" nice"),
            ]),
        ]);

        expect(decoratedTexts(doc)).toEqual(["very"]);
    });

    it("style check disabled should produce no decorations", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really good.")]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, styleCheck: false })).toEqual([]);
    });

    it("a repeated word should be decorated even with all phrase categories off", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("We saw the the dog.")]),
        ]);

        const config = { ...CONFIG, fillers: false, redundancies: false, cliches: false };
        expect(decoratedTexts(doc, config)).toEqual(["the"]);
    });

    it("a phrase in styleExceptions should not be decorated", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really good.")]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, styleExceptions: ["really"] })).toEqual([]);
    });

    it("a long sentence should be flagged when grammar check is off", () => {
        const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") + ".";
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text(long)]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, longSentences: true, grammarCheck: false })).toHaveLength(1);
    });

    it("a long sentence should defer to Harper when grammar check is on", () => {
        // Harper owns "Long Sentences" (word count + popup) when grammar runs,
        // so the webview flag stands down to avoid the double-underline.
        const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") + ".";
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text(long)]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, longSentences: true, grammarCheck: true })).toEqual([]);
    });
});

describe("computeDecorations finding specs", () => {
    function specsOf(text: string, config = CONFIG): Array<{ class: string; style: { category: string; suggestion: string | null } }> {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text(text)]),
        ]);
        return computeDecorations(doc, config).find().map((d) => d.spec as {
            class: string; style: { category: string; suggestion: string | null };
        });
    }

    it("a deletable phrase hit should carry a Remove suggestion (empty string)", () => {
        const [spec] = specsOf("This is really good.");
        expect(spec.style.category).toBe("fillers");
        expect(spec.style.suggestion).toBe("");
        expect(spec.class).toBe("pf-style-hit");
    });

    it("an em-dash flag should carry the flag class and a hyphen fix", () => {
        const [spec] = specsOf("Yes — no", { ...CONFIG, emDash: true });
        expect(spec.style.category).toBe("emDash");
        expect(spec.style.suggestion).toBe("-");
        expect(spec.class).toContain("pf-style-hit--flag");
    });

    it("a curly apostrophe should normalize to an ASCII apostrophe", () => {
        const [spec] = specsOf("it’s", { ...CONFIG, nonAsciiPunct: true });
        expect(spec.style.category).toBe("nonAsciiPunct");
        expect(spec.style.suggestion).toBe("'");
    });
});
