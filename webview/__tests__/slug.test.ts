import { describe, it, expect } from "vitest";
import { slugify, slugifyHeadings, computeSlugRenames } from "../../webview/utils/slug";

describe("slugify", () => {
    it("English text should be lowercased", () => {
        expect(slugify("Hello World")).toBe("hello-world");
    });

    it("spaces should be replaced with hyphens", () => {
        expect(slugify("foo bar baz")).toBe("foo-bar-baz");
    });

    it("Chinese characters should be preserved as-is", () => {
        expect(slugify("二级标题示例")).toBe("二级标题示例");
    });

    it("mixed Chinese and English should be handled", () => {
        expect(slugify("H2 二级标题示例")).toBe("h2-二级标题示例");
    });

    it("emoji should be removed", () => {
        // Emoji is outside the \p{L}\p{N}_- range, so it is removed and spaces become -
        expect(slugify("🚀 Emoji 标题")).toBe("-emoji-标题");
    });

    it("symbols like colons should be removed, keeping adjacent hyphens (GitHub rule)", () => {
        expect(slugify("含特殊字符 : 和 &")).toBe("含特殊字符--和-");
    });

    it("already-lowercase text should stay unchanged", () => {
        expect(slugify("lowercase")).toBe("lowercase");
    });

    it("an empty string should return an empty string", () => {
        expect(slugify("")).toBe("");
    });

    it("an all-symbol string should return an empty string", () => {
        expect(slugify("!!!@@@###")).toBe("");
    });

    it("numbers should be preserved", () => {
        expect(slugify("Chapter 1")).toBe("chapter-1");
    });

    it("hyphens and underscores should be preserved as-is", () => {
        expect(slugify("some-_-slug")).toBe("some-_-slug");
    });

    it("Japanese characters (hiragana) should be preserved", () => {
        const result = slugify("あいうえお");
        expect(result).toBe("あいうえお");
    });
});

describe("slugifyHeadings", () => {
    it("distinct titles should each slugify independently", () => {
        expect(slugifyHeadings(["Introduction", "Getting Started"])).toEqual([
            "introduction",
            "getting-started",
        ]);
    });

    it("repeated titles should get GitHub -N suffixes in document order", () => {
        expect(slugifyHeadings(["Foo", "Foo", "Foo"])).toEqual([
            "foo",
            "foo-1",
            "foo-2",
        ]);
    });

    it("dedup should key on the base slug, not the raw title", () => {
        // Two different titles that collapse to the same base slug still
        // collide — the second must carry the -1 suffix.
        expect(slugifyHeadings(["Foo Bar", "foo bar"])).toEqual([
            "foo-bar",
            "foo-bar-1",
        ]);
    });

    it("an interleaved duplicate should number only its own base slug", () => {
        expect(slugifyHeadings(["Foo", "Bar", "Foo"])).toEqual([
            "foo",
            "bar",
            "foo-1",
        ]);
    });

    it("CJK and mixed titles should slugify via the underlying slugify", () => {
        expect(slugifyHeadings(["二级标题示例", "H2 二级标题示例"])).toEqual([
            "二级标题示例",
            "h2-二级标题示例",
        ]);
    });

    it("an empty base slug (emoji/punctuation only) should be unaddressable and not consume a counter", () => {
        // "🚀" and "!!!" both slugify to "" — they yield "" and must NOT bump
        // the collision counter for the real "Foo" headings around them, so the
        // two "Foo"s still number foo / foo-1 (matching the click-resolver,
        // which skips empty-slug headings entirely).
        expect(slugifyHeadings(["Foo", "🚀", "!!!", "Foo"])).toEqual([
            "foo",
            "",
            "",
            "foo-1",
        ]);
    });

    it("an empty input array should return an empty array", () => {
        expect(slugifyHeadings([])).toEqual([]);
    });
});

describe("computeSlugRenames", () => {
    it("a unique heading rename should record only its old→new slug", () => {
        const renames = computeSlugRenames(["Intro", "Setup"], ["Introduction", "Setup"], [0, 1]);
        expect([...renames]).toEqual([["intro", "introduction"]]);
    });

    it("an unchanged heading (same text) should record nothing", () => {
        const renames = computeSlugRenames(["Alpha", "Beta"], ["Alpha", "Beta"], [0, 1]);
        expect(renames.size).toBe(0);
    });

    it("renaming the FIRST of two duplicates should record BOTH the edit and the -N shift", () => {
        // old slugs [foo, foo-1]; new slugs [bar, foo] — the survivor inherits
        // the base slug, so foo-1 → foo must be recorded alongside foo → bar.
        const renames = computeSlugRenames(["Foo", "Foo"], ["Bar", "Foo"], [0, 1]);
        expect(renames.get("foo")).toBe("bar");
        expect(renames.get("foo-1")).toBe("foo");
        expect(renames.size).toBe(2);
    });

    it("renaming a heading to COLLIDE with an existing one should mint the -N slug deterministically", () => {
        // old slugs [foo, baz]; new slugs [foo, foo-1] — the newcomer collides
        // and takes foo-1, so only baz → foo-1 is recorded (foo is unchanged).
        const renames = computeSlugRenames(["Foo", "Baz"], ["Foo", "Foo"], [0, 1]);
        expect([...renames]).toEqual([["baz", "foo-1"]]);
    });

    it("an unpaired old heading (-1: deleted/moved) should record nothing for it", () => {
        // The first heading was deleted (no counterpart); its links must be left
        // dangling, never rewritten. The surviving pair is unchanged.
        const renames = computeSlugRenames(["Gone", "Keep"], ["Keep"], [-1, 0]);
        expect(renames.size).toBe(0);
    });

    it("a rename from/to an unaddressable (empty-slug) heading should record nothing", () => {
        // "🚀" slugifies to "" — it has no #slug to be a rename source or target.
        expect(computeSlugRenames(["🚀"], ["Rocket"], [0]).size).toBe(0);
        expect(computeSlugRenames(["Rocket"], ["🚀"], [0]).size).toBe(0);
    });
});
