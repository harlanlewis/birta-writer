/**
 * linkTargetSuggest tests: the pure query/ranking core shared by the
 * Extension (ranking workspace files before replying) and the WebView
 * (re-ranking a reply against the input's latest value) for link URL
 * autocompletion.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    isLocalPathQuery,
    preferredLinkForm,
    rankLinkTargets,
} from "../linkTargetSuggest";
import type { LinkTargetSuggestionItem } from "../messages";

/** Shorthand for building a suggestion item. */
const item = (relative: string, rootRelative: string): LinkTargetSuggestionItem => ({
    relative,
    rootRelative,
});

describe("isLocalPathQuery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("local path fragments should be suggestible", () => {
        expect(isLocalPathQuery("notion")).toBe(true);
        expect(isLocalPathQuery("../notion/index.md")).toBe(true);
        expect(isLocalPathQuery("/write/notion")).toBe(true);
        expect(isLocalPathQuery("./docs/a.md")).toBe(true);
    });

    it("external targets (scheme URLs and #anchors) should not be suggestible", () => {
        expect(isLocalPathQuery("http://example.com")).toBe(false);
        expect(isLocalPathQuery("https://example.com/a")).toBe(false);
        expect(isLocalPathQuery("mailto:someone@example.com")).toBe(false);
        expect(isLocalPathQuery("#section-heading")).toBe(false);
    });

    it("empty or whitespace-only input should not be suggestible", () => {
        expect(isLocalPathQuery("")).toBe(false);
        expect(isLocalPathQuery("   ")).toBe(false);
    });
});

describe("preferredLinkForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a query starting with / should prefer the root-relative form", () => {
        const it_ = item("../notion/index.md", "/write/notion/index.md");

        expect(preferredLinkForm(it_, "/wri")).toBe("/write/notion/index.md");
    });

    it("any other query should prefer the document-relative form", () => {
        const it_ = item("../notion/index.md", "/write/notion/index.md");

        expect(preferredLinkForm(it_, "notion")).toBe("../notion/index.md");
        expect(preferredLinkForm(it_, "../not")).toBe("../notion/index.md");
    });
});

describe("rankLinkTargets", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("matching should be a case-insensitive substring on either form", () => {
        const items = [
            item("../Notion/Index.md", "/write/Notion/Index.md"),
            item("other/file.md", "/docs/other/file.md"),
        ];

        const ranked = rankLinkTargets(items, "notion");

        expect(ranked).toHaveLength(1);
        expect(ranked[0].rootRelative).toBe("/write/Notion/Index.md");
    });

    it("a query matching only the root-relative form should still hit", () => {
        // "write" appears in rootRelative only (the doc lives inside /write)
        const items = [item("../notion/index.md", "/write/notion/index.md")];

        expect(rankLinkTargets(items, "/write")).toHaveLength(1);
    });

    it("markdown files should rank before other files regardless of length", () => {
        const items = [
            item("a.png", "/a.png"),
            item("deeply/nested/page.markdown", "/deeply/nested/page.markdown"),
            item("deep/page.md", "/deep/page.md"),
        ];

        const ranked = rankLinkTargets(items, "p");

        expect(ranked.map((i) => i.rootRelative)).toEqual([
            "/deep/page.md",
            "/deeply/nested/page.markdown",
            "/a.png",
        ]);
    });

    it("within the same class, shorter paths first, then alphabetical", () => {
        const items = [
            item("bb.md", "/bb.md"),
            item("aa.md", "/aa.md"),
            item("a.md", "/a.md"),
        ];

        const ranked = rankLinkTargets(items, "md");

        expect(ranked.map((i) => i.rootRelative)).toEqual(["/a.md", "/aa.md", "/bb.md"]);
    });

    it("an exact match of the preferred form should be dropped (already complete)", () => {
        const items = [item("../notion/index.md", "/write/notion/index.md")];

        // A partial query keeps the item; typing it out fully drops it.
        expect(rankLinkTargets(items, "../notion/index.m")).toHaveLength(1);
        expect(rankLinkTargets(items, "../notion/index.md")).toEqual([]);
        expect(rankLinkTargets(items, "/write/notion/index.md")).toEqual([]);
    });

    it("a leading ./ in the query should be ignored for matching", () => {
        const items = [item("docs/guide.md", "/docs/guide.md")];

        expect(rankLinkTargets(items, "./docs/gui")).toHaveLength(1);
    });

    it("results should be capped at the limit", () => {
        const items = Array.from({ length: 30 }, (_, i) =>
            item(`file-${i}.md`, `/file-${i}.md`),
        );

        expect(rankLinkTargets(items, "file")).toHaveLength(20);
        expect(rankLinkTargets(items, "file", 5)).toHaveLength(5);
    });
});
