import { describe, it, expect } from "vitest";
import { slugify } from "../../webview/utils/slug";

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
