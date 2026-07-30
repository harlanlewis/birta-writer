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

const OPTS = { minGap: 10, lineHeight: 20, numberHeight: 10 };

/**
 * `[line, top]` or `[line, top, bottom]` triples, for readable fixtures.
 *
 * A fixture that gives no bottom is asserting the fallback: a measured line
 * whose rendered extent was never measured is assumed one content line tall.
 */
const at = (...pairs: Array<[number, number | null] | [number, number, number]>): MeasuredLine[] =>
    pairs.map(([line, top, bottom]) => ({ line, top, bottom: bottom ?? null }));

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
    it("a blank line should land in the gap AFTER its predecessor's content", () => {
        // Line 1 renders from 0 to 20; the blank belongs in [20, 60], centred.
        const out = layoutLineNumbers(at([1, 0, 20], [2, null], [3, 60]), OPTS);
        expect(out).toEqual([{ line: 1, top: 0 }, { line: 2, top: 35 }, { line: 3, top: 60 }]);
    });

    it("a blank line after a TALL source line should clear it, not sit inside it", () => {
        // The bug this rule exists for. One source line — an unwrapped
        // paragraph, a heading that wraps, a video embed — renders 200px tall.
        // Dividing from its TOP put the blank separator's number a third of
        // the way down the block it was supposed to follow.
        const out = layoutLineNumbers(at([1, 0, 200], [2, null], [3, 240]), OPTS);
        expect(out[1]).toEqual({ line: 2, top: 215 });
        expect(out[1].top).toBeGreaterThan(200);
    });

    it("a RUN of blank lines should divide the gap after the content evenly", () => {
        const out = layoutLineNumbers(
            at([1, 0, 20], [2, null], [3, null], [4, null], [5, 80]),
            OPTS,
        );
        expect(out).toEqual([
            { line: 1, top: 0 },
            { line: 2, top: 25 },
            { line: 3, top: 45 },
            { line: 4, top: 65 },
            { line: 5, top: 80 },
        ]);
    });

    it("a gap narrower than a gutter line should pack the blank against the line below", () => {
        // Two paragraphs separated by a margin of 6px. There is no room to
        // divide, and dropping the number would punch a hole in the sequence a
        // reader counts by, so it sits one gutter line above the block it
        // precedes — which is where the raw editor draws it too.
        const out = layoutLineNumbers(at([1, 0, 20], [2, null], [3, 26]), OPTS);
        expect(out).toEqual([{ line: 1, top: 0 }, { line: 2, top: 16 }, { line: 3, top: 26 }]);
    });

    it("a measured line with no bottom should be assumed one content line tall", () => {
        // The caller measures a bottom only where a run of blanks follows; a
        // fixture without one asserts the fallback rather than a special case.
        const out = layoutLineNumbers(at([1, 0], [2, null], [3, 60]), OPTS);
        expect(out).toEqual([{ line: 1, top: 0 }, { line: 2, top: 35 }, { line: 3, top: 60 }]);
    });

    it("a trailing run with nothing below should step down by a line each", () => {
        // Blank lines at the end of the document: there is no `after` to divide
        // toward, so the ambient line height is the only honest spacing.
        const out = layoutLineNumbers(at([1, 100, 120], [2, null], [3, null]), OPTS);
        expect(out).toEqual([
            { line: 1, top: 100 },
            { line: 2, top: 125 },
            { line: 3, top: 145 },
        ]);
    });

    it("a leading run with nothing above should step UP to reach the first measured line", () => {
        const out = layoutLineNumbers(at([1, null], [2, null], [3, 100]), OPTS);
        expect(out).toEqual([
            { line: 1, top: 65 },
            { line: 2, top: 85 },
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

    it("a packed run that overruns should lose its FAR end, not its near one", () => {
        // Four blank lines into the 5px gap between the content's bottom (20)
        // and the next real line (25). Packed against line 6 they reach back
        // above line 1's number, and the ones that cannot clear it are dropped
        // — from the top of the run, so the survivor is the one adjacent to the
        // block it precedes rather than the one adrift in the paragraph above.
        const out = layoutLineNumbers(
            at([1, 0, 20], [2, null], [3, null], [4, null], [5, null], [6, 25], [7, 100]),
            OPTS,
        );
        expect(lines(out)).toEqual([1, 5, 6, 7]);
        expect(out.find((r) => r.line === 6)?.top).toBe(25);
    });

    it("a measured line should EVICT a preceding interpolated one it collides with", () => {
        // A content line height BELOW the gutter's own (a very small document
        // font): the leading run steps up in content lines, which is closer
        // than the gutter can paint, so the real line at 100 cannot clear the
        // guess. The guess is withdrawn — a real position outranks an
        // interpolated one — and the measured line paints where it actually is.
        const out = layoutLineNumbers(at([1, null], [2, 100]), { ...OPTS, lineHeight: 8 });
        expect(out).toEqual([{ line: 2, top: 100 }]);
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
