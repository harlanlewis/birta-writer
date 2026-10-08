import { describe, expect, it } from "vitest";
import { foldedSegments } from "../components/pathBar/collapse";

describe("foldedSegments", () => {
    // root, three folders, the file
    const widths = [100, 80, 80, 80, 200];
    const all = widths.reduce((a, b) => a + b, 0);
    const ellipsis = 30;

    it("a bar with room for every segment should fold nothing", () => {
        expect(foldedSegments(widths, ellipsis, all)).toEqual([]);
    });

    it("a bar one pixel short should fold the folder nearest the root, and pay for the ellipsis", () => {
        expect(foldedSegments(widths, ellipsis, all - 1)).toEqual([1]);
        // Folding one 80 and adding the 30 ellipsis frees 50: the next pixel
        // short of that needs a second folder.
        expect(foldedSegments(widths, ellipsis, all - 50)).toEqual([1]);
        expect(foldedSegments(widths, ellipsis, all - 51)).toEqual([1, 2]);
    });

    it("a narrowing bar should fold the middle nearest-the-root first, then the root, and never the file", () => {
        const seen: number[][] = [];
        for (let available = all; available >= 0; available -= 5) {
            const folded = foldedSegments(widths, ellipsis, available);
            expect(folded).not.toContain(widths.length - 1);
            seen.push(folded);
        }
        // Each step folds a superset of the step before it: progressive.
        for (let i = 1; i < seen.length; i++) {
            expect(seen[i].length).toBeGreaterThanOrEqual(seen[i - 1].length);
            expect(seen[i - 1].every((x) => seen[i].includes(x))).toBe(true);
        }
        const distinct = [...new Set(seen.map((s) => s.join(",")))];
        expect(distinct).toEqual(["", "1", "1,2", "1,2,3", "0,1,2,3"]);
    });

    it("a path of only a root and a file should fold the root when the two do not fit", () => {
        expect(foldedSegments([100, 200], ellipsis, 300)).toEqual([]);
        expect(foldedSegments([100, 200], ellipsis, 299)).toEqual([0]);
    });

    it("a path of one segment should fold nothing however narrow", () => {
        expect(foldedSegments([200], ellipsis, 10)).toEqual([]);
    });
});
