/**
 * sourceSearch tests: query compilation, segment collection/search over a
 * real ProseMirror document, and the raw-source fallback's line→block mapping.
 */
import { describe, it, expect } from "vitest";
import { Schema, type Node as PmNode } from "../pm";
import {
    buildQuery,
    expandReplacement,
    collectSegments,
    searchSegments,
    searchSourceFallback,
    computeBlockPositions,
    lineToBlockIndex,
    MAX_PATTERN_LENGTH,
    type MarkAttrSegment,
    type NodeAttrSegment,
} from "../components/findBar/sourceSearch";

// ── Test schema: minimal commonmark-like shapes ──────────
const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        code_block: {
            group: "block",
            content: "text*",
            code: true,
            marks: "",
            attrs: { language: { default: "" } },
        },
        hr: { group: "block" },
        image: {
            group: "inline",
            inline: true,
            attrs: {
                src: { default: "" },
                alt: { default: "" },
                title: { default: "" },
            },
        },
        text: { group: "inline" },
    },
    marks: {
        link: { attrs: { href: { default: "" }, title: { default: null } } },
        strong: {},
    },
});

const p = (...content: PmNode[]) => schema.node("paragraph", null, content);
const doc = (...content: PmNode[]) => schema.node("doc", null, content);
const txt = (text: string, marks: ReturnType<typeof schema.mark>[] = []) =>
    schema.text(text, marks);
const link = (href: string) => schema.mark("link", { href });

function compile(query: string, opts: Partial<Parameters<typeof buildQuery>[1]> = {}): RegExp {
    const result = buildQuery(query, {
        regex: false,
        wholeWord: false,
        caseSensitive: false,
        ...opts,
    });
    if (result.error !== undefined) {
        throw new Error(result.error);
    }
    return result.re;
}

describe("buildQuery", () => {
    it("a literal query with regex metacharacters should be escaped", () => {
        const re = compile("a.b");
        expect(re.test("a.b")).toBe(true);
        expect(re.test("aXb")).toBe(false);
    });

    it("a case-insensitive query should match regardless of case", () => {
        const re = compile("foo");
        expect(re.test("FOO")).toBe(true);
    });

    it("a case-sensitive query should only match the exact case", () => {
        const re = compile("foo", { caseSensitive: true });
        expect(re.test("FOO")).toBe(false);
        expect(re.test("foo")).toBe(true);
    });

    it("a whole-word query should not match inside a larger word", () => {
        const re = compile("cat", { wholeWord: true });
        expect(re.test("the cat sat")).toBe(true);
        re.lastIndex = 0;
        expect(re.test("concatenate")).toBe(false);
    });

    it("a whole-word alternation in regex mode should keep both branches bounded", () => {
        const re = compile("cat|dog", { regex: true, wholeWord: true });
        expect("catalog dog".match(re)).toEqual(["dog"]);
    });

    it("a regex-mode query should be compiled as a pattern", () => {
        const re = compile("fo+", { regex: true });
        expect(re.test("fooo")).toBe(true);
    });

    it("an invalid regex should report an error instead of throwing", () => {
        const result = buildQuery("(", { regex: true, wholeWord: false, caseSensitive: false });
        expect(result.error).toBeDefined();
        expect(result.re).toBeUndefined();
    });

    it("an empty query should report an error", () => {
        expect(buildQuery("", { regex: false, wholeWord: false, caseSensitive: false }).error).toBeDefined();
    });

    it("a pattern over the length cap should report an error", () => {
        const long = "a".repeat(MAX_PATTERN_LENGTH + 1);
        expect(buildQuery(long, { regex: false, wholeWord: false, caseSensitive: false }).error).toBeDefined();
    });
});

describe("expandReplacement", () => {
    const exec = (pattern: string, text: string): RegExpExecArray => {
        const m = new RegExp(pattern, "g").exec(text);
        if (!m) {
            throw new Error("no match");
        }
        return m;
    };

    it("numbered groups should substitute their captured text", () => {
        const m = exec("([a-z]+)(\\d+)", "foo123");
        expect(expandReplacement("$2-$1", m)).toBe("123-foo");
    });

    it("$& should substitute the whole match and $$ a literal dollar", () => {
        const m = exec("foo", "foo");
        expect(expandReplacement("[$&]$$", m)).toBe("[foo]$");
    });

    it("a reference to a non-existent group should stay literal", () => {
        const m = exec("(a)", "a");
        expect(expandReplacement("$5", m)).toBe("$5");
    });

    it("a non-participating group should expand to the empty string", () => {
        const m = exec("(a)|(b)", "a");
        expect(expandReplacement("<$2>", m)).toBe("<>");
    });

    it("a two-digit reference beyond the group count should fall back to the one-digit group", () => {
        const m = exec("(x)", "x");
        expect(expandReplacement("$12", m)).toBe("x2");
    });
});

describe("collectSegments", () => {
    it("plain text nodes should produce text segments with exact PM positions", () => {
        const d = doc(p(txt("hello world")));
        const segments = collectSegments(d);
        expect(segments).toEqual([{ kind: "text", from: 1, text: "hello world" }]);
    });

    it("a link mark should produce an href attr segment alongside its text", () => {
        const d = doc(p(txt("see "), txt("docs", [link("https://example.com/docs")])));
        const segments = collectSegments(d);
        const href = segments.find((s) => s.kind === "mark-attr") as MarkAttrSegment;
        expect(href.attr).toBe("href");
        expect(href.text).toBe("https://example.com/docs");
        expect(href.from).toBe(5);
        expect(href.to).toBe(9);
    });

    it("adjacent text nodes sharing one link mark should coalesce into one href segment", () => {
        const strong = schema.mark("strong");
        const l = link("https://example.com");
        const d = doc(p(txt("cli", [l]), txt("ck", [l, strong])));
        const segments = collectSegments(d);
        const hrefs = segments.filter((s) => s.kind === "mark-attr") as MarkAttrSegment[];
        expect(hrefs).toHaveLength(1);
        expect(hrefs[0].from).toBe(1);
        expect(hrefs[0].to).toBe(6);
    });

    it("image nodes should expose src, alt and title as attr segments", () => {
        const img = schema.node("image", { src: "img/cat.png", alt: "a cat", title: "Cat" });
        const d = doc(p(img));
        const attrs = collectSegments(d).filter((s) => s.kind === "node-attr") as NodeAttrSegment[];
        expect(attrs.map((s) => [s.attr, s.text])).toEqual([
            ["src", "img/cat.png"],
            ["alt", "a cat"],
            ["title", "Cat"],
        ]);
        expect(attrs[0].nodePos).toBe(1);
    });

    it("empty image attrs should not produce segments", () => {
        const img = schema.node("image", { src: "x.png" });
        const attrs = collectSegments(doc(p(img))).filter((s) => s.kind === "node-attr");
        expect(attrs).toHaveLength(1);
    });

    it("a code block language should be exposed as an attr segment", () => {
        const code = schema.node("code_block", { language: "javascript" }, [schema.text("let x")]);
        const d = doc(code);
        const segments = collectSegments(d);
        const attr = segments.find((s) => s.kind === "node-attr") as NodeAttrSegment;
        expect(attr).toMatchObject({ nodePos: 0, attr: "language", text: "javascript" });
        // the code text itself stays searchable
        expect(segments.find((s) => s.kind === "text")).toMatchObject({ text: "let x" });
    });
});

describe("searchSegments", () => {
    it("text matches should carry PM from/to that select the matched text", () => {
        const d = doc(p(txt("foo bar foo")));
        const matches = searchSegments(collectSegments(d), compile("foo"));
        expect(matches).toHaveLength(2);
        const [a, b] = matches;
        if (a.kind !== "text" || b.kind !== "text") {
            throw new Error("expected text matches");
        }
        expect(d.textBetween(a.from, a.to)).toBe("foo");
        expect(d.textBetween(b.from, b.to)).toBe("foo");
        expect(b.from).toBe(9);
    });

    it("matches inside a link URL should carry attr offsets", () => {
        const d = doc(p(txt("docs", [link("https://example.com/docs")])));
        const matches = searchSegments(collectSegments(d), compile("example"));
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({ kind: "mark-attr", attr: "href", start: 8, end: 15 });
    });

    it("a zero-length regex match should be skipped instead of looping forever", () => {
        const d = doc(p(txt("abc")));
        const matches = searchSegments(collectSegments(d), compile("x*", { regex: true }));
        expect(matches).toHaveLength(0);
    });

    it("overlapping occurrences should be counted as non-overlapping matches", () => {
        const d = doc(p(txt("aaaa")));
        const matches = searchSegments(collectSegments(d), compile("aa"));
        expect(matches).toHaveLength(2);
    });
});

describe("lineToBlockIndex", () => {
    it("lines inside a block's range should map to that block", () => {
        const lineMap = [1, 5, 9];
        expect(lineToBlockIndex(lineMap, 1)).toBe(0);
        expect(lineToBlockIndex(lineMap, 4)).toBe(0);
        expect(lineToBlockIndex(lineMap, 5)).toBe(1);
        expect(lineToBlockIndex(lineMap, 100)).toBe(2);
    });

    it("a line before the first block should clamp to block 0", () => {
        expect(lineToBlockIndex([3, 6], 1)).toBe(0);
    });
});

describe("searchSourceFallback", () => {
    it("syntax-only hits should surface as block matches with block positions", () => {
        const d = doc(p(txt("bold text")));
        const source = "**bold** text";
        const re = compile("**");
        const covered = searchSegments(collectSegments(d), re);
        const blockPositions = computeBlockPositions(d);
        const matches = searchSourceFallback(source, [1], re, covered, blockPositions);
        expect(matches).toHaveLength(2);
        expect(matches[0]).toMatchObject({ kind: "block", blockIndex: 0, blockPos: 0, line: 1 });
    });

    it("source occurrences covered by tier-1 matches should be dropped", () => {
        const d = doc(p(txt("bold text")));
        const source = "**bold** text";
        const re = compile("bold");
        const covered = searchSegments(collectSegments(d), re);
        const matches = searchSourceFallback(source, [1], re, covered, computeBlockPositions(d));
        expect(matches).toHaveLength(0);
    });

    it("a thematic break should map to the correct block via the line map", () => {
        const d = doc(p(txt("para1")), schema.node("hr"), p(txt("para2")));
        const source = "para1\n\n---\n\npara2";
        const re = compile("---");
        const covered = searchSegments(collectSegments(d), re);
        const matches = searchSourceFallback(source, [1, 3, 5], re, covered, computeBlockPositions(d));
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({ blockIndex: 1, line: 3 });
        // hr sits after "para1" paragraph: positions [0, 7, 8]
        expect(matches[0].blockPos).toBe(7);
    });

    it("tier-1 coverage in a neighboring block should still be consumed globally", () => {
        // Heading + paragraph share one lineMap entry, so the block mapping
        // of source hits can disagree with the doc's block layout
        const d = doc(p(txt("Title")), p(txt("Title again")));
        const source = "# Title\nTitle again";
        const re = compile("Title");
        const covered = searchSegments(collectSegments(d), re);
        const matches = searchSourceFallback(source, [1], re, covered, computeBlockPositions(d));
        expect(matches).toHaveLength(0);
    });

    it("an empty source should produce no block matches", () => {
        expect(searchSourceFallback("", [], compile("x"), [], [])).toEqual([]);
    });
});
