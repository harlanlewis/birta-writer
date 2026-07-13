/**
 * Three-way line merge (src/utils/merge3.ts): clean merges combine
 * non-overlapping edits from the editor (ours) and the disk (theirs) against
 * their common ancestor; overlapping-but-different edits must conflict, never
 * silently pick a winner.
 */
import { describe, it, expect } from "vitest";
import { merge3, diffLines } from "../utils/merge3";

/** Convenience: assert a clean merge and return the merged text. */
function mergedOf(base: string, ours: string, theirs: string): string {
    const result = merge3(base, ours, theirs);
    expect(result.ok).toBe(true);
    return (result as { ok: true; merged: string }).merged;
}

describe("diffLines", () => {
    it("identical inputs should produce no hunks", () => {
        expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
    });

    it("a single changed line should produce one hunk covering it", () => {
        expect(diffLines(["a", "b", "c"], ["a", "X", "c"])).toEqual([
            { baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 2 },
        ]);
    });

    it("a pure insertion should produce a zero-base-width hunk", () => {
        expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual([
            { baseStart: 1, baseEnd: 1, sideStart: 1, sideEnd: 2 },
        ]);
    });

    it("a pure deletion should produce a zero-side-width hunk", () => {
        expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([
            { baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 1 },
        ]);
    });

    it("two separated edits should produce two hunks", () => {
        const hunks = diffLines(["a", "b", "c", "d", "e"], ["a", "X", "c", "Y", "e"]);
        expect(hunks).toEqual([
            { baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 2 },
            { baseStart: 3, baseEnd: 4, sideStart: 3, sideEnd: 4 },
        ]);
    });

    it("hunks should reproduce the side text when applied to the base", () => {
        // Randomized-ish structural check over a mix of edits.
        const base = ["h1", "p1", "p2", "", "h2", "item1", "item2", "tail"];
        const side = ["h1", "p1-edited", "", "h2", "item1", "new-a", "new-b", "item2", "tail", "appended"];
        const hunks = diffLines(base, side)!;
        const rebuilt: string[] = [];
        let pos = 0;
        for (const h of hunks) {
            rebuilt.push(...base.slice(pos, h.baseStart));
            rebuilt.push(...side.slice(h.sideStart, h.sideEnd));
            pos = h.baseEnd;
        }
        rebuilt.push(...base.slice(pos));
        expect(rebuilt).toEqual(side);
    });
});

describe("merge3 fast paths", () => {
    it("ours identical to theirs should merge to that text", () => {
        expect(mergedOf("a\nb\n", "a\nX\n", "a\nX\n")).toBe("a\nX\n");
    });

    it("only theirs changed should merge to theirs", () => {
        expect(mergedOf("a\nb\n", "a\nb\n", "a\nX\n")).toBe("a\nX\n");
    });

    it("only ours changed should merge to ours", () => {
        expect(mergedOf("a\nb\n", "a\nX\n", "a\nb\n")).toBe("a\nX\n");
    });

    it("all three identical should merge to the same text", () => {
        expect(mergedOf("same\n", "same\n", "same\n")).toBe("same\n");
    });
});

describe("merge3 clean merges", () => {
    const base = "# Title\n\npara one\n\npara two\n\npara three\n";

    it("edits to different regions should both land", () => {
        const ours = "# Title\n\npara one EDITED\n\npara two\n\npara three\n";
        const theirs = "# Title\n\npara one\n\npara two\n\npara three EDITED\n";
        expect(mergedOf(base, ours, theirs)).toBe(
            "# Title\n\npara one EDITED\n\npara two\n\npara three EDITED\n",
        );
    });

    it("edits on ADJACENT lines should merge cleanly (the terminal-tool case)", () => {
        const b = "line1\nline2\nline3\nline4\n";
        const ours = "line1\nline2 mine\nline3\nline4\n";
        const theirs = "line1\nline2\nline3 disk\nline4\n";
        expect(mergedOf(b, ours, theirs)).toBe("line1\nline2 mine\nline3 disk\nline4\n");
    });

    it("an external append should merge with an editor edit at the top", () => {
        const ours = "# Title CHANGED\n\npara one\n\npara two\n\npara three\n";
        const theirs = base + "\npara four\n";
        expect(mergedOf(base, ours, theirs)).toBe(
            "# Title CHANGED\n\npara one\n\npara two\n\npara three\n\npara four\n",
        );
    });

    it("an external deletion should merge with an unrelated editor edit", () => {
        const ours = "# Title\n\npara one EDITED\n\npara two\n\npara three\n";
        const theirs = "# Title\n\npara one\n\npara three\n";
        expect(mergedOf(base, ours, theirs)).toBe("# Title\n\npara one EDITED\n\npara three\n");
    });

    it("both sides making the IDENTICAL change should merge without conflict", () => {
        const both = "# Title\n\npara one SAME EDIT\n\npara two\n\npara three\n";
        // Distinct third edit so no fast path triggers.
        const theirs = "# Title\n\npara one SAME EDIT\n\npara two\n\npara three x\n";
        expect(mergedOf(base, both, theirs)).toBe(
            "# Title\n\npara one SAME EDIT\n\npara two\n\npara three x\n",
        );
    });

    it("an insertion at the boundary of the other side's replacement should keep both", () => {
        const b = "a\nb\nc\n";
        const ours = "a\ninserted\nb\nc\n";     // insert before b
        const theirs = "a\nB2\nC2\n";           // rewrite b and c
        expect(mergedOf(b, ours, theirs)).toBe("a\ninserted\nB2\nC2\n");
    });

    it("multiple interleaved non-overlapping edits should all land", () => {
        const b = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"].join("\n");
        const ours = ["l1", "OURS2", "l3", "l4", "OURS5", "l6", "l7", "l8"].join("\n");
        const theirs = ["l1", "l2", "l3", "THEIRS4", "l5", "l6", "l7", "THEIRS8"].join("\n");
        expect(mergedOf(b, ours, theirs)).toBe(
            ["l1", "OURS2", "l3", "THEIRS4", "OURS5", "l6", "l7", "THEIRS8"].join("\n"),
        );
    });

    it("CRLF content should merge with line endings preserved", () => {
        const b = "a\r\nb\r\nc\r\n";
        const ours = "a\r\nb mine\r\nc\r\n";
        const theirs = "a\r\nb\r\nc\r\nd\r\n";
        expect(mergedOf(b, ours, theirs)).toBe("a\r\nb mine\r\nc\r\nd\r\n");
    });

    it("an empty base should merge two disjoint... no — both sides adding content conflicts; one side adding is clean", () => {
        expect(mergedOf("", "", "new content\n")).toBe("new content\n");
    });

    it("theirs truncating the file should merge with an untouched-region editor edit", () => {
        const b = "keep\nmiddle\ntail1\ntail2\n";
        const ours = "keep EDITED\nmiddle\ntail1\ntail2\n";
        const theirs = "keep\nmiddle\n";
        expect(mergedOf(b, ours, theirs)).toBe("keep EDITED\nmiddle\n");
    });
});

describe("merge3 conflicts", () => {
    const base = "line1\nline2\nline3\n";

    it("both sides editing the same line differently should conflict", () => {
        expect(merge3(base, "line1\nMINE\nline3\n", "line1\nDISK\nline3\n").ok).toBe(false);
    });

    it("both sides inserting different content at the same point should conflict", () => {
        expect(merge3(base, "line1\nmine\nline2\nline3\n", "line1\ndisk\nline2\nline3\n").ok).toBe(false);
    });

    it("one side deleting a line the other edited should conflict", () => {
        expect(merge3(base, "line1\nline3\n", "line1\nline2 EDITED\nline3\n").ok).toBe(false);
    });

    it("overlapping multi-line rewrites should conflict", () => {
        const b = "a\nb\nc\nd\ne\n";
        expect(merge3(b, "a\nX\nY\nd\ne\n", "a\nb\nP\nQ\ne\n").ok).toBe(false);
    });

    it("both sides appending different content at EOF should conflict", () => {
        expect(merge3(base, base + "mine\n", base + "disk\n").ok).toBe(false);
    });

    it("a conflict anywhere should fail the whole merge even with clean hunks elsewhere", () => {
        const b = "top\nmid\nbottom\n";
        const ours = "top MINE\nmid MINE\nbottom\n";
        const theirs = "top MINE\nmid DISK\nbottom\n";
        expect(merge3(b, ours, theirs).ok).toBe(false);
    });
});

describe("merge3 guard rails", () => {
    it("a pathological whole-file rewrite on both sides should bail as a conflict, not hang", () => {
        // Two unrelated large rewrites: edit distance blows the budget.
        const lines = (tag: string) => Array.from({ length: 30_000 }, (_, i) => `${tag}${i}`).join("\n");
        const result = merge3(lines("base"), lines("ours"), lines("theirs"));
        expect(result.ok).toBe(false);
    });

    it("inputs beyond the total line cap should bail as a conflict without diffing", () => {
        const bulk = "x\n".repeat(101_000);
        const result = merge3(bulk + "base", bulk + "ours", bulk + "theirs");
        expect(result.ok).toBe(false);
    });

    it("a large document with small distant edits should still merge cleanly", () => {
        const baseLines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
        const oursLines = [...baseLines];
        oursLines[10] = "line 10 EDITED LOCALLY";
        const theirsLines = [...baseLines];
        theirsLines[4_000] = "line 4000 EDITED ON DISK";
        const merged = mergedOf(baseLines.join("\n"), oursLines.join("\n"), theirsLines.join("\n"));
        const out = merged.split("\n");
        expect(out[10]).toBe("line 10 EDITED LOCALLY");
        expect(out[4_000]).toBe("line 4000 EDITED ON DISK");
        expect(out).toHaveLength(5_000);
    });
});
