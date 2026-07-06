import { describe, it, expect } from "vitest";
import { scanHeadings } from "../utils/headingScan";

describe("scanHeadings", () => {
    describe("ATX headings", () => {
        it("levels 1 through 6 should each be captured with the right level", () => {
            // Arrange
            const text = [
                "# H1",
                "## H2",
                "### H3",
                "#### H4",
                "##### H5",
                "###### H6",
            ].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([
                { level: 1, text: "H1", line: 1 },
                { level: 2, text: "H2", line: 2 },
                { level: 3, text: "H3", line: 3 },
                { level: 4, text: "H4", line: 4 },
                { level: 5, text: "H5", line: 5 },
                { level: 6, text: "H6", line: 6 },
            ]);
        });

        it("seven hashes should not be a heading (max level is 6)", () => {
            // Arrange
            const text = "####### Not a heading";

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([]);
        });

        it("a hash with no following space should not be a heading", () => {
            // Arrange
            const text = "#NoSpace";

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([]);
        });

        it("up to three leading spaces should still parse as a heading", () => {
            // Arrange
            const text = "   ### Indented";

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 3, text: "Indented", line: 1 }]);
        });

        it("trailing hash closers should be stripped from the text", () => {
            // Arrange
            const text = ["## Closed heading ##", "# Solo #", "### Padded   ###   "].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([
                { level: 2, text: "Closed heading", line: 1 },
                { level: 1, text: "Solo", line: 2 },
                { level: 3, text: "Padded", line: 3 },
            ]);
        });

        it("an empty ATX heading should yield empty text", () => {
            // Arrange
            const text = "##";

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 2, text: "", line: 1 }]);
        });
    });

    describe("setext headings", () => {
        it("an equals underline should be H1 and a dash underline H2", () => {
            // Arrange
            const text = ["Title One", "=====", "", "Title Two", "-----"].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([
                { level: 1, text: "Title One", line: 1 },
                { level: 2, text: "Title Two", line: 4 },
            ]);
        });

        it("a dash line with no text above should be a thematic break, not a heading", () => {
            // Arrange
            const text = ["", "-----", ""].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([]);
        });
    });

    describe("fenced code blocks", () => {
        it("headings inside a backtick fence should be ignored", () => {
            // Arrange
            const text = [
                "# Real",
                "```",
                "# Fake heading in code",
                "## Also fake",
                "```",
                "## After",
            ].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([
                { level: 1, text: "Real", line: 1 },
                { level: 2, text: "After", line: 6 },
            ]);
        });

        it("headings inside a tilde fence should be ignored", () => {
            // Arrange
            const text = ["~~~", "# Fake", "~~~", "# Real"].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 1, text: "Real", line: 4 }]);
        });

        it("a hash in a fence info line should not be treated as a heading", () => {
            // Arrange
            const text = ["```#notlanguage", "some code", "```", "# Real"].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 1, text: "Real", line: 4 }]);
        });

        it("a setext-looking underline inside a fence should be ignored", () => {
            // Arrange
            const text = ["```", "Not a title", "=====", "```"].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([]);
        });
    });

    describe("frontmatter", () => {
        it("a leading YAML frontmatter block should be skipped", () => {
            // Arrange
            const text = [
                "---",
                "title: My Doc",
                "tags: [a, b]",
                "---",
                "# Real heading",
            ].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 1, text: "Real heading", line: 5 }]);
        });

        it("frontmatter closed with dots should also be skipped", () => {
            // Arrange
            const text = ["---", "title: X", "...", "## Body"].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 2, text: "Body", line: 4 }]);
        });

        it("an unclosed frontmatter opener should not swallow the rest of the file", () => {
            // Arrange — no closing delimiter, so `---` is a plain thematic break.
            const text = ["---", "# Still a heading"].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 1, text: "Still a heading", line: 2 }]);
        });
    });

    describe("line endings", () => {
        it("CRLF line endings should be handled and stripped from text", () => {
            // Arrange
            const text = "# First\r\n\r\ntext\r\n## Second\r\n";

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([
                { level: 1, text: "First", line: 1 },
                { level: 2, text: "Second", line: 4 },
            ]);
        });

        it("a CRLF setext underline should be recognized", () => {
            // Arrange
            const text = "Title\r\n=====\r\n";

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([{ level: 1, text: "Title", line: 1 }]);
        });
    });

    describe("edge cases", () => {
        it("empty input should return no headings", () => {
            // Arrange / Act / Assert
            expect(scanHeadings("")).toEqual([]);
        });

        it("a document with no headings should return an empty array", () => {
            // Arrange
            const text = ["Just a paragraph.", "", "Another one."].join("\n");

            // Act
            const result = scanHeadings(text);

            // Assert
            expect(result).toEqual([]);
        });
    });
});
