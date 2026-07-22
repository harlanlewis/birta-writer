import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { findTextMarkers, scanNotes } from "../notes/scan";

/**
 * The Notes scanner (MAR-188). `findTextMarkers` is exercised on plain strings
 * (the boundary/label/dedup logic — the risky part); `scanNotes` runs against a
 * real ProseMirror document for the node-structural detectors (HTML comments,
 * unchecked checkboxes, code-block exclusion, offset→position mapping).
 */

describe("findTextMarkers — built-in markers", () => {
    it("a bare [TK] should be a placeholder labelled from surrounding context", () => {
        const hits = findTextMarkers("The survey had [TK] respondents");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("placeholder");
        expect(hits[0]!.label).toBe("The survey had [TK] respondents");
    });

    it("[TK: spec] should take the trailing text as its label", () => {
        const hits = findTextMarkers("Intro [TK: stat on remote work] here");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("placeholder");
        expect(hits[0]!.label).toBe("stat on remote work");
    });

    it("an unbracketed TODO: should match and keep its trailing text", () => {
        const hits = findTextMarkers("TODO: write the introduction");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("todo");
        expect(hits[0]!.label).toBe("write the introduction");
    });

    it("[TODO] and [FIXME: broken] should map to their kinds", () => {
        expect(findTextMarkers("[TODO]")[0]!.kind).toBe("todo");
        const fix = findTextMarkers("[FIXME: broken link]")[0]!;
        expect(fix.kind).toBe("fixme");
        expect(fix.label).toBe("broken link");
    });

    it("a keyword embedded in a word should not match the colon form", () => {
        expect(findTextMarkers("pseudoTODO: not a task")).toHaveLength(0);
    });

    it("bare TK: (unbracketed) should NOT match — TK is bracket-only", () => {
        expect(findTextMarkers("TK: not matched unbracketed")).toHaveLength(0);
    });

    it("a bracketed [TODO: x] should produce exactly one match, not also a colon match", () => {
        const hits = findTextMarkers("[TODO: fix the header]");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("todo");
        expect(hits[0]!.label).toBe("fix the header");
    });
});

describe("findTextMarkers — custom markers", () => {
    it("a bare alphanumeric custom token should match only as a whole word", () => {
        const hits = findTextMarkers("The DRAFT stands but redrafted DRAFTs do not", ["DRAFT"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("custom");
        expect(hits[0]!.marker).toBe("DRAFT");
    });

    it("a bare custom token must not light up inside a longer word (word-boundary guard)", () => {
        // The classic false positive: TK inside outkast/networks.
        expect(findTextMarkers("outTKast networkTKs", ["TK"])).toHaveLength(0);
        expect(findTextMarkers("a TK b", ["TK"])).toHaveLength(1);
    });

    it("a punctuated custom marker should match as a literal substring", () => {
        const hits = findTextMarkers("please @ai tighten this", ["@ai"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.marker).toBe("@ai");
    });

    it("a custom marker overlapping a built-in should not double-report", () => {
        const hits = findTextMarkers("[TODO] ship it", ["TODO"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("todo"); // the built-in wins, not "custom"
    });

    it("an empty/whitespace custom marker should be ignored", () => {
        expect(findTextMarkers("nothing here", ["", "   "])).toHaveLength(0);
    });
});

// ── scanNotes against a real document ──────────────────────────────────────

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        bullet_list: { group: "block", content: "list_item+" },
        list_item: { content: "paragraph block*", attrs: { checked: { default: null } } },
        code_block: { group: "block", content: "text*", marks: "" },
        text: { group: "inline" },
        image: { group: "inline", inline: true },
        html: { group: "inline", inline: true, atom: true, attrs: { value: { default: "" } } },
    },
    marks: { inlineCode: {} },
});

function p(text: string) {
    return schema.node("paragraph", null, [schema.text(text)]);
}

describe("scanNotes — document walk", () => {
    it("should surface text markers with positions that land on the marker", () => {
        const doc = schema.node("doc", null, [p("The survey had [TK] respondents")]);
        const items = scanNotes(doc);
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("placeholder");
        expect(doc.textBetween(items[0]!.from, items[0]!.to)).toBe("[TK]");
    });

    it("should NOT scan inside a code block", () => {
        const doc = schema.node("doc", null, [
            schema.node("code_block", null, [schema.text("TODO: this is code, not a task")]),
        ]);
        expect(scanNotes(doc)).toHaveLength(0);
    });

    it("should route an HTML comment by its TODO prefix and take the rest as label", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.node("html", { value: "<!-- TODO: rewrite this -->" })]),
        ]);
        const items = scanNotes(doc);
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("todo");
        expect(items[0]!.label).toBe("rewrite this");
    });

    it("a bare HTML comment should be a plain note", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.node("html", { value: "<!-- ask the source -->" })]),
        ]);
        const items = scanNotes(doc);
        expect(items[0]!.kind).toBe("comment");
        expect(items[0]!.label).toBe("ask the source");
    });

    it("should list an unchecked task item but not a checked or non-task one", () => {
        const doc = schema.node("doc", null, [
            schema.node("bullet_list", null, [
                schema.node("list_item", { checked: false }, [p("buy milk")]),
                schema.node("list_item", { checked: true }, [p("done thing")]),
                schema.node("list_item", { checked: null }, [p("plain bullet")]),
            ]),
        ]);
        const items = scanNotes(doc);
        const tasks = items.filter((i) => i.kind === "task");
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.label).toBe("buy milk");
    });

    it("should return every kind, document-ordered by position", () => {
        const doc = schema.node("doc", null, [
            p("lead [TK] para"),
            schema.node("bullet_list", null, [
                schema.node("list_item", { checked: false }, [p("do TODO: the thing")]),
            ]),
            schema.node("paragraph", null, [schema.node("html", { value: "<!-- FIXME: later -->" })]),
        ]);
        const items = scanNotes(doc);
        const froms = items.map((i) => i.from);
        expect([...froms]).toEqual([...froms].sort((a, b) => a - b));
        expect(items.map((i) => i.kind)).toContain("placeholder");
        expect(items.map((i) => i.kind)).toContain("task");
        expect(items.map((i) => i.kind)).toContain("todo");
        expect(items.map((i) => i.kind)).toContain("fixme");
    });
});
