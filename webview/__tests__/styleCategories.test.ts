import { describe, it, expect } from "vitest";
import {
    STYLE_CATEGORIES,
    STYLE_SECTIONS,
    styleCategoryRank,
    styleCategoryLabel,
} from "../utils/styleCategories";
import { styleTag } from "../plugins/proofread";
import type { StyleCategory } from "../utils/styleMatcher";

/**
 * The canonical style-category list is the single source of truth for the
 * toolbar Checks menu, the review sidebar's grouping/order, and the in-text
 * chip. These guard it against drift — a missing category would silently fall
 * back to "Style", and the sidebar order must track the canonical index.
 */

// Kept in sync with StyleCategory by the coverage test below.
const ALL: StyleCategory[] = [
    "fillers", "redundancies", "cliches", "wordiness", "aiVocabulary", "aiArtifacts",
    "repeated", "passive", "longSentences", "negativeParallelism", "ruleOfThree",
    "emDash", "nonAsciiPunct",
];

describe("style categories — single source of truth", () => {
    it("covers every StyleCategory exactly once", () => {
        const cats = STYLE_CATEGORIES.map((d) => d.category).sort();
        expect(cats).toEqual([...ALL].sort());
        expect(new Set(cats).size).toBe(ALL.length);
    });

    it("rank equals the canonical index; unknowns sort last", () => {
        STYLE_CATEGORIES.forEach((d, i) => expect(styleCategoryRank(d.category)).toBe(i));
        expect(styleCategoryRank("nope")).toBe(STYLE_CATEGORIES.length);
    });

    it("every toggleable category names a known toolbar section", () => {
        for (const d of STYLE_CATEGORIES) {
            if (d.section !== null) { expect(STYLE_SECTIONS).toContain(d.section); }
        }
    });

    it("styleTag reads its label from the canonical list (no divergent copy)", () => {
        // The two that used to diverge from the toolbar.
        expect(styleTag("negativeParallelism")).toBe("Not X, but Y");
        expect(styleTag("nonAsciiPunct")).toBe("Curly punctuation");
        expect(styleTag("fillers")).toBe(styleCategoryLabel("fillers"));
    });
});
