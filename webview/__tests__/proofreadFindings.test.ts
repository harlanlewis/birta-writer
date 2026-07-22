import { describe, it, expect } from "vitest";
import { Schema, Decoration, DecorationSet } from "../pm";
import { describeFindings } from "../plugins/proofread";

/**
 * The review sidebar's Proofreading resolver (MAR-188): describeFindings turns
 * the plugin's `combined` decoration set into the flat, document-ordered rows
 * the tab renders — the "decorations → sorted items" logic the ticket called
 * for. Exercised against hand-built DecorationSets (the same shape the real
 * plugin emits: a `lint` or `style` spec), so the ordering / dedup / routing is
 * covered without standing up a live editor.
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
    marks: {},
});

// A paragraph long enough that every decoration position below is in range.
const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("x".repeat(80))]),
]);

function lint(from: number, to: number, kind: string, message = "msg") {
    return Decoration.inline(from, to, { class: "pf-lint-err" }, {
        class: "pf-lint-err",
        lint: { start: 0, end: to - from, kind, message, suggestions: [] },
    });
}

function style(from: number, to: number, category: string, message = "msg") {
    return Decoration.inline(from, to, { class: "pf-style-hit" }, {
        class: "pf-style-hit",
        style: { category, message, suggestion: null },
    });
}

function describe_(...decos: Decoration[]) {
    return describeFindings(DecorationSet.create(doc, decos), (from, to) => `[${from},${to}]`);
}

describe("describeFindings — ordering", () => {
    it("out-of-order decorations should come back in document order", () => {
        const rows = describe_(style(30, 34, "fillers"), lint(5, 9, "Spelling"), style(15, 19, "cliches"));
        expect(rows.map((r) => r.from)).toEqual([5, 15, 30]);
    });

    it("at a shared start, the narrower span should come first", () => {
        const rows = describe_(lint(10, 20, "Grammar"), style(10, 14, "fillers"));
        expect(rows.map((r) => [r.from, r.to])).toEqual([[10, 14], [10, 20]]);
    });
});

describe("describeFindings — dedup", () => {
    it("two findings sharing (from, to, kind) should collapse to one", () => {
        const rows = describe_(style(10, 16, "fillers"), style(10, 16, "fillers"));
        expect(rows).toHaveLength(1);
    });

    it("a spelling and a style hit on the same span should both survive", () => {
        const rows = describe_(lint(10, 16, "Spelling"), style(10, 16, "fillers"));
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.domain).sort()).toEqual(["spelling", "style"]);
    });
});

describe("describeFindings — routing", () => {
    it("a Spelling lint should be learnable and tagged Spelling", () => {
        const [row] = describe_(lint(3, 8, "Spelling"));
        expect(row!.domain).toBe("spelling");
        expect(row!.canLearn).toBe(true);
        expect(row!.tag).toBe("Spelling");
        expect(row!.kind).toBe("Spelling");
    });

    it("a non-spelling lint should be grammar and not learnable", () => {
        const [row] = describe_(lint(3, 8, "Grammar"));
        expect(row!.domain).toBe("grammar");
        expect(row!.canLearn).toBe(false);
    });

    it("a style hit should be domain style and never learnable", () => {
        const [row] = describe_(style(3, 8, "fillers"));
        expect(row!.domain).toBe("style");
        expect(row!.canLearn).toBe(false);
        expect(row!.kind).toBe("fillers");
    });
});

describe("describeFindings — text + filtering", () => {
    it("the flagged text should be pulled from getText for the finding's range", () => {
        const [row] = describe_(lint(4, 9, "Spelling"));
        expect(row!.text).toBe("[4,9]");
    });

    it("a decoration with neither a lint nor a style spec should be ignored", () => {
        const bare = Decoration.inline(4, 9, { class: "whatever" }, { class: "whatever" });
        expect(describe_(bare)).toHaveLength(0);
    });
});
