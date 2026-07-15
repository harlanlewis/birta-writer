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
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { configureSerialization, pureCommonmark } from "../serialization";
import { listItemSpreadBoolPlugins } from "../plugins/list";

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
        .use(gfm)
        .use(listItemSpreadBoolPlugins)
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
