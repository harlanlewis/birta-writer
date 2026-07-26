/**
 * computeLineMap tests: mapping markdown content to block start lines.
 *
 * The map drives editor↔source line sync and the find bar's raw-source
 * fallback, so fences, blank-line handling and CRLF must all be exact.
 */
import { describe, it, expect } from "vitest";
import { computeLineMap, sourceLineCount } from "../utils/lineMap";
import { extractFrontmatter } from "../utils/contentTransform";

describe("computeLineMap basic blocks", () => {
    it("empty content should produce an empty map", () => {
        expect(computeLineMap("")).toEqual([]);
    });

    it("content with only blank lines should produce an empty map", () => {
        expect(computeLineMap("\n\n   \n\t\n")).toEqual([]);
    });

    it("a single paragraph should map to line 1", () => {
        expect(computeLineMap("hello world")).toEqual([1]);
    });

    it("paragraphs separated by blank lines should each start a block", () => {
        expect(computeLineMap("para1\n\npara2\n\npara3")).toEqual([1, 3, 5]);
    });

    it("consecutive non-empty lines should be grouped into one block", () => {
        expect(computeLineMap("# Title\nParagraph right below\n\nNext")).toEqual([1, 4]);
    });

    it("multiple blank lines between blocks should not create extra entries", () => {
        expect(computeLineMap("a\n\n\n\nb")).toEqual([1, 5]);
    });

    it("leading blank lines should offset the first block's start line", () => {
        expect(computeLineMap("\n\npara")).toEqual([3]);
    });

    it("trailing blank lines should not add blocks", () => {
        expect(computeLineMap("para\n\n\n")).toEqual([1]);
    });
});

describe("computeLineMap code fences", () => {
    it("a backtick fence containing blank lines should stay one block", () => {
        const content = "```js\ncode\n\nmore code\n```\nafter";
        expect(computeLineMap(content)).toEqual([1, 6]);
    });

    it("a tilde fence containing blank lines should stay one block", () => {
        const content = "~~~\ncode\n\nmore\n~~~\n\nafter";
        expect(computeLineMap(content)).toEqual([1, 7]);
    });

    it("an unclosed fence should consume the rest of the document", () => {
        expect(computeLineMap("intro\n\n```\ncode\n\nnever closed")).toEqual([1, 3]);
    });

    it("an indented fence should be recognized as a fence", () => {
        expect(computeLineMap("  ```\ncode\n  ```\nafter")).toEqual([1, 4]);
    });

    it("a tilde line inside a backtick fence should not close the fence", () => {
        expect(computeLineMap("```\n~~~\n```\n\nafter")).toEqual([1, 5]);
    });

    it("a fence longer than three characters should require the same fence to close", () => {
        expect(computeLineMap("````\n```\n````\n\nafter")).toEqual([1, 5]);
    });
});

describe("sourceLineCount as the frontmatter offset", () => {
    // The webview renders the BODY, so its line map starts at the body's first
    // block; this count is what turns a body line back into the document line a
    // text editor shows (MAR-23). The invariant asserted here is the one the
    // navigation paths rely on: body line 1 == document line offset + 1.
    const documentLineOf = (content: string, bodyLine: number): number => {
        const { frontmatter } = extractFrontmatter(content);
        return bodyLine + sourceLineCount(frontmatter);
    };

    it("content with no frontmatter should have a zero offset", () => {
        expect(documentLineOf("# Title\n\nbody\n", 1)).toBe(1);
    });

    it("a frontmatter block should push the body down by its own line count", () => {
        const content = "---\ntitle: Note\n---\n\n# Title\n\nbody\n";
        // "# Title" is body line 2 (a blank line follows the closing ---) and
        // document line 5.
        expect(extractFrontmatter(content).body.split("\n")[1]).toBe("# Title");
        expect(documentLineOf(content, 2)).toBe(5);
    });

    it("a frontmatter block that ends the file should still count its lines", () => {
        expect(sourceLineCount("---\ntitle: Note\n---")).toBe(2);
    });

    it("CRLF frontmatter should count the same as LF", () => {
        const lf = "---\ntitle: Note\ntags: []\n---\n";
        expect(sourceLineCount(lf.replace(/\n/g, "\r\n"))).toBe(sourceLineCount(lf));
    });

    it("an empty frontmatter string should count as no lines", () => {
        expect(sourceLineCount("")).toBe(0);
    });
});

describe("computeLineMap line endings", () => {
    it("CRLF content should map identically to LF content", () => {
        const lf = "para1\n\npara2\n\n```\ncode\n```";
        const crlf = lf.replace(/\n/g, "\r\n");
        expect(computeLineMap(crlf)).toEqual(computeLineMap(lf));
        expect(computeLineMap(crlf)).toEqual([1, 3, 5]);
    });
});
