import { describe, it, expect } from "vitest";
import {
    documentLineCount,
    findHeadingLine,
    parseAtTarget,
    renderedHeadingText,
    resolveAtTarget,
} from "../headingTarget";

describe("parseAtTarget", () => {
    it("a bare number or an L-prefixed one should be a line", () => {
        expect(parseAtTarget("42")).toEqual({ kind: "line", line: 42 });
        expect(parseAtTarget("L42")).toEqual({ kind: "line", line: 42 });
        expect(parseAtTarget("l7")).toEqual({ kind: "line", line: 7 });
    });

    it("line 0 and an empty name should name nothing", () => {
        expect(parseAtTarget("0")).toBeNull();
        expect(parseAtTarget("L0")).toBeNull();
        expect(parseAtTarget("")).toBeNull();
        expect(parseAtTarget("#")).toBeNull();
        expect(parseAtTarget("  ")).toBeNull();
    });

    it("anything else should be a heading, with one leading hash dropped", () => {
        expect(parseAtTarget("Getting Started")).toEqual({ kind: "heading", fragment: "Getting Started" });
        expect(parseAtTarget("#getting-started")).toEqual({ kind: "heading", fragment: "getting-started" });
        expect(parseAtTarget("#42")).toEqual({ kind: "heading", fragment: "42" });
        expect(parseAtTarget("L42a")).toEqual({ kind: "heading", fragment: "L42a" });
    });
});

describe("findHeadingLine", () => {
    const doc = [
        "---",
        "title: x",
        "---",
        "# Getting Started",
        "",
        "## Foo",
        "",
        "## Foo",
        "",
        "## The `code` [link](https://x.test) part",
        "",
        "```",
        "# not a heading",
        "```",
        "",
        "Setext",
        "------",
        "",
        "## 🚀",
        "",
        "## 42",
    ].join("\n");

    it("heading text in any case should land on its line", () => {
        expect(findHeadingLine(doc, "Getting Started")).toBe(4);
        expect(findHeadingLine(doc, "getting started")).toBe(4);
        expect(findHeadingLine(doc, "GETTING STARTED")).toBe(4);
    });

    it("a slug should land on its heading, and a suffixed one on the duplicate", () => {
        expect(findHeadingLine(doc, "getting-started")).toBe(4);
        expect(findHeadingLine(doc, "foo")).toBe(6);
        expect(findHeadingLine(doc, "foo-1")).toBe(8);
    });

    it("a heading's rendered text should name it, not its source", () => {
        expect(findHeadingLine(doc, "the-code-link-part")).toBe(10);
        expect(findHeadingLine(doc, "The code link part")).toBe(10);
    });

    it("a fenced line and frontmatter should never be headings", () => {
        expect(findHeadingLine(doc, "not a heading")).toBeUndefined();
        expect(findHeadingLine(doc, "title: x")).toBeUndefined();
    });

    it("a setext heading should land on its text line", () => {
        expect(findHeadingLine(doc, "setext")).toBe(16);
    });

    it("a heading with no slug, or a name nothing matches, should be undefined", () => {
        expect(findHeadingLine(doc, "🚀")).toBeUndefined();
        expect(findHeadingLine(doc, "nowhere")).toBeUndefined();
    });

    it("a percent-encoded fragment should be decoded, and a malformed one kept raw", () => {
        expect(findHeadingLine(doc, "Getting%20Started")).toBe(4);
        expect(findHeadingLine("# 100%\n", "100%")).toBe(1);
    });
});

describe("resolveAtTarget", () => {
    it("a heading target should resolve through findHeadingLine", () => {
        expect(resolveAtTarget("a\n# B\n", { kind: "heading", fragment: "b" })).toBe(2);
    });

    it("a line inside the document should resolve to itself, and one past its end to undefined", () => {
        expect(resolveAtTarget("a\nb\nc\n", { kind: "line", line: 3 })).toBe(3);
        expect(resolveAtTarget("a\nb\nc\n", { kind: "line", line: 4 })).toBeUndefined();
        expect(resolveAtTarget("a\nb\nc", { kind: "line", line: 3 })).toBe(3);
    });
});

describe("documentLineCount", () => {
    it("a final newline should end the last line rather than start one", () => {
        expect(documentLineCount("")).toBe(1);
        expect(documentLineCount("a")).toBe(1);
        expect(documentLineCount("a\n")).toBe(1);
        expect(documentLineCount("a\nb")).toBe(2);
        expect(documentLineCount("a\n\n")).toBe(2);
    });
});

describe("renderedHeadingText", () => {
    it("links, images and code should keep only what renders", () => {
        expect(renderedHeadingText("![alt](i.png) and [t](u) and `c`")).toBe("alt and t and c");
    });
});
