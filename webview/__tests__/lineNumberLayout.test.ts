/**
 * layoutLineNumbers: where each source line's number actually goes.
 *
 * The gutter's spacing is deliberately irregular — a heading, a table row, a
 * line of code and a paragraph that wraps to six visual rows all occupy one
 * source line and wildly different heights. These tests pin the three rules
 * that make that irregularity readable rather than broken: nothing paints above
 * the line before it, an unmeasurable line is placed by interpolation, and
 * anything that cannot clear its neighbour is dropped instead of overlapping.
 */
import { describe, it, expect } from "vitest";
import { layoutLineNumbers, type MeasuredLine } from "../components/lineNumbers/layout";

const OPTS = { minGap: 10, lineHeight: 20 };

/** `[line, top]` pairs, for readable fixtures. */
const at = (...pairs: Array<[number, number | null]>): MeasuredLine[] =>
    pairs.map(([line, top]) => ({ line, top }));

const lines = (result: ReturnType<typeof layoutLineNumbers>): number[] =>
    result.map((r) => r.line);

describe("layoutLineNumbers — measured lines", () => {
    it("well-spaced measured lines should all survive at their own tops", () => {
        const out = layoutLineNumbers(at([1, 0], [2, 30], [3, 60]), OPTS);
        expect(out).toEqual([{ line: 1, top: 0 }, { line: 2, top: 30 }, { line: 3, top: 60 }]);
    });

    it("an empty input should produce nothing", () => {
        expect(layoutLineNumbers([], OPTS)).toEqual([]);
    });

    it("a top that measures BACKWARDS should be pinned to its predecessor", () => {
        // A stale or inverted rect (a sticky heading, a float) must never paint
        // a later line above an earlier one.
        const out = layoutLineNumbers(at([1, 100], [2, 40], [3, 200]), OPTS);
        expect(out).toEqual([{ line: 1, top: 100 }, { line: 3, top: 200 }]);
        // Line 2 clamped to 100, which then collides with line 1 and yields.
    });

    it("wildly different block heights should be preserved, not evened out", () => {
        // A heading (small), a table (tall), a paragraph (small). The gutter
        // tracks the renderer; it does not impose a ladder.
        const out = layoutLineNumbers(at([1, 0], [2, 24], [3, 300]), OPTS);
        expect(out.map((r) => r.top)).toEqual([0, 24, 300]);
    });
});

describe("layoutLineNumbers — interpolation", () => {
    it("a single blank line should land halfway between its neighbours", () => {
        const out = layoutLineNumbers(at([1, 0], [2, null], [3, 60]), OPTS);
        expect(out).toEqual([{ line: 1, top: 0 }, { line: 2, top: 30 }, { line: 3, top: 60 }]);
    });

    it("a RUN of blank lines should divide the gap evenly", () => {
        const out = layoutLineNumbers(at([1, 0], [2, null], [3, null], [4, null], [5, 80]), OPTS);
        expect(out).toEqual([
            { line: 1, top: 0 },
            { line: 2, top: 20 },
            { line: 3, top: 40 },
            { line: 4, top: 60 },
            { line: 5, top: 80 },
        ]);
    });

    it("a trailing run with nothing below should step down by a line each", () => {
        // Blank lines at the end of the document: there is no `after` to divide
        // toward, so the ambient line height is the only honest spacing.
        const out = layoutLineNumbers(at([1, 100], [2, null], [3, null]), OPTS);
        expect(out).toEqual([
            { line: 1, top: 100 },
            { line: 2, top: 120 },
            { line: 3, top: 140 },
        ]);
    });

    it("a leading run with nothing above should step UP to reach the first measured line", () => {
        const out = layoutLineNumbers(at([1, null], [2, null], [3, 100]), OPTS);
        expect(out).toEqual([
            { line: 1, top: 60 },
            { line: 2, top: 80 },
            { line: 3, top: 100 },
        ]);
    });

    it("lines with nothing measured anywhere should be dropped, not invented", () => {
        // The index could verify no block at all. Interpolating from nothing
        // would be fiction, and a fictional line number is the one outcome
        // worse than no line numbers.
        expect(layoutLineNumbers(at([1, null], [2, null]), OPTS)).toEqual([]);
    });
});

describe("layoutLineNumbers — collisions", () => {
    it("interpolated lines that cannot fit the gap should be dropped", () => {
        // Four blank lines into a 12px gap at minGap 10: only one can fit.
        const out = layoutLineNumbers(
            at([1, 0], [2, null], [3, null], [4, null], [5, null], [6, 12]),
            OPTS,
        );
        expect(lines(out)).toEqual([1, 6]);
        expect(out.every((r, i, all) => i === 0 || r.top - all[i - 1].top >= OPTS.minGap)).toBe(true);
    });

    it("two measured lines the renderer collapsed together should not overlap", () => {
        const out = layoutLineNumbers(at([1, 0], [2, 3], [3, 40]), OPTS);
        expect(lines(out)).toEqual([1, 3]);
    });

    it("a measured line should EVICT a preceding interpolated one it collides with", () => {
        // Four blank lines into a 25px gap: the run thins to 10 and 20, and the
        // real line at 25 then cannot clear the guess at 20. The guess is
        // withdrawn — a real position outranks an interpolated one — so the
        // measured line paints where it actually is.
        const out = layoutLineNumbers(
            at([1, 0], [2, null], [3, null], [4, null], [5, null], [6, 25], [7, 100]),
            OPTS,
        );
        expect(lines(out)).toEqual([1, 3, 6, 7]);
        expect(out.find((r) => r.line === 6)?.top).toBe(25);
    });

    it("a run too dense for its gap should thin out rather than overlap", () => {
        // Three blank lines into a 12px gap at minGap 10: none of them fit, and
        // the bracketing measured lines both keep their real positions.
        const out = layoutLineNumbers(
            at([1, 0], [2, null], [3, null], [4, null], [5, 12], [6, 60]),
            OPTS,
        );
        expect(lines(out)).toEqual([1, 5, 6]);
        expect(out.map((r) => r.top)).toEqual([0, 12, 60]);
    });

    it("a measured line should still yield to another MEASURED line", () => {
        // Two real positions in the same place: dropping the later one keeps
        // the earlier, which is the one the reader's eye already anchored to.
        const out = layoutLineNumbers(at([1, 0], [2, 4], [3, 8], [4, 40]), OPTS);
        expect(lines(out)).toEqual([1, 4]);
    });

    it("the output should always be strictly ordered and minGap-separated", () => {
        const messy = at(
            [1, 0], [2, null], [3, 5], [4, null], [5, null], [6, 9],
            [7, 200], [8, null], [9, 202], [10, 400],
        );
        const out = layoutLineNumbers(messy, OPTS);
        for (let i = 1; i < out.length; i++) {
            expect(out[i].top - out[i - 1].top).toBeGreaterThanOrEqual(OPTS.minGap);
            expect(out[i].line).toBeGreaterThan(out[i - 1].line);
        }
    });
});
