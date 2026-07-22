/**
 * The ONE canonical, ordered list of style-check categories — the single source
 * of truth for both ORDER and LABEL across every surface that shows them:
 *
 *   - the toolbar Checks menu (its Phrases / AI tells / Prose sections),
 *   - the review sidebar's By-type group headers and their order,
 *   - the in-text proofreading popup's category chip (styleTag).
 *
 * Before this, the toolbar and `styleTag` each spelled the labels their own way
 * (`Not X, but Y` vs `AI cadence`, `Curly punctuation` vs `Punctuation`) and the
 * sidebar's order was a second hand-kept copy of the toolbar's — three places to
 * drift. They all read from here now.
 */
import type { StyleCategory } from "./styleMatcher";

export type StyleSection = "Phrases" | "AI tells" | "Prose";

export interface StyleCategoryDef {
    category: StyleCategory;
    /** Display label (English base; wrap in t() at the call site). */
    label: string;
    /** Toolbar Checks-menu section, or null for a category folded into the
     *  master switch (not individually toggleable — currently `repeated`). */
    section: StyleSection | null;
}

/** Canonical order = the toolbar's Phrases → AI tells → Prose reading order,
 *  with the master-folded `repeated` last. */
export const STYLE_CATEGORIES: readonly StyleCategoryDef[] = [
    { category: "fillers", label: "Fillers", section: "Phrases" },
    { category: "redundancies", label: "Redundancies", section: "Phrases" },
    { category: "cliches", label: "Cliches", section: "Phrases" },
    { category: "wordiness", label: "Wordiness", section: "Phrases" },
    { category: "aiVocabulary", label: "AI vocabulary", section: "AI tells" },
    { category: "aiArtifacts", label: "AI boilerplate", section: "AI tells" },
    { category: "negativeParallelism", label: "Not X, but Y", section: "AI tells" },
    { category: "ruleOfThree", label: "Rule of three", section: "AI tells" },
    { category: "passive", label: "Passive voice", section: "Prose" },
    { category: "longSentences", label: "Long sentences", section: "Prose" },
    { category: "emDash", label: "Em dash", section: "Prose" },
    { category: "nonAsciiPunct", label: "Curly punctuation", section: "Prose" },
    { category: "repeated", label: "Repeated words", section: null },
];

/** Toolbar section order. */
export const STYLE_SECTIONS: readonly StyleSection[] = ["Phrases", "AI tells", "Prose"];

const RANK = new Map<string, number>(STYLE_CATEGORIES.map((d, i) => [d.category, i]));
const LABEL = new Map<string, string>(STYLE_CATEGORIES.map((d) => [d.category, d.label]));

/** Position of a category in canonical order (for correctness-first grouping);
 *  an unknown category sorts after all known ones. */
export function styleCategoryRank(category: string): number {
    return RANK.get(category) ?? STYLE_CATEGORIES.length;
}

/** The canonical English label for a category (wrap in t() at the call site). */
export function styleCategoryLabel(category: string): string {
    return LABEL.get(category) ?? "Style";
}
