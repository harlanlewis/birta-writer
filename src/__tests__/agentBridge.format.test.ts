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
    it("a selection should quote the selected text in a markdown fence", () => {
        expect(buildContextBlock("a.md", range([3, 0], [4, 5], "hello\nworld"))).toBe(
            "a.md#L3-L4\n\n```markdown\nhello\nworld\n```",
        );
    });
    it("with the document text, the quoted content should be the selection's real source fragment", () => {
        const doc = "# Title\n\n## Section\n\n- item *one*\n- item [two](x.md)\n";
        // Full-line start, mid-line end: the last line is trimmed to the
        // selection's end column — the user pointed at that fragment.
        expect(buildContextBlock("a.md", range([5, 0], [6, 10], "item one\nitem two"), doc)).toBe(
            "a.md#L5-L6\n\n```markdown\n- item *one*\n- item [tw\n```",
        );
    });
    it("a mid-line selection should quote exactly the selected source characters", () => {
        const doc = "The quick brown fox jumps over the lazy dog.\n";
        expect(buildContextBlock("a.md", range([1, 4], [1, 15], "quick brown"), doc)).toBe(
            "a.md#L1\n\n```markdown\nquick brown\n```",
        );
    });
    it("a selection ending at column 0 should quote nothing of that line and drop it from the reference", () => {
        const doc = "alpha\nbeta\ngamma\n";
        expect(buildContextBlock("a.md", range([1, 0], [3, 0], "alpha\nbeta"), doc)).toBe(
            "a.md#L1-L2\n\n```markdown\nalpha\nbeta\n```",
        );
    });
    it("content containing a backtick fence should get a longer outer fence", () => {
        const doc = "text\n```js\ncode\n```\nmore\n";
        const out = buildContextBlock("a.md", range([1, 0], [5, 4], "x"), doc);
        expect(out).toContain("````markdown\n");
        expect(out.endsWith("\n````")).toBe(true);
        expect(out).toContain("```js\ncode\n```");
    });
    it("stale coordinates past the document's end should fall back to the selection's plain text", () => {
        expect(buildContextBlock("a.md", range([90, 0], [91, 2], "plain"), "one\ntwo\n")).toBe(
            "a.md#L90-L91\n\n```markdown\nplain\n```",
        );
    });
});

describe("describeForModel", () => {
    it("a selection should name the file, the line range, and quote the selected text", () => {
        const out = describeForModel("docs/note.md", range([12, 0], [14, 3], "picked text"));
        expect(out).toContain("File: docs/note.md");
        expect(out).toContain("lines 12–14 selected");
        expect(out).toContain("reference: docs/note.md#L12-L14");
        expect(out).toContain("```markdown\npicked text\n```");
    });
    it("with the document text, the model should see the selection's real source fragment", () => {
        const doc = "# T\n\n- a [link](y.md)\n";
        const line = "- a [link](y.md)";
        const out = describeForModel("a.md", range([3, 0], [3, line.length], "a link"), doc);
        expect(out).toContain(line);
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
