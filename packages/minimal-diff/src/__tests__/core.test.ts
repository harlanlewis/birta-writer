/**
 * Core engine tests with a SYNTHETIC format profile — no markdown anywhere.
 * These pin the format-agnostic contract: line pairing by profile key, the
 * blank-line ownership rules of the merge, the two profile structure hooks,
 * and the protection record/repair cycle. Markdown-specific behavior is
 * covered by the (much larger) suites in `webview/__tests__/` through the
 * markdown-bound wrapper.
 */
import { describe, it, expect } from "vitest";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
    type FormatProfile,
} from "../index";

// A deliberately trivial format: keys are whitespace-normalized line bytes
// (so indentation/padding differences are "formatting-only"), and blank
// lines are never structural.
const plain: FormatProfile = {
    keyLines: (lines) => lines.map((l) => l.trim().replace(/\s+/g, " ")),
    glueChangesConstruct: () => false,
    blankSplitsBlock: () => false,
};

describe("applyMinimalChanges (core, synthetic profile)", () => {
    it("an unchanged document should return the saved reference", () => {
        const saved = "alpha\n\nbeta\n";
        expect(applyMinimalChanges(saved, "alpha\n\nbeta\n", plain)).toBe(saved);
    });

    it("a formatting-only difference (equal profile keys) should not be applied", () => {
        const saved = "  alpha   one  \n\nbeta\n";
        const serialized = "alpha one\n\nbeta\n";
        expect(applyMinimalChanges(saved, serialized, plain)).toBe(saved);
    });

    it("an in-place replacement should keep the saved file's blank spacing", () => {
        // Two blanks between alpha and beta are the user's spacing; editing
        // beta must not collapse them to the serializer's single blank.
        const saved = "alpha\n\n\nbeta\n";
        const serialized = "alpha\n\nbeta EDITED\n";
        expect(applyMinimalChanges(saved, serialized, plain)).toBe("alpha\n\n\nbeta EDITED\n");
    });

    it("an insertion should take its blank spacing from the serializer", () => {
        const saved = "alpha\nbeta\n";
        const serialized = "alpha\n\nNEW\n\nbeta\n";
        expect(applyMinimalChanges(saved, serialized, plain)).toBe("alpha\n\nNEW\n\nbeta\n");
    });

    it("a deletion should take the surrounding blank spacing from the serializer", () => {
        const saved = "alpha\n\n\nMID\n\n\nbeta\n";
        const serialized = "alpha\n\nbeta\n";
        expect(applyMinimalChanges(saved, serialized, plain)).toBe("alpha\n\nbeta\n");
    });

    it("blankSplitsBlock should let a serializer-dissolved separator win over saved bytes", () => {
        const profile: FormatProfile = {
            ...plain,
            blankSplitsBlock: (prev, next) => prev.startsWith("> ") && next.startsWith("> "),
        };
        // The serializer now emits the two quote lines contiguously (the
        // blocks merged); an unrelated edit elsewhere makes the save real.
        const saved = "> a\n\n> b\n\nzzz\n";
        const serialized = "> a\n> b\n\nzzz EDITED\n";
        expect(applyMinimalChanges(saved, serialized, profile)).toBe("> a\n> b\n\nzzz EDITED\n");
        // Without the hook the saved blank (user spacing) wins.
        expect(applyMinimalChanges(saved, serialized, plain)).toBe("> a\n\n> b\n\nzzz EDITED\n");
    });

    it("a profile returning fewer keys than lines should throw instead of silently pairing edits away", () => {
        const broken: FormatProfile = { ...plain, keyLines: () => ["only-one"] };
        expect(() => applyMinimalChanges("alpha\nbeta\n", "alpha\nbeta CHANGED\n", broken)).toThrow(
            /one key per line/,
        );
    });

    it("glueChangesConstruct should let a serializer-emitted separating blank win over glued saved bytes", () => {
        const profile: FormatProfile = {
            ...plain,
            glueChangesConstruct: (_prev, next) => next.startsWith(":::"),
        };
        const saved = "para\n:::note\n\nzzz\n";
        const serialized = "para\n\n:::note\n\nzzz EDITED\n";
        expect(applyMinimalChanges(saved, serialized, profile)).toBe(
            "para\n\n:::note\n\nzzz EDITED\n",
        );
        // Without the hook the glued saved bytes win.
        expect(applyMinimalChanges(saved, serialized, plain)).toBe(
            "para\n:::note\n\nzzz EDITED\n",
        );
    });
});

describe("computeRoundTripProtection (core, synthetic profile)", () => {
    it("a cleanly round-tripping document should need no protection", () => {
        expect(computeRoundTripProtection("alpha\n\nbeta\n", "alpha\n\nbeta\n", plain)).toBeNull();
    });

    it("a canonicalized construct should be repaired back to saved bytes on unrelated edits", () => {
        // The zero-edit round trip rewrites OLD-STYLE to NEW-STYLE.
        const saved = "alpha\n\nOLD-STYLE\n\nomega\n";
        const baseline = "alpha\n\nNEW-STYLE\n\nomega\n";
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(protection).not.toBeNull();
        // Zero-edit save: byte-identical (same reference).
        expect(applyMinimalChanges(saved, baseline, plain, protection)).toBe(saved);
        // An edit elsewhere leaves the protected construct untouched.
        expect(
            applyMinimalChanges(saved, "alpha\n\nNEW-STYLE\n\nomega EDITED\n", plain, protection),
        ).toBe("alpha\n\nOLD-STYLE\n\nomega EDITED\n");
    });

    it("editing the protected construct itself should apply the edit (no repair)", () => {
        const saved = "alpha\n\nOLD-STYLE\n\nomega\n";
        const baseline = "alpha\n\nNEW-STYLE\n\nomega\n";
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(
            applyMinimalChanges(saved, "alpha\n\nUSER-REWROTE\n\nomega\n", plain, protection),
        ).toBe("alpha\n\nUSER-REWROTE\n\nomega\n");
    });

    it("a construct the round trip drops should be re-inserted next to its anchor", () => {
        const saved = "alpha\n\n%%secret%%\n\nomega\n";
        const baseline = "alpha\n\nomega\n"; // zero-edit round trip loses the construct
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(protection).not.toBeNull();
        expect(applyMinimalChanges(saved, baseline, plain, protection)).toBe(saved);
        expect(
            applyMinimalChanges(saved, "alpha\n\nomega EDITED\n", plain, protection),
        ).toBe("alpha\n\n%%secret%%\n\nomega EDITED\n");
    });
});
