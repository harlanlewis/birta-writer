/**
 * Tests for the minimal-diff merge (applyMinimalChanges) — pure functions on
 * real strings, no mocks.
 *
 * The regression at stake: hitting Enter creates a new paragraph, the
 * serializer emits it with a blank-line separator, and the merge used to drop
 * that blank line — leaving a single newline that Markdown treats as a soft
 * break (formatters then collapse the "paragraphs" into one line).
 */
import { describe, it, expect } from "vitest";
import { applyMinimalChanges } from "../utils/minimalDiff";

describe("applyMinimalChanges — paragraph separators (the Enter bug)", () => {
    it("appending a new paragraph should insert its blank separator", () => {
        const saved = "para1\n";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n");
    });

    it("inserting a paragraph between two paragraphs should keep all three blank-separated", () => {
        const saved = "para1\n\npara3\n";
        const serialized = "para1\n\npara2\n\npara3\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n\npara3\n");
    });

    it("splitting a paragraph in two should yield two blank-separated paragraphs", () => {
        // Enter pressed in the middle of "first second"
        const saved = "intro\n\nfirst second\n";
        const serialized = "intro\n\nfirst\n\nsecond\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("intro\n\nfirst\n\nsecond\n");
    });

    it("inserting a paragraph at the head of the file should keep it separated from the old first paragraph", () => {
        const saved = "para2\n";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n");
    });
});

describe("applyMinimalChanges — deletions take their separator with them", () => {
    it("deleting a middle paragraph should remove its blank separator too", () => {
        const saved = "para1\n\npara2\n\npara3\n";
        const serialized = "para1\n\npara3\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara3\n");
    });

    it("deleting the first paragraph should not leave a leading blank line", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "para2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para2\n");
    });

    it("deleting the last paragraph should not leave trailing blank lines", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "para1\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n");
    });

    it("merging two paragraphs (backspace at paragraph start) should collapse their separator", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "para1para2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1para2\n");
    });

    it("deleting all content should return the serialized output", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "";

        expect(applyMinimalChanges(saved, serialized)).toBe("");
    });

    it("repeated insert/delete cycles should not accumulate blank lines", () => {
        // Arrange: a stable two-paragraph file
        const original = "para1\n\npara3\n";
        const withInsert = "para1\n\npara2\n\npara3\n";

        // Act: insert para2 then delete it again, three times over
        let file = original;
        for (let cycle = 0; cycle < 3; cycle++) {
            file = applyMinimalChanges(file, withInsert);
            file = applyMinimalChanges(file, original);
        }

        // Assert: byte-identical to where we started
        expect(file).toBe(original);
    });
});

describe("applyMinimalChanges — untouched formatting is preserved", () => {
    it("identical content should return the saved string itself (identity)", () => {
        const saved = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, saved)).toBe(saved);
    });

    it("an in-place text edit should preserve the user's double blank lines around it", () => {
        const saved = "para1\n\n\npara2 old\n";
        const serialized = "para1\n\npara2 new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\n\npara2 new\n");
    });

    it("serializer emitting single blanks where the file has doubles should change nothing", () => {
        const saved = "para1\n\n\npara2\n";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("a leading blank line should survive an unrelated edit below", () => {
        const saved = "\npara1\n\npara2 old\n";
        const serialized = "para1\n\npara2 new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("\npara1\n\npara2 new\n");
    });

    it("table separator rows differing only in dash width should compare as unchanged", () => {
        const saved = "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n";
        const serialized = "| a | b |\n|:-|-:|\n| 1 | 2 |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("table cells differing only in padding or <br /> placeholders should compare as unchanged", () => {
        const saved = "| fruit | price |\n| --- | --- |\n| apple |  |\n";
        const serialized = "| fruit | price |\n| --- | --- |\n| apple | <br /> |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("editing one table cell should not reformat the other rows", () => {
        const saved = "| fruit | price |\n| ----- | ----- |\n| apple | 1     |\n| pear  | 2     |\n";
        const serialized = "| fruit | price |\n| --- | --- |\n| apple | 1 |\n| pear | 9 |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| fruit | price |\n| ----- | ----- |\n| apple | 1     |\n| pear | 9 |\n",
        );
    });

    it("adjacent strong runs split by the serializer should compare as unchanged", () => {
        const saved = "**bold [link](https://a.b) text**\n";
        const serialized = "**bold [link](https://a.b)** **text**\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("a fence language with leading space should compare as unchanged", () => {
        const saved = "``` javascript\nconst x = 1;\n```\n";
        const serialized = "```javascript\nconst x = 1;\n```\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("blank lines inside a fenced code block should survive an edit elsewhere", () => {
        const saved = "```\nline1\n\nline2\n```\n\ntext old\n";
        const serialized = "```\nline1\n\nline2\n```\n\ntext new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "```\nline1\n\nline2\n```\n\ntext new\n",
        );
    });
});

describe("applyMinimalChanges — list and boundary behavior", () => {
    it("inserting an item into a tight list should not add blank lines", () => {
        const saved = "- a\n- c\n";
        const serialized = "- a\n- b\n- c\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("- a\n- b\n- c\n");
    });

    it("typing the first paragraph into an empty file should produce just that paragraph", () => {
        const saved = "";
        const serialized = "para1\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n");
    });

    it("appending to a file without a trailing newline should end with the serializer's trailing newline", () => {
        const saved = "para1";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n");
    });

    it("an in-place edit in a file without a trailing newline should keep lacking it", () => {
        const saved = "para1 old";
        const serialized = "para1 new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1 new");
    });
});
