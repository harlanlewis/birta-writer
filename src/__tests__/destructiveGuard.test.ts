/**
 * The destructive-change tripwire's pure threshold logic (MAR-114). The
 * provider-level behavior (slot arming, the restore command) is covered in
 * markdownEditorProvider.tripwire.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
    countSignificantLines,
    judgeReplacement,
    TRIPWIRE_MIN_LINES,
    TRIPWIRE_ABSOLUTE_LINES,
} from "../destructiveGuard";

/** A document of `n` distinct significant lines. */
const doc = (n: number, prefix = "line"): string =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

describe("countSignificantLines", () => {
    it("blank and whitespace-only lines should not count", () => {
        expect(countSignificantLines("a\n\n  \n\t\nb\n")).toBe(2);
    });

    it("an empty document should count zero", () => {
        expect(countSignificantLines("")).toBe(0);
        expect(countSignificantLines("\n\n\n")).toBe(0);
    });
});

describe("judgeReplacement", () => {
    it("growth or an unchanged line count should never trip", () => {
        expect(judgeReplacement(doc(50), doc(80)).tripped).toBe(false);
        expect(judgeReplacement(doc(50), doc(50)).tripped).toBe(false);
    });

    it("a removal below the line floor should not trip even when it wipes a small document", () => {
        expect(judgeReplacement(doc(TRIPWIRE_MIN_LINES - 1), "").tripped).toBe(false);
    });

    it("wiping a document at the line floor should trip", () => {
        const verdict = judgeReplacement(doc(TRIPWIRE_MIN_LINES), "");
        expect(verdict.tripped).toBe(true);
        expect(verdict.removed).toBe(TRIPWIRE_MIN_LINES);
    });

    it("a floor-sized removal should trip only when it also meets the fraction", () => {
        // 8 of 80 = exactly 10% → trips; 8 of 81 falls under 10% → does not.
        expect(judgeReplacement(doc(80), doc(80 - TRIPWIRE_MIN_LINES)).tripped).toBe(true);
        expect(judgeReplacement(doc(81), doc(81 - TRIPWIRE_MIN_LINES)).tripped).toBe(false);
    });

    it("a huge absolute removal should trip regardless of document size", () => {
        // 200 of 5000 is only 4%, far under the fraction arm.
        const big = 5000;
        expect(judgeReplacement(doc(big), doc(big - TRIPWIRE_ABSOLUTE_LINES)).tripped).toBe(true);
        expect(judgeReplacement(doc(big), doc(big - TRIPWIRE_ABSOLUTE_LINES + 1)).tripped).toBe(false);
    });

    it("replacing significant lines with blank lines should count as removal", () => {
        const before = doc(20);
        const after = "line 0\n" + "\n".repeat(40);
        const verdict = judgeReplacement(before, after);
        expect(verdict.tripped).toBe(true);
        expect(verdict.afterSig).toBe(1);
    });
});
