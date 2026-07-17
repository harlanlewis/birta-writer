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

describe("round-trip protection — suppression regions (serializer-synthesized lines)", () => {
    // The serializer emits a trailing CLOSE line the saved file lacks (the
    // markdown incarnation: a close fence synthesized for a document ending
    // in an unclosed code fence — MAR-162). At baseline that is a pure
    // insertion, which byte-pinning cannot express; protection records it as
    // a suppression region instead.
    const saved = "alpha\n\ncode line\n";
    const baseline = "alpha\n\ncode line\nCLOSE\n";

    it("a zero-edit save should not write the synthesized line", () => {
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(protection).not.toBeNull();
        expect(applyMinimalChanges(saved, baseline, plain, protection)).toBe(saved);
    });

    it("an edit elsewhere should still suppress the synthesized line", () => {
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(
            applyMinimalChanges(saved, "alpha EDITED\n\ncode line\nCLOSE\n", plain, protection),
        ).toBe("alpha EDITED\n\ncode line\n");
    });

    it("editing a suppression anchor should stand down and write the canonical line", () => {
        // The user touched the construct the synthesized line belongs to
        // (its preceding neighbor changed), so the suppression's identity is
        // gone — canonical form wins on touched constructs, same as for
        // rewrites: the CLOSE line is written after all.
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(
            applyMinimalChanges(saved, "alpha\n\ncode line MORE\nCLOSE\n", plain, protection),
        ).toBe("alpha\n\ncode line MORE\nCLOSE\n");
    });

    it("a user-typed twin of the synthesized line must not be deleted (both anchors required)", () => {
        // The user deleted the construct and typed a literal CLOSE line of
        // their own at the end. It matches the recorded insNorms and sits at
        // the recorded end-of-document anchor, but its OTHER neighbor does
        // not match — deleting it would be data loss, so the suppression
        // must not fire on a single anchor hit.
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(
            applyMinimalChanges(saved, "alpha\nCLOSE\n", plain, protection),
            // (the blank is the saved spacing — "code line"→"CLOSE" merges as
            // an in-place replacement; what matters here is CLOSE surviving)
        ).toBe("alpha\n\nCLOSE\n");
    });

    it("suppression should compose with a byte-pinned rewrite in the same document", () => {
        const saved2 = "Title\n=====\n\nmid\n\ncode line\n";
        const baseline2 = "# Title\n\nmid\n\ncode line\nCLOSE\n";
        const protection = computeRoundTripProtection(saved2, baseline2, plain);
        expect(protection).not.toBeNull();
        expect(applyMinimalChanges(saved2, baseline2, plain, protection)).toBe(saved2);
        expect(
            applyMinimalChanges(saved2, "# Title\n\nmid EDITED\n\ncode line\nCLOSE\n", plain, protection),
        ).toBe("Title\n=====\n\nmid EDITED\n\ncode line\n");
    });
});

describe("round-trip protection — mid-document suppression (two string anchors)", () => {
    // Suppressions are not EOF-only: a container construct can auto-close
    // mid-document (markdown: an unclosed fence nested in a blockquote closes
    // at the quote's end), giving the region a real line on BOTH sides.
    const saved = "alpha\ninner last\nafter\n\nomega\n";
    const baseline = "alpha\ninner last\nSYNTH\nafter\n\nomega\n";

    it("a zero-edit save should not write the synthesized line", () => {
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(protection).not.toBeNull();
        expect(applyMinimalChanges(saved, baseline, plain, protection)).toBe(saved);
    });

    it("an edit elsewhere should still suppress the synthesized line", () => {
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(
            applyMinimalChanges(saved, "alpha\ninner last\nSYNTH\nafter\n\nomega EDITED\n", plain, protection),
        ).toBe("alpha\ninner last\nafter\n\nomega EDITED\n");
    });

    it("editing the FOLLOWING anchor should stand down and write the canonical line", () => {
        // The EOF-shaped tests can only exercise the preceding anchor; this
        // pins that the next-side anchor is checked too.
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(
            applyMinimalChanges(saved, "alpha\ninner last\nSYNTH\nafter EDITED\n\nomega\n", plain, protection),
        ).toBe("alpha\ninner last\nSYNTH\nafter EDITED\n\nomega\n");
    });
});
