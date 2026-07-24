/**
 * headingSuggest tests: the shared heading-suggestion source (enumeration is
 * exercised through a live doc in headingLinkComplete.test.ts; here the pure
 * ranking and display shaping). No editor, no DOM.
 */
import { describe, it, expect } from "vitest";
import {
    filterHeadingSuggestions,
    outlineDisplayRows,
    type HeadingSuggestion,
} from "../utils/headingSuggest";

const H = (title: string, slug: string, level: number): HeadingSuggestion => ({
    title,
    slug,
    level,
});

const ALL = [
    H("Living calculations", "living-calculations", 1),
    H("Overview", "overview", 2),
    H("Deep dive", "deep-dive", 2),
    H("Overview", "overview-1", 2),
];

describe("filterHeadingSuggestions", () => {
    it("an empty query should return everything in document order", () => {
        expect(filterHeadingSuggestions(ALL, "")).toEqual(ALL);
        expect(filterHeadingSuggestions(ALL, "   ")).toEqual(ALL);
    });

    it("a title prefix should rank before a slug prefix and a substring", () => {
        const all = [
            H("Notes on deep work", "notes-on-deep-work", 2), // substring only
            H("deep-sea-fishing", "deep-sea-fishing", 2), // slug prefix (title has hyphen too)
            H("Deep dive", "deep-dive", 2), // title prefix
        ];
        const got = filterHeadingSuggestions(all, "deep").map((h) => h.slug);
        expect(got).toEqual(["deep-sea-fishing", "deep-dive", "notes-on-deep-work"]);
    });

    it("matching should be case-insensitive over title and slug", () => {
        expect(filterHeadingSuggestions(ALL, "LIVING")[0].slug).toBe("living-calculations");
        expect(filterHeadingSuggestions(ALL, "overview-1")[0].slug).toBe("overview-1");
    });

    it("a query matching nothing should return an empty list", () => {
        expect(filterHeadingSuggestions(ALL, "zzz")).toEqual([]);
    });
});

describe("outlineDisplayRows", () => {
    it("should indent by level and disambiguate repeated titles", () => {
        const rows = outlineDisplayRows(ALL);
        expect(rows[0].display).toBe("Living calculations");
        expect(rows[1].display).toBe("  Overview");
        expect(rows[3].display).toBe("  Overview (2)");
        // Displays are injective; picks keep their own slugs.
        expect(new Set(rows.map((r) => r.display)).size).toBe(rows.length);
        expect(rows[3].pick.slug).toBe("overview-1");
    });
});
