/**
 * frontmatterSuggestions tests: the pure workspace-scan core that powers the
 * frontmatter "+" suggestion menu (per-file list-value extraction, frequency
 * ranking, per-key isolation, and tolerance of non-tabular frontmatter).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    collectFrontmatterListValues,
    extractListValuesByKey,
    rankListValues,
} from "../utils/frontmatterSuggestions";

/** Wraps markdown text in a synchronous getText source. */
const file = (text: string) => ({ getText: () => text });

/** Wraps markdown text in an asynchronous getText source. */
const asyncFile = (text: string) => ({ getText: async () => text });

/** Builds a markdown document with a block-list `tags` frontmatter. */
function docWithTags(...tags: string[]): string {
    return `---\ntags:\n- ${tags.join("\n- ")}\n---\n\n# Body\n`;
}

describe("collectFrontmatterListValues", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("values used in more files should rank before rarer ones, ties alphabetical", async () => {
        // Arrange: "beta" appears in two files; "alpha"/"zulu" once each
        const files = [
            file(docWithTags("beta", "zulu")),
            file(docWithTags("beta", "alpha")),
        ];

        // Act
        const values = await collectFrontmatterListValues(files, "tags");

        // Assert: frequency desc, then alphabetical among the count-1 values
        expect(values).toEqual(["beta", "alpha", "zulu"]);
    });

    it("a value shared by several files should appear only once", async () => {
        const files = [file(docWithTags("shared")), file(docWithTags("shared")), file(docWithTags("shared"))];

        const values = await collectFrontmatterListValues(files, "tags");

        expect(values).toEqual(["shared"]);
    });

    it("values of one key should not leak into another key's suggestions", async () => {
        const files = [
            file("---\ntags:\n- from-tags\nkeywords:\n- from-keywords\n---\nbody"),
        ];

        expect(await collectFrontmatterListValues(files, "tags")).toEqual(["from-tags"]);
        expect(await collectFrontmatterListValues(files, "keywords")).toEqual(["from-keywords"]);
    });

    it("files without frontmatter should contribute nothing", async () => {
        const files = [file("# Just a heading\n\ntags:\n- not-frontmatter\n"), file(docWithTags("real"))];

        const values = await collectFrontmatterListValues(files, "tags");

        expect(values).toEqual(["real"]);
    });

    it("files with non-tabular frontmatter should contribute nothing", async () => {
        const nested = "---\nauthor:\n  name: Jane\ntags:\n- hidden-by-nesting\n---\nbody";
        const commented = "---\n# a comment\ntags:\n- hidden-by-comment\n---\nbody";
        const files = [file(nested), file(commented), file(docWithTags("visible"))];

        const values = await collectFrontmatterListValues(files, "tags");

        expect(values).toEqual(["visible"]);
    });

    it("inline flow, multi-line flow and block lists should all contribute", async () => {
        const inline = '---\ntags: [inline-a, "inline-b"]\n---\nbody';
        const flowMulti = '---\ntags:\n[\n  "multi-a",\n  "multi-b",\n]\n---\nbody';
        const block = "---\ntags:\n- block-a\n---\nbody";

        const values = await collectFrontmatterListValues(
            [file(inline), file(flowMulti), file(block)],
            "tags",
        );

        expect(values.sort()).toEqual(
            ["block-a", "inline-a", "inline-b", "multi-a", "multi-b"].sort(),
        );
    });

    it("scalar frontmatter values should be ignored (lists only)", async () => {
        const files = [file("---\ntitle: Not A List\ntags:\n- listed\n---\nbody")];

        expect(await collectFrontmatterListValues(files, "title")).toEqual([]);
        expect(await collectFrontmatterListValues(files, "tags")).toEqual(["listed"]);
    });

    it("asynchronous getText sources should be awaited", async () => {
        const values = await collectFrontmatterListValues(
            [asyncFile(docWithTags("async-value"))],
            "tags",
        );

        expect(values).toEqual(["async-value"]);
    });

    it("an unknown key should yield an empty list", async () => {
        const values = await collectFrontmatterListValues([file(docWithTags("a"))], "nope");

        expect(values).toEqual([]);
    });
});

describe("extractListValuesByKey", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("empty items produced by quoting should be dropped", () => {
        const result = extractListValuesByKey('---\ntags:\n- ""\n- kept\n---\nbody');

        expect(result.get("tags")).toEqual(["kept"]);
    });

    it("a document without frontmatter should yield an empty map", () => {
        expect(extractListValuesByKey("plain body").size).toBe(0);
    });
});

describe("rankListValues", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("an empty file set should yield an empty list", () => {
        expect(rankListValues([], "tags")).toEqual([]);
    });

    it("higher counts should sort first, alphabetical within a count", () => {
        const perFile = [
            new Map([["tags", ["b", "c"]]]),
            new Map([["tags", ["c", "a"]]]),
        ];

        expect(rankListValues(perFile, "tags")).toEqual(["c", "a", "b"]);
    });
});
