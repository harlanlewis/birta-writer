import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { singleTextblockInlineEdit } from "../utils/textblockEdit";

/**
 * The shared single-textblock-inline-edit localizer (used by the Contents
 * outline fast-path and the Notes incremental scan). It observes two real docs
 * and reports whether the whole change fits inside one textblock's inline
 * content — the shape of ordinary typing.
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
        bullet_list: { group: "block", content: "list_item+" },
        list_item: { content: "paragraph block*" },
        text: { group: "inline" },
    },
});

const p = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
const h = (level: number, t: string) => schema.node("heading", { level }, [schema.text(t)]);
const docOf = (...blocks: ReturnType<typeof p>[]) => schema.node("doc", null, blocks);

describe("singleTextblockInlineEdit", () => {
    it("identical docs should report kind identical", () => {
        const a = docOf(p("hello"), p("world"));
        const b = docOf(p("hello"), p("world"));
        expect(singleTextblockInlineEdit(a, b)).toEqual({ kind: "identical" });
    });

    it("inserting into one paragraph should localize to that block with the right delta", () => {
        const a = docOf(p("intro"), h(1, "Title"), p("body"));
        const b = docOf(p("intro!!"), h(1, "Title"), p("body"));
        const edit = singleTextblockInlineEdit(a, b);
        expect(edit?.kind).toBe("inline");
        if (edit?.kind !== "inline") { return; }
        expect(edit.delta).toBe(2);
        // The edited block is the first paragraph; the heading after it must shift.
        expect(edit.prevBlock.type.name).toBe("paragraph");
        expect(edit.nextBlockPos).toBe(edit.prevBlockPos);
    });

    it("editing a heading's text should still localize (caller applies the heading policy)", () => {
        const a = docOf(p("intro"), h(1, "Title"));
        const b = docOf(p("intro"), h(1, "Titles"));
        const edit = singleTextblockInlineEdit(a, b);
        expect(edit?.kind).toBe("inline");
        if (edit?.kind !== "inline") { return; }
        expect(edit.nextBlock.type.name).toBe("heading");
    });

    it("splitting a paragraph into two should NOT localize (structural change)", () => {
        const a = docOf(p("one two"));
        const b = docOf(p("one"), p("two"));
        expect(singleTextblockInlineEdit(a, b)).toBeNull();
    });

    it("inserting a whole new block should NOT localize", () => {
        const a = docOf(p("one"), p("two"));
        const b = docOf(p("one"), p("inserted"), p("two"));
        expect(singleTextblockInlineEdit(a, b)).toBeNull();
    });

    it("an edit spanning two blocks should NOT localize", () => {
        const a = docOf(p("aaa"), p("bbb"));
        const b = docOf(p("aXa"), p("bYb"));
        expect(singleTextblockInlineEdit(a, b)).toBeNull();
    });

    it("editing inside a nested list-item paragraph should localize to that paragraph", () => {
        const item = (t: string) => schema.node("list_item", null, [p(t)]);
        const a = schema.node("doc", null, [schema.node("bullet_list", null, [item("milk"), item("eggs")])]);
        const b = schema.node("doc", null, [schema.node("bullet_list", null, [item("milk!"), item("eggs")])]);
        const edit = singleTextblockInlineEdit(a, b);
        expect(edit?.kind).toBe("inline");
        if (edit?.kind !== "inline") { return; }
        expect(edit.nextBlock.type.name).toBe("paragraph");
        expect(edit.delta).toBe(1);
    });
});
