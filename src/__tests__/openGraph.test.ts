/**
 * Unit tests for the deterministic page-title parser (src/utils/openGraph.ts,
 * paste-unfurl MAR-178). Pure string-in / title-out — no network. Covers the
 * og:title → <title> → null fallback chain, HTML-entity decoding, control-char
 * and whitespace normalization, the length cap, and malformed input.
 */
import { describe, it, expect } from "vitest";
import {
    extractOgTitle,
    sanitizeTitle,
    decodeHtmlEntities,
} from "../utils/openGraph";

describe("extractOgTitle", () => {
    describe("fallback chain", () => {
        it("an og:title should be used when present", () => {
            const html = `<head>
                <meta property="og:title" content="The OG Title">
                <title>The Document Title</title>
            </head>`;
            expect(extractOgTitle(html)).toBe("The OG Title");
        });

        it("a missing og:title should fall back to the <title> tag", () => {
            const html = `<head><title>Only The Title Tag</title></head>`;
            expect(extractOgTitle(html)).toBe("Only The Title Tag");
        });

        it("neither og:title nor <title> should yield null", () => {
            const html = `<head><meta charset="utf-8"></head><body>no title</body>`;
            expect(extractOgTitle(html)).toBeNull();
        });

        it("an og:title carried on name= (not property=) should still be read", () => {
            const html = `<meta name="og:title" content="Named OG Title">`;
            expect(extractOgTitle(html)).toBe("Named OG Title");
        });

        it("an og:title present but empty should fall through to <title>", () => {
            const html = `<meta property="og:title" content="   ">
                <title>Fallback Wins</title>`;
            expect(extractOgTitle(html)).toBe("Fallback Wins");
        });

        it("attribute order (content before property) should not matter", () => {
            const html = `<meta content="Reversed Attrs" property="og:title">`;
            expect(extractOgTitle(html)).toBe("Reversed Attrs");
        });

        it("a single-quoted content attribute should be read", () => {
            const html = `<meta property='og:title' content='Single Quoted'>`;
            expect(extractOgTitle(html)).toBe("Single Quoted");
        });
    });

    describe("entity decoding + sanitization through the full parse", () => {
        it("HTML entities in the title should be decoded", () => {
            const html = `<title>Cats &amp; Dogs &#39;n&#39; Co &quot;quoted&quot;</title>`;
            expect(extractOgTitle(html)).toBe(`Cats & Dogs 'n' Co "quoted"`);
        });

        it("newlines and tabs inside a title should collapse to single spaces", () => {
            const html = "<title>Line one\n\tLine two</title>";
            expect(extractOgTitle(html)).toBe("Line one Line two");
        });
    });

    describe("malformed / edge input", () => {
        it("empty HTML should yield null", () => {
            expect(extractOgTitle("")).toBeNull();
        });

        it("an unclosed <title> tag should yield null (no complete match)", () => {
            expect(extractOgTitle("<title>never closed")).toBeNull();
        });

        it("a <title> with attributes should still parse", () => {
            expect(extractOgTitle(`<title lang="en">With Attrs</title>`)).toBe("With Attrs");
        });
    });
});

describe("decodeHtmlEntities", () => {
    it("named entities should decode", () => {
        expect(decodeHtmlEntities("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d");
    });

    it("decimal numeric entities should decode", () => {
        expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    });

    it("hex numeric entities should decode", () => {
        expect(decodeHtmlEntities("quote&#x2019;s")).toBe("quote’s");
    });

    it("an unknown named entity should be left verbatim", () => {
        expect(decodeHtmlEntities("a &frobnicate; b")).toBe("a &frobnicate; b");
    });

    it("an out-of-range numeric entity should be left verbatim", () => {
        expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
    });
});

describe("sanitizeTitle", () => {
    it("leading/trailing whitespace should be trimmed", () => {
        expect(sanitizeTitle("   padded title   ")).toBe("padded title");
    });

    it("runs of whitespace should collapse to a single space", () => {
        expect(sanitizeTitle("too    many     spaces")).toBe("too many spaces");
    });

    it("control characters should be stripped to spaces", () => {
        expect(sanitizeTitle("a\u0001b\u0002c\u007f")).toBe("a b c");
    });

    it("a whitespace-only title should sanitize to null", () => {
        expect(sanitizeTitle("  \n\t  ")).toBeNull();
    });

    it("a title longer than the cap should be truncated to 300 chars", () => {
        const long = "x".repeat(500);
        const out = sanitizeTitle(long);
        expect(out).not.toBeNull();
        expect(out!.length).toBe(300);
    });
});
