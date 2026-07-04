/**
 * linkTargetSuggestions tests: the pure path math that turns absolute
 * workspace file paths into the two link forms offered by the URL
 * autocompletion (document-relative and workspace-root-relative).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildLinkTargetItems } from "../utils/linkTargetSuggestions";

const ROOT = "/ws";
const DOC = "/ws/write/hugo/index.md";

describe("buildLinkTargetItems", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("each file should yield both a document-relative and a root-relative form", () => {
        const items = buildLinkTargetItems(
            ["/ws/write/notion/index.md"],
            DOC,
            ROOT,
        );

        expect(items).toEqual([
            { relative: "../notion/index.md", rootRelative: "/write/notion/index.md" },
        ]);
    });

    it("a sibling file should get a bare relative path without ../", () => {
        const items = buildLinkTargetItems(["/ws/write/hugo/notes.md"], DOC, ROOT);

        expect(items[0].relative).toBe("notes.md");
        expect(items[0].rootRelative).toBe("/write/hugo/notes.md");
    });

    it("the document itself should never be suggested", () => {
        const items = buildLinkTargetItems([DOC, "/ws/other.md"], DOC, ROOT);

        expect(items).toHaveLength(1);
        expect(items[0].rootRelative).toBe("/other.md");
    });

    it("files outside the workspace root should be skipped", () => {
        const items = buildLinkTargetItems(
            ["/elsewhere/file.md", "/ws/inside.md"],
            DOC,
            ROOT,
        );

        expect(items.map((i) => i.rootRelative)).toEqual(["/inside.md"]);
    });
});
