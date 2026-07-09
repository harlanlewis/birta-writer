import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/prose/model";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { combine, computeDecorations, DEFAULT_CONFIG } from "../plugins/proofread";
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

    it("a long sentence should be flagged regardless of the grammar-check setting", () => {
        // The webview long-sentence flag is computed the same way whether or not
        // grammar check is on; the dedup against Harper's own long-sentence lint
        // happens later, in combine() (see the combine dedup test). This guards
        // the 31–40-word band Harper (>40 words) never reaches from silently
        // losing its flag when grammar check is on.
        const long = Array.from({ length: 35 }, (_, i) => `w${i}`).join(" ") + ".";
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text(long)]),
        ]);

        expect(decoratedTexts(doc, { ...CONFIG, longSentences: true, grammarCheck: false })).toHaveLength(1);
        expect(decoratedTexts(doc, { ...CONFIG, longSentences: true, grammarCheck: true })).toHaveLength(1);
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

    it("an already-spaced em dash should fix to a bare hyphen (no doubled space)", () => {
        const [spec] = specsOf("Yes — no", { ...CONFIG, emDash: true });
        expect(spec.style.category).toBe("emDash");
        expect(spec.style.suggestion).toBe("-");
        expect(spec.class).toContain("pf-style-hit--flag");
    });

    it("an unspaced em dash should fix to a spaced hyphen", () => {
        const [spec] = specsOf("Yes—no", { ...CONFIG, emDash: true });
        expect(spec.style.category).toBe("emDash");
        expect(spec.style.suggestion).toBe(" - ");
    });

    it("a curly apostrophe should normalize to an ASCII apostrophe", () => {
        const [spec] = specsOf("it’s", { ...CONFIG, nonAsciiPunct: true });
        expect(spec.style.category).toBe("nonAsciiPunct");
        expect(spec.style.suggestion).toBe("'");
    });
});

describe("combine — long-sentence dedup against Harper", () => {
    // A 35-word sentence: the webview flags it (>30 words); Harper never would
    // (>40 words). combine() must keep the style flag unless a real Harper
    // long-sentence lint overlaps it.
    const long = Array.from({ length: 35 }, (_, i) => `w${i}`).join(" ") + ".";
    const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text(long)]),
    ]);
    const styleSet = computeDecorations(doc, { ...CONFIG, longSentences: true });

    function harperLongSentenceSet(): DecorationSet {
        // Mirror buildLintDecorations: cover the whole paragraph text.
        const from = 1;
        const to = doc.child(0).content.size + 1;
        const deco = Decoration.inline(from, to, { class: "pf-lint-err" }, {
            class: "pf-lint-err",
            lint: { start: 0, end: to - from, kind: "Readability", message: "This sentence is 35 words long.", suggestions: [] },
        });
        return DecorationSet.create(doc, [deco]);
    }

    it("the style flag should survive when no Harper long-sentence lint overlaps", () => {
        const merged = combine(doc, styleSet, DecorationSet.empty);
        const hasStyleLong = merged.find().some((d) => (d.spec as { style?: { category: string } }).style?.category === "longSentences");
        expect(hasStyleLong).toBe(true);
    });

    it("the style flag should drop where Harper's long-sentence lint overlaps", () => {
        const merged = combine(doc, styleSet, harperLongSentenceSet());
        const specs = merged.find().map((d) => d.spec as { class?: string; style?: { category: string }; lint?: unknown });
        // Harper's lint remains; the duplicate style long-sentence flag is gone.
        expect(specs.some((s) => s.lint)).toBe(true);
        expect(specs.some((s) => s.style?.category === "longSentences")).toBe(false);
    });

    it("a non-long-sentence style hit should survive an overlapping long-sentence lint", () => {
        // A filler inside the sentence must NOT be swept away by the dedup.
        const withFiller = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("This is really " + long)]),
        ]);
        const styleWithFiller = computeDecorations(withFiller, { ...CONFIG, longSentences: true });
        const to = withFiller.child(0).content.size + 1;
        const lintSet = DecorationSet.create(withFiller, [
            Decoration.inline(1, to, { class: "pf-lint-err" }, {
                class: "pf-lint-err",
                lint: { start: 0, end: to - 1, kind: "Readability", message: "This sentence is 38 words long.", suggestions: [] },
            }),
        ]);
        const merged = combine(withFiller, styleWithFiller, lintSet);
        const hasFiller = merged.find().some((d) => (d.spec as { style?: { category: string } }).style?.category === "fillers");
        expect(hasFiller).toBe(true);
    });
});
