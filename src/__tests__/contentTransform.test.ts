import { describe, it, expect } from "vitest";
import {
    extractFrontmatter,
    restoreContentForSave,
} from "../../src/utils/contentTransform";
import { computeLineMap } from "../../src/utils/lineMap";

// ─────────────────────────────────────────────────────────────
// extractFrontmatter
// ─────────────────────────────────────────────────────────────
describe("extractFrontmatter", () => {
    it("standard frontmatter is separated correctly", () => {
        const content = "---\ntitle: Test\ndate: 2024-01-01\n---\n# Hello";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("---\ntitle: Test\ndate: 2024-01-01\n---\n");
        expect(body).toBe("# Hello");
    });

    it("returns the body unchanged and an empty frontmatter string when there is no frontmatter", () => {
        const content = "# Just a heading\n\nSome text.";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("");
        expect(body).toBe(content);
    });

    it("an empty file returns empty frontmatter and empty body", () => {
        const { frontmatter, body } = extractFrontmatter("");
        expect(frontmatter).toBe("");
        expect(body).toBe("");
    });

    it("frontmatter containing only delimiters (no key-value pairs) is not recognized (the regex requires at least one line of content)", () => {
        // The implementation's regex /^---\r?\n[\s\S]*?\r?\n---\r?\n?/ requires at least one newline between the two ---
        // A bare ---\n---\n does not satisfy the condition and is returned as body
        const content = "---\n---\n# Body";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("");
        expect(body).toBe(content);
    });

    it("deeply nested YAML is separated correctly", () => {
        const content = "---\nauthor:\n  name: Alice\n  email: a@b.com\ntags:\n  - md\n---\n# Doc";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(body).toBe("# Doc");
        expect(frontmatter).toContain("author:");
    });

    it("frontmatter with Windows CRLF line endings is recognized correctly", () => {
        const content = "---\r\ntitle: Test\r\n---\r\n# Body";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).not.toBe("");
        expect(body).toBe("# Body");
    });

    it("frontmatter with a blank line in the middle is matched correctly (shortest greedy match)", () => {
        // The first closing --- marks the end of the frontmatter
        const content = "---\ntitle: A\n---\n# H1\n---\nNot frontmatter\n---\n";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("---\ntitle: A\n---\n");
        expect(body).toContain("# H1");
    });

    it("frontmatter not at the start of the file is not recognized", () => {
        const content = "Some text\n---\ntitle: Test\n---\n";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("");
        expect(body).toBe(content);
    });
});

// ─────────────────────────────────────────────────────────────
// restoreContentForSave
// ─────────────────────────────────────────────────────────────
describe("restoreContentForSave", () => {
    it("replaces webviewUri with the relative path", () => {
        const uriMap = new Map([["vscode-resource://host/project/images/photo.png", "./images/photo.png"]]);
        const content = "![alt](vscode-resource://host/project/images/photo.png)";
        const result = restoreContentForSave(content, "", uriMap);
        expect(result).toBe("![alt](./images/photo.png)");
    });

    it("prepends the frontmatter before the body when it is non-empty", () => {
        const frontmatter = "---\ntitle: A\n---\n";
        const result = restoreContentForSave("# Body", frontmatter, new Map());
        expect(result).toBe("---\ntitle: A\n---\n# Body");
    });

    it("replaces all webviewUri occurrences", () => {
        const uriMap = new Map([
            ["vscode-resource://host/img1.png", "./img1.png"],
            ["vscode-resource://host/img2.jpg", "./img2.jpg"],
        ]);
        const content = "![a](vscode-resource://host/img1.png) ![b](vscode-resource://host/img2.jpg)";
        const result = restoreContentForSave(content, "", uriMap);
        expect(result).toBe("![a](./img1.png) ![b](./img2.jpg)");
    });

    it("returns the content unchanged when uriMap is empty", () => {
        const content = "# Hello";
        const result = restoreContentForSave(content, "", new Map());
        expect(result).toBe(content);
    });

    it("leaves unregistered URIs unchanged (to prevent data loss)", () => {
        const uriMap = new Map([["vscode-resource://known.png", "./known.png"]]);
        const content = "![a](vscode-resource://unknown.png)";
        const result = restoreContentForSave(content, "", uriMap);
        expect(result).toContain("vscode-resource://unknown.png");
    });

    it("replaces every occurrence when the same webviewUri appears multiple times", () => {
        const uriMap = new Map([["vscode-resource://img.png", "./img.png"]]);
        const content = "![1](vscode-resource://img.png) ![2](vscode-resource://img.png)";
        const result = restoreContentForSave(content, "", uriMap);
        expect(result).toBe("![1](./img.png) ![2](./img.png)");
    });
});

// ─────────────────────────────────────────────────────────────
// computeLineMap
// ─────────────────────────────────────────────────────────────
describe("computeLineMap", () => {
    it("empty content returns an empty array", () => {
        expect(computeLineMap("")).toEqual([]);
    });

    it("content with only blank lines returns an empty array", () => {
        expect(computeLineMap("\n\n\n")).toEqual([]);
    });

    it("single-line content returns [1]", () => {
        expect(computeLineMap("# Hello")).toEqual([1]);
    });

    it("two paragraphs (separated by a blank line) return the starting line number of each", () => {
        const content = "# Heading\n\nSome paragraph text.";
        const lineMap = computeLineMap(content);
        expect(lineMap).toEqual([1, 3]);
    });

    it("a code block is treated as a single paragraph", () => {
        const content = "# H\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\n## H2";
        const lineMap = computeLineMap(content);
        // Expected: line 1 (heading), line 3 (code block), line 8 (H2)
        expect(lineMap[0]).toBe(1);
        expect(lineMap[1]).toBe(3);
        expect(lineMap[2]).toBe(8);
    });

    it("a tilde code block (~~~) is handled correctly as well", () => {
        const content = "~~~python\nprint('hello')\n~~~\n\n# After";
        const lineMap = computeLineMap(content);
        expect(lineMap.length).toBe(2);
    });

    it("line numbers start at 1 (1-indexed)", () => {
        const content = "paragraph1\n\nparagraph2";
        const lineMap = computeLineMap(content);
        expect(lineMap[0]).toBe(1);
    });

    it("leading blank lines are not counted in the line number", () => {
        const content = "\n\n# Heading";
        const lineMap = computeLineMap(content);
        expect(lineMap).toEqual([3]);
    });

    it("a large file (1000 lines) computes in under 100ms", () => {
        const content = Array.from({ length: 200 }, (_, i) => `## Heading ${i}\n\nContent ${i}`).join("\n\n");
        const start = performance.now();
        computeLineMap(content);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(100);
    });
});
