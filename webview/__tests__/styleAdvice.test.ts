/**
 * Style-check microcopy must earn its interruption: the popup advice has to say
 * something the category chip (styleTag) doesn't already say. This guards
 * against regressing to tautologies like "Passive voice → Consider the active
 * voice", which told the reader nothing new.
 */
import { describe, it, expect } from "vitest";
import { styleAdvice, styleTag } from "../plugins/proofread";
import type { StyleCategory } from "../utils/styleMatcher";

const CATEGORIES: StyleCategory[] = [
    "fillers", "redundancies", "cliches", "wordiness", "aiVocabulary", "aiArtifacts",
    "repeated", "passive", "longSentences", "negativeParallelism", "ruleOfThree",
    "emDash", "nonAsciiPunct",
];

describe("styleAdvice", () => {
    it("every category should have non-empty advice", () => {
        for (const category of CATEGORIES) {
            expect(styleAdvice(category), `advice for ${category}`).not.toBe("");
        }
    });

    it("advice should not merely restate the category chip", () => {
        for (const category of CATEGORIES) {
            const advice = styleAdvice(category).toLowerCase();
            const tag = styleTag(category).toLowerCase();
            expect(advice, `${category} advice restates its chip`).not.toBe(tag);
            // Real guidance is a clause, not a two-word label echoed back.
            expect(advice.length, `${category} advice too thin to be useful`).toBeGreaterThan(tag.length + 8);
        }
    });

    it("passive-voice advice should tell the reader what to do, not just name it", () => {
        const advice = styleAdvice("passive");
        // The specific anti-pattern this replaced.
        expect(advice).not.toBe("Consider the active voice.");
        // It should point at the actual move: lead with who acts.
        expect(advice.toLowerCase()).toContain("who acts");
    });
});
