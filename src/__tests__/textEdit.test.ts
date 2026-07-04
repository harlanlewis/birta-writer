/**
 * computeReplaceRange: the pure diff behind webview → TextDocument syncing.
 * Every case additionally asserts the algebraic invariant: applying the
 * returned replacement to oldText must reproduce newText exactly.
 */
import { describe, it, expect } from "vitest";
import { computeReplaceRange, type ReplaceRange } from "../utils/textEdit";

/** Applies the computed replacement to oldText (the WorkspaceEdit semantics). */
function apply(oldText: string, edit: ReplaceRange): string {
    return (
        oldText.slice(0, edit.startOffset) +
        edit.replacement +
        oldText.slice(edit.endOffset)
    );
}

/** Computes, asserts round-trip correctness, and returns the edit. */
function compute(oldText: string, newText: string): ReplaceRange {
    const edit = computeReplaceRange(oldText, newText);
    expect(edit).not.toBeNull();
    expect(apply(oldText, edit!)).toBe(newText);
    return edit!;
}

describe("computeReplaceRange", () => {
    describe("basic diffs", () => {
        it("identical texts should return null", () => {
            expect(computeReplaceRange("hello\nworld\n", "hello\nworld\n")).toBeNull();
        });

        it("a change in the middle should trim both the common prefix and suffix", () => {
            const edit = compute("# Title\n\nold paragraph\n\nfooter\n", "# Title\n\nnew paragraph\n\nfooter\n");

            expect(edit.startOffset).toBe(9);
            expect(edit.endOffset).toBe(12);
            expect(edit.replacement).toBe("new");
        });

        it("an insert-only change should produce an empty range with a non-empty replacement", () => {
            const edit = compute("abc", "abXYc");

            expect(edit.startOffset).toBe(edit.endOffset);
            expect(edit.replacement).toBe("XY");
        });

        it("a delete-only change should produce a non-empty range with an empty replacement", () => {
            const edit = compute("line one\nline two\nline three\n", "line one\nline three\n");

            expect(edit.replacement.length).toBeLessThan(edit.endOffset - edit.startOffset);
            expect(apply("line one\nline two\nline three\n", edit)).toBe("line one\nline three\n");
        });

        it("a change at the very start should have startOffset 0", () => {
            const edit = compute("old start rest", "new start rest");

            expect(edit.startOffset).toBe(0);
        });

        it("a change at the very end should have endOffset at the old length", () => {
            const edit = compute("rest old end", "rest new end!");

            expect(edit.endOffset).toBe("rest old end".length);
        });

        it("a full replacement with nothing in common should span the whole text", () => {
            const edit = compute("abc", "xyz");

            expect(edit.startOffset).toBe(0);
            expect(edit.endOffset).toBe(3);
            expect(edit.replacement).toBe("xyz");
        });

        it("empty old text should produce a pure insertion", () => {
            const edit = compute("", "content\n");

            expect(edit).toEqual({ startOffset: 0, endOffset: 0, replacement: "content\n" });
        });
    });

    describe("boundary safety", () => {
        it("a CRLF file edit should never place an offset between \\r and \\n", () => {
            // The naive prefix stops between "\r" and "\n" (both share "...a\r"),
            // and the naive suffix starts at "\n..." — both must be pushed out.
            const oldText = "line a\r\nline b\r\n";
            const newText = "line a\r\nline B\r\n";

            const edit = compute(oldText, newText);

            expect(oldText.slice(edit.startOffset - 1, edit.startOffset + 1)).not.toBe("\r\n");
            expect(oldText.slice(edit.endOffset - 1, edit.endOffset + 1)).not.toBe("\r\n");
        });

        it("replacing a whole CRLF line with a shorter one should still round-trip", () => {
            const oldText = "aaa\r\nbbbbb\r\nccc\r\n";
            const newText = "aaa\r\nzz\r\nccc\r\n";

            compute(oldText, newText); // round-trip asserted inside
        });

        it("an inserted CR before an existing CRLF should back the range out of the pair", () => {
            // The naive common prefix is "x\r" — stopping between the \r and
            // \n of the old text's CRLF; the guard must widen the range.
            const oldText = "x\r\ny";
            const newText = "x\r\r\ny";

            const edit = compute(oldText, newText);

            expect(oldText.slice(edit.startOffset - 1, edit.startOffset + 1)).not.toBe("\r\n");
            expect(oldText.slice(edit.endOffset - 1, edit.endOffset + 1)).not.toBe("\r\n");
        });

        it("replacing one emoji with another should not split the surrogate pair", () => {
            // Both emoji share the same high surrogate, so the naive prefix
            // stops in the middle of the pair; the guard must back up.
            const oldText = "\u{1F600}a"; // grinning face
            const newText = "\u{1F601}a"; // beaming face

            const edit = compute(oldText, newText);

            expect(edit.startOffset).toBe(0);
            const before = oldText.charCodeAt(edit.startOffset - 1);
            expect(before >= 0xd800 && before <= 0xdbff).toBe(false);
        });

        it("pure newline-style conversion from LF to CRLF should round-trip", () => {
            compute("one\ntwo\nthree\n", "one\r\ntwo\r\nthree\r\n");
        });
    });
});
