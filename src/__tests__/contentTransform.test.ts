import { describe, it, expect } from "vitest";
import {
    extractFrontmatter,
    restoreContentForSave,
} from "../../src/utils/contentTransform";

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

    it("an inner line starting with --- (e.g. `--- draft`) should not terminate the block", () => {
        // Before the fix the extraction regex stopped at any line merely
        // STARTING with ---, truncating the document at `--- draft`.
        const content = "---\ntitle: A\n--- draft\nmore: x\n---\n# Body";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("---\ntitle: A\n--- draft\nmore: x\n---\n");
        expect(body).toBe("# Body");
    });

    it("an inner line of ---- should not terminate the block", () => {
        const content = "---\ntitle: A\n----\nmore: x\n---\n# Body";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("---\ntitle: A\n----\nmore: x\n---\n");
        expect(body).toBe("# Body");
    });

    it("frontmatter with inner ----prefixed lines round-trips through restoreContentForSave", () => {
        const content = "---\ntitle: A\n--- draft\n----\n---\n# Body\n";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(restoreContentForSave(body, frontmatter, new Map())).toBe(content);
    });

    it("a ----prefixed line with no real closing fence yields no frontmatter", () => {
        const content = "---\ntitle: A\n--- draft\n# Body";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("");
        expect(body).toBe(content);
    });

    it("a closing fence at end of file without a trailing newline is recognized", () => {
        const content = "---\ntitle: A\n---";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("---\ntitle: A\n---");
        expect(body).toBe("");
    });

    it("CRLF frontmatter with an inner ----prefixed line finds the real closing fence", () => {
        const content = "---\r\ntitle: A\r\n--- draft\r\n---\r\n# Body";
        const { frontmatter, body } = extractFrontmatter(content);
        expect(frontmatter).toBe("---\r\ntitle: A\r\n--- draft\r\n---\r\n");
        expect(body).toBe("# Body");
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

// computeLineMap is owned and tested by src/__tests__/lineMap.test.ts (basic
// blocks, code fences, CRLF, blank-line handling, ≥90% coverage floor). It was
// previously duplicated here with weaker cases plus a wall-clock perf assertion;
// perf belongs in the e2e/perf harness (pnpm perf), not a unit test.
