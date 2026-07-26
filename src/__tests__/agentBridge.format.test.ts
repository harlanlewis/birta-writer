/**
 * The pure projections the agent-bridge adapters share (src/agentBridge/format.ts):
 * the @-mention reference, the 0-indexed VS Code range, the paste block, and the
 * model-facing description. All independent of `vscode` — the caller passes the
 * already-resolved workspace-relative path in.
 */
import { describe, it, expect } from "vitest";
import {
    buildReference,
    toBirtaSelection,
    buildContextBlock,
    describeForModel,
} from "../agentBridge/format";
import type { EditorSelectionContext } from "../../shared/agentContext";

const caret = (line: number, column: number): EditorSelectionContext => ({
    selections: [{ anchor: { line, column }, active: { line, column }, text: "" }],
    primary: 0,
    isEmpty: true,
});

const range = (
    a: [number, number],
    b: [number, number],
    text: string,
): EditorSelectionContext => ({
    selections: [{ anchor: { line: a[0], column: a[1] }, active: { line: b[0], column: b[1] }, text }],
    primary: 0,
    isEmpty: false,
});

describe("buildReference", () => {
    it("a caret should reference a single line", () => {
        expect(buildReference("docs/note.md", caret(10, 4))).toBe("docs/note.md#L10");
    });
    it("a multi-line selection should reference the ordered line range", () => {
        expect(buildReference("docs/note.md", range([12, 0], [20, 6], "x"))).toBe(
            "docs/note.md#L12-L20",
        );
    });
    it("a backward selection should still produce an ascending range", () => {
        expect(buildReference("a.md", range([20, 6], [12, 0], "x"))).toBe("a.md#L12-L20");
    });
});

describe("toBirtaSelection", () => {
    it("should convert 1-indexed document lines to 0-indexed VS Code positions", () => {
        expect(toBirtaSelection(range([12, 2], [20, 6], "x"))).toEqual({
            start: { line: 11, character: 2 },
            end: { line: 19, character: 6 },
        });
    });
    it("a caret should produce a zero-width, ordered range", () => {
        expect(toBirtaSelection(caret(1, 0))).toEqual({
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        });
    });
});

describe("buildContextBlock", () => {
    it("a caret should copy the reference alone", () => {
        expect(buildContextBlock("a.md", caret(3, 0))).toBe("a.md#L3");
    });
    it("a selection should copy the reference followed by the selected text", () => {
        expect(buildContextBlock("a.md", range([3, 0], [4, 5], "hello\nworld"))).toBe(
            "a.md#L3-L4\n\nhello\nworld",
        );
    });
});

describe("describeForModel", () => {
    it("a selection should name the file, the line range, and the selected text", () => {
        const out = describeForModel("docs/note.md", range([12, 0], [14, 3], "picked text"));
        expect(out).toContain("File: docs/note.md");
        expect(out).toContain("lines 12–14 selected");
        expect(out).toContain("reference: docs/note.md#L12-L14");
        expect(out).toContain("picked text");
    });
    it("a caret should describe the caret line and omit selected text", () => {
        const out = describeForModel("a.md", caret(9, 0));
        expect(out).toContain("caret at line 9");
        expect(out).not.toContain("Selected text:");
    });
    it("a very long selection should be truncated with a marker", () => {
        const long = "z".repeat(25_000);
        const out = describeForModel("a.md", range([1, 0], [1, 0], long));
        expect(out).toContain("truncated 5000 more characters");
        expect(out.length).toBeLessThan(long.length + 500);
    });
});
