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
    type BaselineLinePair,
    type FormatProfile,
} from "../index";

// A deliberately trivial format: keys are whitespace-normalized line bytes
// (so indentation/padding differences are "formatting-only"), and blank
// lines are never structural.
const plain: FormatProfile = {
    keyLines: (lines) => lines.map((l) => l.trim().replace(/\s+/g, " ")),
    glueChangesConstruct: () => false,
    blankSplitsBlock: () => false,
    reconcileReplacement: (_saved, serial) => serial,
};

/**
 * `plain` with INDENTATION MADE SIGNIFICANT. `plain` trims, so a re-indented
 * line keys EQUAL and merges as a plain `keep` — the one shape a test about
 * indentation must not accidentally use. Here the leading whitespace is part
 * of the key, so re-indenting a line makes it a del/ins pair: the shape
 * markdown's own profile produces when the serializer renders a tab-plus-three
 * as four spaces.
 */
const indentSignificant = (profile: FormatProfile): FormatProfile => ({
    ...profile,
    keyLines: (lines) =>
        lines.map((l) => `${/^[ \t]*/.exec(l)![0]}|${l.trim().replace(/\s+/g, " ")}`),
});

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

describe("reconcileReplacement — the profile's say over an in-place replacement's bytes", () => {
    // A profile that carries the saved line's indentation onto the
    // serializer's line — the shape of markdown's real implementation, minus
    // the markdown.
    const carryIndent: FormatProfile = {
        ...plain,
        reconcileReplacement: (saved, serial) =>
            /^[ \t]*/.exec(saved)![0] + serial.replace(/^[ \t]*/, ""),
    };

    it("an in-place replacement should write the profile's reconciled bytes", () => {
        const saved = "alpha\n\t beta old\n";
        const serialized = "alpha\n  beta new\n";

        expect(applyMinimalChanges(saved, serialized, carryIndent)).toBe("alpha\n\t beta new\n");
        // Without the hook the serializer's whole line lands, indent included.
        expect(applyMinimalChanges(saved, serialized, plain)).toBe("alpha\n  beta new\n");
    });

    it("keeps, pure insertions, and pure deletions should never consult the hook", () => {
        const calls: Array<[string, string]> = [];
        const recording: FormatProfile = {
            ...plain,
            reconcileReplacement: (saved, serial) => {
                calls.push([saved, serial]);
                return serial;
            },
        };
        // A: keep. NEW: pure insertion. B: keep. C: pure deletion. D: keep.
        // E: in-place replacement — the only edit the hook may see.
        applyMinimalChanges(
            "A\n\nB\n\nC\n\nD\n\nE old\n",
            "A\n\nNEW\n\nB\n\nD\n\nE new\n",
            recording,
        );

        expect(calls).toEqual([["E old", "E new"]]);
    });

    it("the reconciled bytes, not the serializer's, should decide the blank run around the line", () => {
        // gapBefore's structure predicates reason about the emitted
        // neighbours, so they must see the line actually written.
        const quoted: FormatProfile = {
            ...plain,
            reconcileReplacement: (_saved, serial) => "> " + serial,
            glueChangesConstruct: (prev, next) => prev.startsWith("> ") && next === "tail",
        };
        // "old"→"new" is the replacement; "tail" is a glued keep whose
        // separating blank only wins if the PREVIOUS line reads as "> new".
        expect(applyMinimalChanges("old\ntail\n", "new\n\ntail\n", quoted)).toBe("> new\n\ntail\n");

        const unquoted: FormatProfile = {
            ...plain,
            // Strips the marker the serializer emitted: the NEXT-line side of
            // the same rule — the predicate must be asked about the stripped
            // line, so the saved blank (user spacing) stays.
            reconcileReplacement: (_saved, serial) => serial.replace(/^> /, ""),
            blankSplitsBlock: (prev, next) => prev.startsWith("> ") && next.startsWith("> "),
        };
        expect(applyMinimalChanges("> a\n\n> b old\n", "> a\n> b new\n", unquoted)).toBe(
            "> a\n\nb new\n",
        );
    });

    it("a hook returning a multi-line string should be ignored (line accounting is one-in one-out)", () => {
        const splitter: FormatProfile = {
            ...plain,
            reconcileReplacement: (_saved, serial) => serial + "\nSMUGGLED",
        };

        expect(applyMinimalChanges("alpha\nbeta old\n", "alpha\nbeta new\n", splitter)).toBe(
            "alpha\nbeta new\n",
        );
    });

    it("a hook that throws should degrade to the serializer's line", () => {
        const thrower: FormatProfile = {
            ...plain,
            reconcileReplacement: () => {
                throw new Error("profile bug");
            },
        };

        expect(applyMinimalChanges("alpha\nbeta old\n", "alpha\nbeta new\n", thrower)).toBe(
            "alpha\nbeta new\n",
        );
    });
});

describe("a run's two sides pair positionally, not by adjacency (MAR-303)", () => {
    /** `plain` plus a recorder of every pair the hooks are offered. */
    const recorder = () => {
        const replaced: Array<[string, string]> = [];
        const inserted: string[][] = [];
        const profile: FormatProfile = {
            ...plain,
            reconcileReplacement: (saved, serial) => {
                replaced.push([saved, serial]);
                return serial;
            },
            reconcileInsertion: (lines) => {
                inserted.push(lines.map((l) => l.serial));
                return lines.map((l) => l.serial);
            },
        };
        return { profile, replaced, inserted };
    };

    it("two adjacent lines edited in one save should pair first-with-first", () => {
        // The LCS emits a run's dels and THEN its inses, so reading `del`
        // immediately followed by `ins` as the replacement found the LAST
        // saved line beside the FIRST serialized one, and left the rest of the
        // run with no saved counterpart at all.
        const { profile, replaced, inserted } = recorder();

        applyMinimalChanges("head\n\nB old\n\nC old\n\ntail\n", "head\n\nB new\n\nC new\n\ntail\n", profile);

        expect(replaced).toEqual([
            ["B old", "B new"],
            ["C old", "C new"],
        ]);
        expect(inserted).toEqual([]);
    });

    it("more saved lines than serialized ones should pair the leading ones and drop the rest", () => {
        const { profile, replaced, inserted } = recorder();

        applyMinimalChanges("head\n\nB old\n\nC old\n\nD old\n\ntail\n", "head\n\nB new\n\nC new\n\ntail\n", profile);

        expect(replaced).toEqual([
            ["B old", "B new"],
            ["C old", "C new"],
        ]);
        expect(inserted).toEqual([]);
    });

    it("more serialized lines than saved ones should pair the leading ones and insert the rest", () => {
        const { profile, replaced, inserted } = recorder();

        applyMinimalChanges("head\n\nB old\n\nC old\n\ntail\n", "head\n\nB new\n\nC new\n\nD new\n\ntail\n", profile);

        expect(replaced).toEqual([
            ["B old", "B new"],
            ["C old", "C new"],
        ]);
        // The surplus is one run, offered to the profile together.
        expect(inserted).toEqual([["D new"]]);
    });

    it("editing a line's neighbour too should not change how that line is written", () => {
        // The invariant the mispairing broke, and the one a user would notice:
        // the merge's treatment of a line is a property of THAT line, never of
        // whether the save happened to carry an edit to the line beside it.
        // (Markdown's real damage: two adjacent table rows edited in one save
        // lost the cell bytes the serializer cannot reproduce, and the first
        // row was handed the second's — MAR-303.)
        const saved = "head\n\n\tB old\n\n\tC old\n\ntail\n";
        const both = "head\n\n  B new\n\n  C new\n\ntail\n";
        const onlyB = "head\n\n  B new\n\n  C old\n\ntail\n";
        const onlyC = "head\n\n  B old\n\n  C new\n\ntail\n";
        const carryIndent: FormatProfile = {
            ...plain,
            reconcileReplacement: (saved_, serial) =>
                /^[ \t]*/.exec(saved_)![0] + serial.replace(/^[ \t]*/, ""),
        };
        const lineOf = (text: string, needle: string) =>
            text.split("\n").find((l) => l.includes(needle));

        const merged = applyMinimalChanges(saved, both, carryIndent);

        expect(lineOf(merged, "B new")).toBe(
            lineOf(applyMinimalChanges(saved, onlyB, carryIndent), "B new"),
        );
        expect(lineOf(merged, "C new")).toBe(
            lineOf(applyMinimalChanges(saved, onlyC, carryIndent), "C new"),
        );
    });

    it("the saved lines a shorter serialized side left over should not come back", () => {
        // Three saved lines, one serialized: the first pairs, and C and D are
        // deletions. The saved side must be consumed through D, or the next
        // `keep`'s saved blank run reaches back across them and splices two
        // deleted lines into the output.
        const saved = "head\n\nB old\n\nC old\n\nD old\n\ntail\n";
        const serialized = "head\n\nB new\n\ntail\n";

        expect(applyMinimalChanges(saved, serialized, plain)).toBe("head\n\nB new\n\ntail\n");
    });

    it("a multi-line run should still take its blank spacing from the serializer", () => {
        // Pairing changed; SPACING deliberately did not. A run of more than
        // one del is `dirty` from its first emitted line, so the serializer's
        // blank runs win across the whole region — the behaviour before the
        // pairing was corrected, kept byte for byte so that fix could be
        // measured against it. (Loosening this collapsed `\n\n---\n` to
        // `\n---\n` in fence-edges.md, turning a thematic break into a setext
        // underline.)
        const saved = "head\n\n\n\nB old\n\n\n\nC old\n\n\n\ntail\n";
        const serialized = "head\n\nB new\n\nC new\n\ntail\n";

        expect(applyMinimalChanges(saved, serialized, plain)).toBe(
            "head\n\nB new\n\nC new\n\ntail\n",
        );
    });

    it("an isolated in-place replacement should still keep the saved spacing", () => {
        // The one-del/one-ins couple is the shape whose surroundings
        // demonstrably did not move, and it keeps the user's blank runs.
        const saved = "head\n\n\n\nB old\n\n\n\ntail\n";
        const serialized = "head\n\nB new\n\ntail\n";

        expect(applyMinimalChanges(saved, serialized, plain)).toBe(
            "head\n\n\n\nB new\n\n\n\ntail\n",
        );
    });
});

describe("baselineFacts — what the zero-edit round trip teaches about a file (MAR-222)", () => {
    /** A profile that records every pairing it is offered. */
    function recorder() {
        const seen: BaselineLinePair[][] = [];
        const profile: FormatProfile = {
            ...plain,
            baselineFacts: (pairs) => {
                seen.push(pairs.map((p) => ({ ...p })));
                return null;
            },
        };
        return { profile, pairs: () => seen[0] ?? [] };
    }

    it("a keep should pair the saved line with the bytes the serializer emitted for it", () => {
        // The whole point: `alpha` and `  alpha  ` key EQUAL under this
        // profile, so the pair records a difference the diff itself hides.
        const { profile, pairs } = recorder();
        computeRoundTripProtection("  alpha  \nBETA\n", "alpha\nbeta rewritten\n", profile);

        expect(pairs()).toContainEqual({ saved: "  alpha  ", serial: "alpha" });
    });

    it("an isolated del/ins couple should pair the two lines", () => {
        const { profile, pairs } = recorder();
        computeRoundTripProtection("alpha\nBETA\ngamma\n", "alpha\nbeta rewritten\ngamma\n", profile);

        expect(pairs()).toContainEqual({ saved: "BETA", serial: "beta rewritten" });
    });

    it("a multi-line del/ins run should contribute no pairs at all", () => {
        // The LCS emits a run's dels first and its inses after, so "a del
        // followed by an ins" pairs the LAST saved line with the FIRST
        // serialized one. Here that would claim `TWO` became `one rewritten`.
        const { profile, pairs } = recorder();
        computeRoundTripProtection(
            "alpha\nONE\nTWO\ngamma\n",
            "alpha\none rewritten\ntwo rewritten\ngamma\n",
            profile,
        );

        expect(pairs().map((p) => p.saved)).toEqual(["alpha", "gamma"]);
    });

    it("a run whose lines differ only in indentation should pair them line by line", () => {
        // MAR-231. Two neighbouring lines the round trip merely re-indented
        // form ONE 2-del/2-ins run, which used to teach nothing at all — and
        // an indent fact is exactly what such a run is evidence of.
        const { profile, pairs } = recorder();
        computeRoundTripProtection(
            "alpha\n\tONE\n\tTWO\nomega\n",
            "alpha\n  ONE\n  TWO\nomega\n",
            indentSignificant(profile),
        );

        expect(pairs()).toContainEqual({ saved: "\tONE", serial: "  ONE" });
        expect(pairs()).toContainEqual({ saved: "\tTWO", serial: "  TWO" });
    });

    it("a run with equal line counts but a differing body should contribute no pairs", () => {
        // The line counts matching is NOT the licence — a span where one
        // construct was dropped and another expanded has equal counts and no
        // correspondence at all. The bytes have to show one, and here the
        // second line's body was rewritten, so the whole run is refused
        // rather than partly believed.
        const { profile, pairs } = recorder();
        computeRoundTripProtection(
            "alpha\n\tONE\n\tTWO\nomega\n",
            "alpha\n  ONE\n  two rewritten\nomega\n",
            indentSignificant(profile),
        );

        expect(pairs().map((p) => p.saved)).toEqual(["alpha", "omega"]);
    });

    it("a run whose two sides have different line counts should contribute no pairs", () => {
        const { profile, pairs } = recorder();
        computeRoundTripProtection(
            "alpha\n\tONE\n\tTWO\nomega\n",
            "alpha\n  ONE\nomega\n",
            indentSignificant(profile),
        );

        expect(pairs().map((p) => p.saved)).toEqual(["alpha", "omega"]);
    });

    it("a construct the serializer drops should contribute no pair", () => {
        const { profile, pairs } = recorder();
        computeRoundTripProtection("alpha\nDROPPED\ngamma\n", "alpha\ngamma\n", profile);

        expect(pairs().map((p) => p.saved)).toEqual(["alpha", "gamma"]);
    });

    it("the distilled value should be handed back to reconcileReplacement", () => {
        const token = { distilled: true };
        const received: unknown[] = [];
        const profile: FormatProfile = {
            ...plain,
            baselineFacts: () => token,
            reconcileReplacement: (_saved, serial, facts) => {
                received.push(facts);
                return serial;
            },
        };
        const saved = "alpha\nBETA\ngamma\n";
        const protection = computeRoundTripProtection(saved, "alpha\nbeta rewritten\ngamma\n", profile);
        received.length = 0; // ignore the protection self-check's own merge

        applyMinimalChanges(saved, "alpha\nBETA edited\ngamma\n", profile, protection);

        expect(received).toEqual([token]);
    });

    it("a merge with no protection should hand the hook null rather than undefined", () => {
        const received: unknown[] = [];
        const profile: FormatProfile = {
            ...plain,
            reconcileReplacement: (_saved, serial, facts) => {
                received.push(facts);
                return serial;
            },
        };

        applyMinimalChanges("alpha\nBETA\n", "alpha\nBETA edited\n", profile);

        expect(received).toEqual([null]);
    });

    it("a profile without the optional hook should still merge", () => {
        expect(computeRoundTripProtection("alpha\nBETA\n", "alpha\nbeta rewritten\n", plain))
            .not.toBeUndefined();
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

describe("round-trip protection — a run the round trip only re-indented (MAR-231)", () => {
    // Two neighbouring lines re-indented by the round trip are consecutive on
    // BOTH sides, so adjacency grouping leaves them in one all-or-nothing
    // region: editing either used to canonicalize the other's indentation as
    // collateral damage. Where the run corresponds line by line, each line's
    // canonical form is exactly its own counterpart, so the region splits.
    const profile = indentSignificant(plain);
    const saved = "alpha\n\tONE\n\tTWO\nomega\n";
    const baseline = "alpha\n  ONE\n  TWO\nomega\n";

    it("a zero-edit save should still be byte-identical", () => {
        const protection = computeRoundTripProtection(saved, baseline, profile);
        expect(protection).not.toBeNull();
        expect(applyMinimalChanges(saved, baseline, profile, protection)).toBe(saved);
    });

    it("editing one of the two lines should leave the other's saved bytes alone", () => {
        const protection = computeRoundTripProtection(saved, baseline, profile);

        expect(
            applyMinimalChanges(saved, "alpha\n  ONE EDITED\n  TWO\nomega\n", profile, protection),
        ).toBe("alpha\n  ONE EDITED\n\tTWO\nomega\n");
    });

    it("a run whose bodies were rewritten should stay one all-or-nothing region", () => {
        // The boundary of the split, pinned deliberately: without a line-by-line
        // correspondence in the bytes there is nothing to split ON, and guessing
        // one is how a mispaired region writes the wrong construct's bytes.
        const rewritten = "alpha\nONE\nTWO\nomega\n";
        const rewrittenBaseline = "alpha\none rewritten\ntwo rewritten\nomega\n";
        const protection = computeRoundTripProtection(rewritten, rewrittenBaseline, plain);
        expect(protection).not.toBeNull();

        expect(
            applyMinimalChanges(
                rewritten,
                "alpha\none rewritten EDITED\ntwo rewritten\nomega\n",
                plain,
                protection,
            ),
        ).toBe("alpha\none rewritten EDITED\ntwo rewritten\nomega\n");
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

// ─── Line endings (MAR-223) ─────────────────────────────────────────────────
//
// The serializer always emits LF. The engine owns the mapping back onto the
// saved file's endings: untouched lines keep their own bytes, invented lines
// get the document's dominant ending, and CRLF↔LF never registers as an edit.

/** Render each line's ending, so a failure names the styles rather than
 *  printing two strings that look identical in the diff. */
const eols = (text: string): string =>
    text.split("\n").slice(0, -1).map((l) => (l.endsWith("\r") ? "CRLF" : "LF")).join(",");

// A profile that keys RAW bytes. `plain` trims, which strips a `\r` in its own
// key BY ACCIDENT — so a CRLF test written against `plain` passes on the broken
// engine and pins nothing. Markdown really has raw-keyed classes: fence content
// and indented code compare verbatim user bytes, so a tab-vs-space edit inside a
// Makefile fence registers as a real edit. Anything asserting that an ending is
// invisible to the profile must use this one.
const raw: FormatProfile = {
    ...plain,
    keyLines: (lines) => lines.map((l) => `\x00RAW${l}`),
    // Makes the keep/replacement distinction visible: a keep writes the saved
    // bytes, a replacement shouts.
    reconcileReplacement: (_saved, serial) => serial.toUpperCase(),
};

describe("line endings", () => {
    const crlf = "alpha\r\n\r\nbeta\r\n\r\ngamma\r\n";
    const crlfSerial = "alpha\n\nbeta\n\ngamma\n";

    it("a CRLF document with no edit should key as unchanged (nothing to protect)", () => {
        // The headline bug: with `\r` inside the comparison key, a zero-edit
        // round trip diffed as a WHOLE-FILE rewrite, so round-trip protection —
        // meant for constructs the parser cannot reproduce — was spent entirely
        // on holding the line endings, one region per line.
        expect(computeRoundTripProtection(crlf, crlfSerial, raw)).toBeNull();
        expect(applyMinimalChanges(crlf, crlfSerial, raw)).toBe(crlf);
    });

    it("an edited line in a CRLF document should come back CRLF, not LF", () => {
        const merged = applyMinimalChanges(crlf, "alpha\n\nbetaX\n\ngamma\n", plain);
        expect(merged).toBe("alpha\r\n\r\nbetaX\r\n\r\ngamma\r\n");
        expect(eols(merged)).toBe("CRLF,CRLF,CRLF,CRLF,CRLF");
    });

    it("a line inserted into a CRLF document should carry CRLF", () => {
        // Insertions have no saved counterpart, so their ending is invented from
        // the document's dominant style — the half a per-line carry in the merge
        // layer could never have reached.
        const merged = applyMinimalChanges(crlf, "alpha\n\nbeta\n\ndelta\n\ngamma\n", plain);
        expect(merged).toBe("alpha\r\n\r\nbeta\r\n\r\ndelta\r\n\r\ngamma\r\n");
        expect(eols(merged)).toBe("CRLF,CRLF,CRLF,CRLF,CRLF,CRLF,CRLF");
    });

    it("an LF document should be untouched by the CRLF machinery", () => {
        // Vacuous by design — a regression guard, not a discriminator.
        const lf = "alpha\n\nbeta\n";
        expect(applyMinimalChanges(lf, "alpha\n\nbeta\n", plain)).toBe(lf);
        expect(applyMinimalChanges(lf, "alpha\n\nbetaX\n", plain)).toBe("alpha\n\nbetaX\n");
    });

    it("a document with MIXED endings should keep each untouched line's own ending", () => {
        // Normalizing to the dominant ending would be the easy fix and would
        // rewrite lines the user never touched — the zero-edit save would stop
        // being byte-identical. Every `keep` writes its own saved bytes instead.
        // Keyed RAW: under `plain` the odd line's ending vanishes into `.trim()`
        // and this asserts nothing.
        const mixed = "alpha\r\n\r\nbeta\n\r\ngamma\r\n";
        expect(applyMinimalChanges(mixed, crlfSerial, raw)).toBe(mixed);

        const merged = applyMinimalChanges(mixed, "alpha\n\nbetaX\n\ngamma\n", plain);
        expect(eols(merged)).toBe("CRLF,CRLF,LF,CRLF,CRLF");
    });

    it("a dominant-LF document should give an inserted line LF even when some lines are CRLF", () => {
        const mostlyLf = "alpha\n\nbeta\r\n\ngamma\n";
        expect(applyMinimalChanges(mostlyLf, crlfSerial, raw)).toBe(mostlyLf);

        const merged = applyMinimalChanges(mostlyLf, "alpha\n\nbeta\n\ndelta\n\ngamma\n", plain);
        expect(eols(merged)).toBe("LF,LF,CRLF,LF,LF,LF,LF");
    });

    it("a construct re-inserted by round-trip protection should come back CRLF", () => {
        // The repair path splices SAVED bytes into a serialization that has
        // already been re-emitted with the document's endings; this pins that
        // the two agree, so a protected construct does not arrive as an LF
        // island. (The blank separators repair invents around it are a different
        // matter — the merge re-sources blank runs from the saved or serialized
        // gap, so those bytes are normally discarded again.)
        const saved = "alpha\r\n\r\n%%secret%%\r\n\r\nomega\r\n";
        const baseline = "alpha\n\nomega\n"; // the round trip drops the construct
        const protection = computeRoundTripProtection(saved, baseline, plain);
        expect(protection).not.toBeNull();
        expect(applyMinimalChanges(saved, baseline, plain, protection)).toBe(saved);

        const merged = applyMinimalChanges(saved, "alpha\n\nomega EDITED\n", plain, protection);
        expect(merged).toBe("alpha\r\n\r\n%%secret%%\r\n\r\nomega EDITED\r\n");
        expect(eols(merged)).toBe("CRLF,CRLF,CRLF,CRLF,CRLF");
    });
});

// The final element of a `\n` split is the text AFTER the last ending, not a
// line — it carries no ending of its own. Both directions of forgetting that
// reintroduce the very mixed-ending file this mechanism prevents.
describe("line endings — the unterminated final segment", () => {
    it("appending to a CRLF file with no trailing newline should not give its last line an LF", () => {
        const saved = "alpha\r\n\r\nbeta"; // no final newline
        const merged = applyMinimalChanges(saved, "alpha\n\nbeta\n\ndelta\n", plain);
        expect(merged).toBe("alpha\r\n\r\nbeta\r\n\r\ndelta\r\n");
        expect(eols(merged)).toBe("CRLF,CRLF,CRLF,CRLF,CRLF");
    });

    it("editing that last line AND appending should still terminate it with CRLF", () => {
        const saved = "alpha\r\n\r\nbeta";
        const merged = applyMinimalChanges(saved, "alpha\n\nbeta X\n\ndelta\n", plain);
        expect(eols(merged)).toBe("CRLF,CRLF,CRLF,CRLF,CRLF");
    });

    it("a CRLF file with no trailing newline should not GAIN one when only edited", () => {
        const saved = "alpha\r\n\r\nbeta";
        expect(applyMinimalChanges(saved, "alpha\n\nbeta X\n", plain)).toBe("alpha\r\n\r\nbeta X");
    });

    it("a trailing CR in the final segment is CONTENT and must not migrate to another line", () => {
        // An LF document whose last segment happens to end in a bare CR. Reading
        // that CR as a terminator re-attached it to the FIRST line the merge
        // emitted, inventing a CRLF in a file that had none.
        const saved = "# Title\n\nbody one\rbody two\r";
        const merged = applyMinimalChanges(saved, "# Title\n\nbody one\n\nbody two\n", plain);
        expect(merged).toBe("# Title\n\nbody one\n\nbody two\n");
        expect(eols(merged)).toBe("LF,LF,LF,LF,LF");
    });

    it("a classic-Mac CR-separated file should not sprout a CRLF line", () => {
        const merged = applyMinimalChanges("alpha\rbeta\rgamma\r", "alpha\n\nbeta\n\ngamma\n", plain);
        expect(merged).toBe("alpha\n\nbeta\n\ngamma\n");
        expect(eols(merged)).toBe("LF,LF,LF,LF,LF");
    });
});

describe("line endings — dominant-ending edges", () => {
    // dominantEol is not exported; probe it through the ending the INSERTED
    // line receives, which is the only thing it decides.
    //
    // It must be THAT line's ending, not "does any line in the output carry a
    // `\r`" — the saved side of a mixed document already does, so the loose
    // form reports CRLF no matter what dominantEol decided and the assertion
    // is vacuous. That is exactly how the tie case below came to be written
    // asserting the opposite of its own name and still passing.
    const insertedEnding = (saved: string, serialized: string): string => {
        const merged = applyMinimalChanges(saved, serialized, plain);
        const line = merged.split("\n").find((l) => l.startsWith("delta"));
        expect(line, "the probe line was not inserted at all").toBeDefined();
        return line!.endsWith("\r") ? "CRLF" : "LF";
    };

    it("a document opening with a blank LF line should not count it as CRLF", () => {
        expect(insertedEnding("\nalpha\n", "\nalpha\n\ndelta\n")).toBe("LF");
    });

    it("a document with no line ending at all should insert LF", () => {
        expect(insertedEnding("alpha", "alpha\n\ndelta\n")).toBe("LF");
    });

    it("an exact tie should resolve to LF", () => {
        // One CRLF, one LF: `crlf > lf` is false, so LF wins.
        expect(insertedEnding("alpha\r\nbeta\n", "alpha\nbeta\ndelta\n")).toBe("LF");
    });

    it("a CRLF majority should win over a lone LF line", () => {
        expect(insertedEnding("a\r\nb\r\nc\n", "a\nb\nc\ndelta\n")).toBe("CRLF");
    });
});
