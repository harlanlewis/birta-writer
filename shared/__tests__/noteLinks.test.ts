/**
 * The host-side note reader: the frontmatter half (sources, attributes) and
 * the classification rules. The body scanner's agreement with the editor is
 * held over the whole corpus by webview/__tests__/noteLinksCorpus.test.ts;
 * this file pins what that oracle cannot see, because the editor never reads
 * frontmatter and never reports a line.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { hrefPath, isNoteHref, readNote } from "../noteLinks";

const OKF_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "webview", "__tests__", "fixtures", "okf-provenance.md"),
    "utf8",
);

describe("isNoteHref", () => {
    it("a path should be a note href whether relative, rooted or bare", () => {
        expect(isNoteHref("notes/a.md")).toBe(true);
        expect(isNoteHref("/index.md")).toBe(true);
        expect(isNoteHref("../up.md#section")).toBe(true);
        expect(isNoteHref("Roadmap")).toBe(true);
    });

    it("a scheme, a bare fragment or nothing should not be a note href", () => {
        expect(isNoteHref("https://example.com/a.md")).toBe(false);
        expect(isNoteHref("mailto:a@b.co")).toBe(false);
        expect(isNoteHref("obsidian://open?vault=x")).toBe(false);
        expect(isNoteHref("#heading")).toBe(false);
        expect(isNoteHref("")).toBe(false);
    });
});

describe("hrefPath", () => {
    it("a fragment should be cut at the first hash", () => {
        expect(hrefPath("a.md#h#i")).toBe("a.md");
        expect(hrefPath("a.md")).toBe("a.md");
    });
});

describe("readNote: the OKF fixture's frontmatter", () => {
    const note = readNote(OKF_FIXTURE);

    it("a local sources[].resource should be an edge and a URL resource should not", () => {
        const sources = note.links.filter((l) => l.kind === "source");
        expect(sources.map((s) => s.href)).toEqual(["references/finance.md"]);
    });

    it("a source edge should carry the frontmatter line its resource sits on", () => {
        const source = note.links.find((l) => l.kind === "source")!;
        const lines = OKF_FIXTURE.split("\n");
        expect(lines[source.line - 1]).toContain("resource: references/finance.md");
    });

    it("the attributes should be read the way the panel reads them", () => {
        expect(note.meta.title).toBe("GA4 dimension catalogue");
        expect(note.meta.type).toBe("reference");
        expect(note.meta.tags).toEqual(["analytics", "ga4", "reference"]);
        expect(note.meta.status).toBe("stable");
        expect(note.meta.staleAfter).toBe("2026-03-12T00:00:00Z");
        // A human among the verifiers is the human-reviewed tier.
        expect(note.meta.trust).toBe("human");
    });
});

describe("readNote: the body", () => {
    it("a body link should report the file line it is written on, frontmatter counted", () => {
        const content = "---\ntitle: T\n---\n\nFirst line.\n\nSee [a](a.md) and\n[[B]] here.\n";
        const note = readNote(content);
        const lines = content.split("\n");
        expect(note.links.map((l) => [l.kind, l.href, lines[l.line - 1]])).toEqual([
            ["link", "a.md", "See [a](a.md) and"],
            ["wiki", "B", "[[B]] here."],
        ]);
    });

    it("a note with no frontmatter should still have its links and empty attributes", () => {
        const note = readNote("Only [x](x.md).\n");
        expect(note.links.map((l) => l.href)).toEqual(["x.md"]);
        expect(note.meta).toEqual({ title: null, type: null, tags: [], status: null, trust: null, staleAfter: null });
    });

    it("a wikilink should split into path and heading, keeping the alias as its text", () => {
        const [link] = readNote("[[Meeting notes#Decisions|the decisions]]\n").links;
        expect(link).toMatchObject({ kind: "wiki", href: "Meeting notes#Decisions", path: "Meeting notes", text: "the decisions" });
    });

    it("a same-note wikilink and a same-note fragment should not be note links", () => {
        expect(readNote("[[#Heading]] and [top](#top)\n").links).toEqual([]);
    });

    it("a footnote definition should be scanned as text, never taken for a link definition", () => {
        const note = readNote("Call.[^1]\n\n[^1]: see [[Source]] and [^1]\n");
        expect(note.links.map((l) => l.href)).toEqual(["Source"]);
    });

    it("a reference link should take its definition's destination, labels matched case- and space-insensitively", () => {
        const note = readNote("[a][The  Ref], [The Ref][], [the ref]\n\n[THE REF]: target.md \"t\"\n");
        expect(note.links.map((l) => l.href)).toEqual(["target.md", "target.md", "target.md"]);
    });

    it("the first definition of a label should win", () => {
        expect(readNote("[r]\n\n[r]: first.md\n[r]: second.md\n").links.map((l) => l.href)).toEqual(["first.md"]);
    });

    it("a numeric reference no code point can hold should read as U+FFFD, never throw", () => {
        // A throw here rejects the host's whole folder index, not one note.
        for (const ref of ["&#x110000;", "&#9999999;", "&#0;", "&#xD800;"]) {
            expect(readNote(`[x](${ref}.md)\n`).links.map((l) => l.href)).toEqual(["�.md"]);
        }
    });

    it("a name that is not a character reference should stay as written, whatever Object calls it", () => {
        expect(readNote("[x](&constructor;.md) [&toString; label](a.md)\n").links.map((l) => [l.href, l.text])).toEqual([
            ["&constructor;.md", "x"],
            ["a.md", "&toString; label"],
        ]);
    });

    it("an unclosed fence should hide every link after it", () => {
        expect(readNote("[a](a.md)\n\n```\n[b](b.md)\n").links.map((l) => l.href)).toEqual(["a.md"]);
    });

    it("a fence closed by a shorter or different run should stay open", () => {
        const note = readNote("````\n```\n~~~~\n[in](in.md)\n````\n[out](out.md)\n");
        expect(note.links.map((l) => l.href)).toEqual(["out.md"]);
    });
});
