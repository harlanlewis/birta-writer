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
 * Root cause guarded here: Milkdown's list schemas stored the `spread` attr as
 * a STRING ("true"/"false"); mdast-util-to-markdown only tightens output when
 * `spread` is a real boolean, so the string always fell through to the loose
 * separator. The list-schema overrides (plugins/list.ts) now parse `spread` as
 * a real boolean, so a freshly parsed doc is schema-valid (MAR-124) and tight
 * lists stay tight by construction; the fidelity serializer's coercion remains
 * as defense for the string form written by Milkdown's edit-time plugins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

async function roundTrip(markdown: string): Promise<string> {
    const editor = await makeEditor(markdown);
    // Touch the view so the doc is fully built before serializing.
    editor.action((ctx) => ctx.get(editorViewCtx));
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

/** The freshly parsed ProseMirror doc for `markdown` (no edits applied). */
async function parseDoc(markdown: string): Promise<ProseNode> {
    const editor = await makeEditor(markdown);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx)).state.doc as ProseNode;
    await editor.destroy();
    return doc;
}

/** typeof the `spread` attr of the first node of `typeName`, or "" if absent. */
function spreadTypeOf(doc: ProseNode, typeName: string): string {
    let found = "";
    doc.descendants((node) => {
        if (found === "" && node.type.name === typeName) {
            found = typeof node.attrs["spread"];
        }
        return found === "";
    });
    return found;
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

    it("a tight ordered item with a nested sub-list should not gain a blank line (MAR-87)", async () => {
        // The exact regression: an ordered item followed by its nested ordered
        // sub-list used to gain a blank line between them on save (string
        // `spread` loosening the list), a byte-level round-trip break.
        const doc =
            "1. First step\n2. Second step\n   1. Sub-step a\n   2. Sub-step b\n3. Third step\n";
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

describe("partly-loose lists keep each gap as authored (MAR-194)", () => {
    // mdast has ONE `spread` boolean per list, so a list with a single interior
    // blank line parses as fully loose and used to re-emit a blank line between
    // EVERY item. The gap survives parsing as each item's source `position`,
    // which plugins/list.ts records per item and the serializer's join reads
    // back. These take the RAW serializer output, so they prove the gaps are
    // right BY CONSTRUCTION rather than pinned by minimal-diff at save time.

    it("a list with one interior blank line should round-trip byte-identically", async () => {
        const doc = "- foo\n- bar\n- baz\n\n- bingo\n- wingo\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("two lists differing ONLY in where the blank line sits should stay distinct", async () => {
        // The sharpest form of the bug: these parse to identical mdast trees
        // (list.spread true, every item spread false), so before the per-gap
        // fix they serialized to the same fully-loose bytes and one of the two
        // files was silently rewritten into the other.
        const blankEarly = "- a\n\n- b\n- c\n";
        const blankLate = "- a\n- b\n\n- c\n";
        expect(await roundTrip(blankEarly)).toBe(blankEarly);
        expect(await roundTrip(blankLate)).toBe(blankLate);
    });

    it("the partly-loose corpus fixture should serialize back byte-identically", async () => {
        // The corpus gates (roundTripCorpus / corpusMoveSampling) do NOT catch
        // this class: invariant A is a zero-edit save, which minimal-diff's
        // round-trip protection absorbs, and invariant B only checks that
        // significant lines survive — never where a blank line sits. So the
        // fixture is held to the RAW serializer here, which is the layer the
        // bug actually lives in. Verified to fail without the per-gap join.
        const fixture = readFileSync(
            join(__dirname, "fixtures", "partly-loose-lists.md"),
            "utf8",
        );
        expect(await roundTrip(fixture)).toBe(fixture);
    });

    it("a partly-loose ordered list should keep its gap in place", async () => {
        const doc = "1. one\n2. two\n\n3. three\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a partly-loose nested list should keep the nested gap too", async () => {
        // The sub-list needs THREE items to be partly loose: a two-item list has
        // a single gap, which list-level `spread` already describes exactly.
        const doc = "- parent\n  - child one\n  - child two\n\n  - child three\n- sibling\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a fully tight and a fully loose list should still round-trip unchanged", async () => {
        // The per-gap join must not disturb the uniform cases it now also owns.
        expect(await roundTrip("- a\n- b\n- c\n")).toBe("- a\n- b\n- c\n");
        expect(await roundTrip("- a\n\n- b\n\n- c\n")).toBe("- a\n\n- b\n\n- c\n");
    });
});

describe("freshly parsed lists carry a boolean spread attr (MAR-124)", () => {
    // Milkdown's stock runners stored `spread` as the STRING "true"/"false",
    // which fails the schema's own `validate: "boolean"` on every parsed list
    // — so doc.check() threw before a single edit. The list-schema overrides
    // (plugins/list.ts) coerce it to a real boolean at parse time.
    it("a doc with a bullet list passes doc.check()", async () => {
        const doc = await parseDoc("- a\n- b\n\nAfter.\n");
        expect(() => doc.check()).not.toThrow();
    });

    it("a doc with an ordered list passes doc.check()", async () => {
        const doc = await parseDoc("1. one\n2. two\n");
        expect(() => doc.check()).not.toThrow();
    });

    it("a doc with a loose list and nested sublist passes doc.check()", async () => {
        const doc = await parseDoc("- a\n\n- b\n  - nested\n  - nested two\n");
        expect(() => doc.check()).not.toThrow();
    });

    it("stores bullet_list and list_item spread as real booleans", async () => {
        const doc = await parseDoc("- a\n\n- b\n"); // loose → spread true
        expect(spreadTypeOf(doc, "bullet_list")).toBe("boolean");
        expect(spreadTypeOf(doc, "list_item")).toBe("boolean");
    });

    it("stores ordered_list spread as a real boolean", async () => {
        const doc = await parseDoc("1. one\n2. two\n");
        expect(spreadTypeOf(doc, "ordered_list")).toBe("boolean");
    });
});
