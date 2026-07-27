/**
 * The pure helpers behind the coding-agent bridge's line references
 * (shared/agentContext.ts). Drag direction must never leak into the ordered
 * range or the reference, and a caret must read as a single line.
 */
import { describe, it, expect } from "vitest";
import {
    comparePos,
    orderedRange,
    selectionLineSpan,
    lineRefSuffix,
    type DocSelection,
} from "../agentContext";

const sel = (a: [number, number], b: [number, number], text = ""): DocSelection => ({
    anchor: { line: a[0], column: a[1] },
    active: { line: b[0], column: b[1] },
    text,
});

describe("comparePos", () => {
    it("an earlier line should compare before a later one", () => {
        expect(comparePos({ line: 2, column: 9 }, { line: 3, column: 0 })).toBeLessThan(0);
    });
    it("the same line should break the tie on column", () => {
        expect(comparePos({ line: 4, column: 2 }, { line: 4, column: 5 })).toBeLessThan(0);
        expect(comparePos({ line: 4, column: 5 }, { line: 4, column: 5 })).toBe(0);
    });
});

describe("orderedRange", () => {
    it("a forward selection should keep anchor as start", () => {
        expect(orderedRange(sel([2, 1], [5, 3]))).toEqual({
            start: { line: 2, column: 1 },
            end: { line: 5, column: 3 },
        });
    });
    it("a backward selection (dragged upward) should still return start ≤ end", () => {
        expect(orderedRange(sel([5, 3], [2, 1]))).toEqual({
            start: { line: 2, column: 1 },
            end: { line: 5, column: 3 },
        });
    });
});

describe("selectionLineSpan", () => {
    it("a caret should span a single line", () => {
        expect(selectionLineSpan(sel([7, 4], [7, 4]))).toEqual({ startLine: 7, endLine: 7 });
    });
    it("a backward multi-line selection should report ordered start/end lines", () => {
        expect(selectionLineSpan(sel([12, 3], [8, 2]))).toEqual({ startLine: 8, endLine: 12 });
    });
    it("a selection ending at column 0 should not claim that line", () => {
        // Nothing of line 12 is selected — the span ends on line 11, the
        // editor/GitHub convention.
        expect(selectionLineSpan(sel([8, 2], [12, 0]))).toEqual({ startLine: 8, endLine: 11 });
    });
    it("a single-line selection ending at column 0 should keep its line", () => {
        expect(selectionLineSpan(sel([8, 0], [8, 0]))).toEqual({ startLine: 8, endLine: 8 });
    });
});

describe("lineRefSuffix", () => {
    it("a single line should render as #L<n>", () => {
        expect(lineRefSuffix(12, 12)).toBe("#L12");
    });
    it("a range should render as #L<start>-L<end>", () => {
        expect(lineRefSuffix(12, 20)).toBe("#L12-L20");
    });
});
