import { describe, it, expect } from "vitest";
import { detectPastedLinkTarget } from "@/plugins/pasteLink";

describe("detectPastedLinkTarget", () => {
    describe("scheme URLs", () => {
        it("an https URL should be returned verbatim", () => {
            expect(detectPastedLinkTarget("https://example.com")).toBe("https://example.com");
        });

        it("an http URL with a path and query should be returned verbatim", () => {
            const u = "http://foo.example.com/a/b?c=d&e=f#frag";
            expect(detectPastedLinkTarget(u)).toBe(u);
        });

        it("a mailto: URL should be returned verbatim", () => {
            expect(detectPastedLinkTarget("mailto:a@b.com")).toBe("mailto:a@b.com");
        });

        it("an ftp URL should be returned verbatim", () => {
            expect(detectPastedLinkTarget("ftp://host.tld/file")).toBe("ftp://host.tld/file");
        });

        it("surrounding whitespace should be trimmed before matching", () => {
            expect(detectPastedLinkTarget("  https://example.com \n")).toBe("https://example.com");
        });
    });

    describe("bare web domains", () => {
        it("a bare domain should be returned verbatim (no scheme prepended)", () => {
            expect(detectPastedLinkTarget("example.com")).toBe("example.com");
        });

        it("a www.-prefixed domain with a path should be accepted", () => {
            expect(detectPastedLinkTarget("www.foo.com/path")).toBe("www.foo.com/path");
        });

        it("a multi-label subdomain should be accepted", () => {
            expect(detectPastedLinkTarget("docs.foo.co.uk")).toBe("docs.foo.co.uk");
        });
    });

    describe("rejected — pastes normally (null)", () => {
        it("empty or whitespace-only input should return null", () => {
            expect(detectPastedLinkTarget("")).toBeNull();
            expect(detectPastedLinkTarget("   ")).toBeNull();
        });

        it("multi-word text should return null", () => {
            expect(detectPastedLinkTarget("see https://example.com now")).toBeNull();
        });

        it("a markdown link payload should return null", () => {
            expect(detectPastedLinkTarget("[text](https://example.com)")).toBeNull();
        });

        it("a wikilink payload should return null", () => {
            expect(detectPastedLinkTarget("[[Page]]")).toBeNull();
        });

        it("a bare filename with a doc extension should return null", () => {
            expect(detectPastedLinkTarget("notes.md")).toBeNull();
            expect(detectPastedLinkTarget("diagram.png")).toBeNull();
            expect(detectPastedLinkTarget("data.json")).toBeNull();
        });

        it("a workspace path should return null", () => {
            expect(detectPastedLinkTarget("./notes/x.md")).toBeNull();
            expect(detectPastedLinkTarget("/docs/y")).toBeNull();
            expect(detectPastedLinkTarget("../z")).toBeNull();
        });

        it("a plain word with no dot should return null", () => {
            expect(detectPastedLinkTarget("example")).toBeNull();
        });

        it("an anchor fragment should return null", () => {
            expect(detectPastedLinkTarget("#heading")).toBeNull();
        });
    });
});
