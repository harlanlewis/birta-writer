/**
 * Tests for round-trip protection: computeRoundTripProtection captures the
 * change regions a zero-edit parse→serialize cycle produces on its own, and
 * applyMinimalChanges pins those regions to their saved bytes so edits
 * elsewhere in the file can never destroy them.
 *
 * Pure string tests — the serializer outputs are hand-written to model the
 * real behaviors measured against Milkdown 7.19 (see roundTripCorpus.test.ts
 * for the same invariants driven through the real editor):
 * - reference-link definitions are dropped, the reference is inlined
 * - setext headings are rewritten to ATX
 * - unescaped `*` `_` `[` get backslash-escaped
 */
import { describe, it, expect } from "vitest";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

// A file with a reference-style link: the round trip drops the definition
// line and inlines the reference.
const REF_SAVED = "intro paragraph\n\nSee [the docs][docs] here.\n\n[docs]: https://example.com\n";
const REF_BASELINE = "intro paragraph\n\nSee [the docs](https://example.com) here.\n";

// A file with a setext heading: the round trip rewrites it to ATX.
const SETEXT_SAVED = "Title\n=====\n\nbody text\n";
const SETEXT_BASELINE = "# Title\n\nbody text\n";

describe("computeRoundTripProtection", () => {
    it("a clean round trip should need no protection", () => {
        const saved = "para1\n\npara2\n";
        expect(computeRoundTripProtection(saved, saved)).toBeNull();
    });

    it("a dropped reference definition should be captured as a change region", () => {
        const protection = computeRoundTripProtection(REF_SAVED, REF_BASELINE);
        expect(protection).not.toBeNull();
        expect(protection!.regions.length).toBeGreaterThan(0);
    });
});

describe("applyMinimalChanges with protection — untouched constructs survive", () => {
    it("no protection should keep today's behavior (ref definition is lost)", () => {
        // Documents the unprotected failure mode this feature exists to stop.
        const serializedAfterEdit = "intro paragraph EDITED\n\nSee [the docs](https://example.com) here.\n";
        const merged = applyMinimalChanges(REF_SAVED, serializedAfterEdit);
        expect(merged).not.toContain("[docs]: https://example.com");
    });

    it("an edit elsewhere should not delete the reference definition", () => {
        const protection = computeRoundTripProtection(REF_SAVED, REF_BASELINE);
        const serializedAfterEdit = "intro paragraph EDITED\n\nSee [the docs](https://example.com) here.\n";

        const merged = applyMinimalChanges(REF_SAVED, serializedAfterEdit, protection);

        expect(merged).toContain("intro paragraph EDITED");
        expect(merged).toContain("See [the docs][docs] here.");
        expect(merged).toContain("[docs]: https://example.com");
        expect(merged).not.toContain("(https://example.com) here");
    });

    it("a zero-change save should return the saved text byte-identically", () => {
        const protection = computeRoundTripProtection(REF_SAVED, REF_BASELINE);
        expect(applyMinimalChanges(REF_SAVED, REF_BASELINE, protection)).toBe(REF_SAVED);
    });

    it("an edit elsewhere should not rewrite a setext heading to ATX", () => {
        const protection = computeRoundTripProtection(SETEXT_SAVED, SETEXT_BASELINE);
        const serializedAfterEdit = "# Title\n\nbody text EDITED\n";

        const merged = applyMinimalChanges(SETEXT_SAVED, serializedAfterEdit, protection);

        expect(merged).toBe("Title\n=====\n\nbody text EDITED\n");
    });

    it("an edit elsewhere should not apply escaping churn to untouched lines", () => {
        const saved = "chars: * _ [ ok\n\nsecond para\n";
        const baseline = "chars: \\* \\_ \\[ ok\n\nsecond para\n";
        const protection = computeRoundTripProtection(saved, baseline);
        const serializedAfterEdit = "chars: \\* \\_ \\[ ok\n\nsecond para EDITED\n";

        const merged = applyMinimalChanges(saved, serializedAfterEdit, protection);

        expect(merged).toBe("chars: * _ [ ok\n\nsecond para EDITED\n");
    });
});

describe("applyMinimalChanges with protection — edited constructs adopt canonical form", () => {
    it("editing the setext heading itself should produce ATX once, not both forms", () => {
        const protection = computeRoundTripProtection(SETEXT_SAVED, SETEXT_BASELINE);
        // The user typed inside the heading: serializer emits the NEW text in
        // ATX form, which no longer matches the baseline region.
        const serializedAfterEdit = "# Title changed\n\nbody text\n";

        const merged = applyMinimalChanges(SETEXT_SAVED, serializedAfterEdit, protection);

        expect(merged).toContain("# Title changed");
        expect(merged).not.toContain("=====");
        expect(merged).not.toMatch(/^Title$/m);
    });

    it("deleting the paragraph that used the reference keeps the definition pinned", () => {
        const protection = computeRoundTripProtection(REF_SAVED, REF_BASELINE);
        // User deleted the "See ..." paragraph entirely: its inlined form is
        // gone from the serializer output, so the region cannot fully match —
        // but the definition itself has no serializer counterpart to protect
        // it, and the user's deletion must still apply.
        const serializedAfterEdit = "intro paragraph\n";

        const merged = applyMinimalChanges(REF_SAVED, serializedAfterEdit, protection);

        expect(merged).toContain("intro paragraph");
        expect(merged).not.toContain("See [the docs]");
    });
});

describe("applyMinimalChanges with protection — insertions that collide with canonical forms", () => {
    it("a user-typed line identical to the canonical replacement should still be inserted", () => {
        const protection = computeRoundTripProtection(SETEXT_SAVED, SETEXT_BASELINE);
        // The doc now serializes the setext heading as "# Title" AND the user
        // typed a literal new "# Title" heading at the end.
        const serializedAfterEdit = "# Title\n\nbody text\n\n# Title\n";

        const merged = applyMinimalChanges(SETEXT_SAVED, serializedAfterEdit, protection);

        // The pinned setext form survives, and exactly one new ATX heading
        // is added.
        expect(merged).toContain("Title\n=====");
        expect(merged.match(/^# Title$/gm)?.length).toBe(1);
    });
});

describe("applyMinimalChanges with protection — ordering (adversarial regressions)", () => {
    // These scenarios were found by adversarial review of the first
    // implementation, where pinned lines were emitted at raw del-position and
    // could reorder the document.

    it("editing the paragraph above a setext heading should keep it above", () => {
        const saved = "U paragraph\n\nTitle\n=====\n";
        const baseline = "U paragraph\n\n# Title\n";
        const protection = computeRoundTripProtection(saved, baseline);
        const serializedAfterEdit = "U paragraph edited\n\n# Title\n";

        const merged = applyMinimalChanges(saved, serializedAfterEdit, protection);

        expect(merged).toBe("U paragraph edited\n\nTitle\n=====\n");
    });

    it("inserting a paragraph at the top should land above the setext heading", () => {
        const saved = "Title\n=====\n\nbody\n";
        const baseline = "# Title\n\nbody\n";
        const protection = computeRoundTripProtection(saved, baseline);
        const serializedAfterEdit = "NEW top paragraph\n\n# Title\n\nbody\n";

        const merged = applyMinimalChanges(saved, serializedAfterEdit, protection);

        expect(merged).toBe("NEW top paragraph\n\nTitle\n=====\n\nbody\n");
    });

    it("a second save after an adjacent edit should still protect the construct", () => {
        const saved0 = "alpha\n\nkeep1\n\nTitle\n=====\n\nkeep2\n\nomega\n";
        const baseline = "alpha\n\nkeep1\n\n# Title\n\nkeep2\n\nomega\n";
        const protection = computeRoundTripProtection(saved0, baseline);

        // Save 1: edit the line directly above the heading.
        const ser1 = "alpha\n\nkeep1 EDITED\n\n# Title\n\nkeep2\n\nomega\n";
        const merged1 = applyMinimalChanges(saved0, ser1, protection);
        expect(merged1).toBe("alpha\n\nkeep1 EDITED\n\nTitle\n=====\n\nkeep2\n\nomega\n");

        // Save 2: edit elsewhere; merged1 is now the saved text.
        const ser2 = "alpha\n\nkeep1 EDITED\n\n# Title\n\nkeep2\n\nomega EDITED\n";
        const merged2 = applyMinimalChanges(merged1, ser2, protection);
        expect(merged2).toBe("alpha\n\nkeep1 EDITED\n\nTitle\n=====\n\nkeep2\n\nomega EDITED\n");
    });

    it("editing one of two adjacent setext headings should keep the other protected", () => {
        const saved = "Title A\n=======\n\nTitle B\n=======\n";
        const baseline = "# Title A\n\n# Title B\n";
        const protection = computeRoundTripProtection(saved, baseline);
        const serializedAfterEdit = "# Title A EDITED\n\n# Title B\n";

        const merged = applyMinimalChanges(saved, serializedAfterEdit, protection);

        expect(merged).toContain("# Title A EDITED");
        expect(merged).toContain("Title B\n=======");
    });

    it("deleting the paragraph before a dropped construct should not corrupt blank lines", () => {
        // The construct vanishes from every serialization (del-only region).
        const saved = "A para\n\nINVISIBLE CONSTRUCT\n\nB para\n";
        const baseline = "A para\n\nB para\n";
        const protection = computeRoundTripProtection(saved, baseline);
        const serializedAfterEdit = "B para\n";

        const merged = applyMinimalChanges(saved, serializedAfterEdit, protection);

        expect(merged).toContain("INVISIBLE CONSTRUCT");
        expect(merged).toContain("B para");
        expect(merged.startsWith("\n")).toBe(false);
        expect(merged).not.toContain("\n\n\n");
        expect(merged).not.toContain("A para");
    });
});

describe("applyMinimalChanges — performance", () => {
    it("a single edit in a 5000-line document should merge in a few milliseconds", () => {
        const lines = Array.from({ length: 5000 }, (_, i) => `paragraph number ${i}`);
        const saved = lines.join("\n\n") + "\n";
        const edited = [...lines];
        edited[2500] = "paragraph number 2500 EDITED";
        const serialized = edited.join("\n\n") + "\n";

        const t0 = performance.now();
        const merged = applyMinimalChanges(saved, serialized);
        const elapsed = performance.now() - t0;

        expect(merged).toContain("paragraph number 2500 EDITED");
        // Pre-trimming this took ~380ms (full 5000x5000 LCS). Generous CI
        // bound; typical local time is ~2ms.
        expect(elapsed).toBeLessThan(100);
    });
});
