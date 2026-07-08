/**
 * List tightness (spread) round-trip fidelity (MAR-48).
 *
 * A tight list (no blank lines between items) must serialize back tight, and a
 * genuinely loose list (blank lines between items) must serialize back loose —
 * top-level, inside a blockquote, and inside directives/asides alike. These
 * run the REAL Milkdown editor with the production serialization config and
 * take the RAW serializer output (no minimalDiff protection), so they prove
 * tightness is preserved BY CONSTRUCTION rather than pinned at load time.
 *
 * Root cause guarded here: Milkdown's list schemas store the `spread` attr as
 * a STRING ("true"/"false"); mdast-util-to-markdown only tightens output when
 * `spread` is a real boolean, so the string always fell through to the loose
 * separator. The fidelity serializer now coerces it back to a boolean.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";

async function roundTrip(markdown: string): Promise<string> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
    // Touch the view so the doc is fully built before serializing.
    editor.action((ctx) => ctx.get(editorViewCtx));
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

describe("tight lists stay tight on a raw round trip", () => {
    it("a top-level tight bullet list should not gain blank lines", async () => {
        const doc = "- item\n- item two\n\nAfter.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a top-level tight ordered list should not gain blank lines", async () => {
        const doc = "1. one\n2. two\n3. three\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight list inside a blockquote should not gain blank lines", async () => {
        const doc = "> - item\n> - item two\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight list inside a directive should not gain blank lines", async () => {
        const doc = ":::note\n\n- item\n- item two\n\n:::\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight list inside an aside should not gain blank lines", async () => {
        const doc = "<aside>\n💡 Lead.\n\n- item\n- item two\n\n</aside>\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a tight nested list should keep the nested items tight", async () => {
        const doc = "- parent\n  - child one\n  - child two\n- sibling\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("loose lists stay loose on a raw round trip (no over-correction)", () => {
    it("a top-level loose bullet list should keep its blank lines", async () => {
        const doc = "- a\n\n- b\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a loose ordered list should keep its blank lines", async () => {
        const doc = "1. one\n\n2. two\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a list item with two paragraphs should keep the inner blank line", async () => {
        const doc = "- first paragraph\n\n  second paragraph\n\n- next item\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});
