/**
 * MAR-360: an invisible top-level paragraph (empty, or hardbreak-only) must
 * serialize to NOTHING, because whatever it emits reaches the saved file and
 * blank-line residue is permanent — a blank-line-only difference is
 * deliberately invisible to the minimal-diff merge, so no later sync can take
 * the blanks back out.
 *
 * The reported gesture: add a paragraph under a heading, delete it, save.
 * The poison sync is the INTERMEDIATE one, landing while the emptied
 * paragraph node still exists (mid-backspace): the stock serializer emitted
 * the empty node as two blank lines, the merge faithfully wrote them, and the
 * final (clean) serialization could no longer remove them. See
 * plugins/invisibleParagraph.ts for the fix and its root-only scope.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx, serializerCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { loadCorpusFixtures, makeCorpusEditor as makeEditor } from "./helpers/moveFuzz";

function view(editor: Awaited<ReturnType<typeof makeEditor>>): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
}

/** Insert an empty paragraph node at `pos` and return the serialization. */
async function serializedWithEmptyParaAt(content: string, pos: number): Promise<string> {
    const editor = await makeEditor(content);
    const v = view(editor);
    v.dispatch(v.state.tr.insert(pos, v.state.schema.nodes.paragraph.createChecked(null)));
    return editor.action(getMarkdown());
}

describe("invisible top-level paragraphs serialize to nothing (MAR-360)", () => {
    it("an empty paragraph between two paragraphs should add no bytes", async () => {
        const content = "para1\n\npara2\n";
        const editor = await makeEditor(content);
        const v = view(editor);
        const clean = editor.action(getMarkdown());
        v.dispatch(v.state.tr.insert(v.state.doc.child(0).nodeSize, v.state.schema.nodes.paragraph.createChecked(null)));

        expect(editor.action(getMarkdown())).toBe(clean);
    });

    it("an empty paragraph at document start should add no bytes", async () => {
        expect(await serializedWithEmptyParaAt("para1\n\npara2\n", 0)).toBe("para1\n\npara2\n");
    });

    it("an empty paragraph at document end should add no bytes", async () => {
        const content = "para1\n\npara2\n";
        const editor = await makeEditor(content);
        const v = view(editor);
        v.dispatch(v.state.tr.insert(v.state.doc.content.size, v.state.schema.nodes.paragraph.createChecked(null)));

        expect(editor.action(getMarkdown())).toBe(content);
    });

    it("stacked empty paragraphs should add no bytes", async () => {
        const content = "para1\n\npara2\n";
        const editor = await makeEditor(content);
        const v = view(editor);
        const at = v.state.doc.child(0).nodeSize;
        v.dispatch(v.state.tr.insert(at, v.state.schema.nodes.paragraph.createChecked(null)));
        v.dispatch(v.state.tr.insert(at, v.state.schema.nodes.paragraph.createChecked(null)));

        expect(editor.action(getMarkdown())).toBe(content);
    });

    it("a hardbreak-only paragraph should add no bytes", async () => {
        const content = "para1\n\npara2\n";
        const editor = await makeEditor(content);
        const v = view(editor);
        const schema = v.state.schema;
        const hb = schema.nodes.paragraph.createChecked(null, schema.nodes.hardbreak.create());
        v.dispatch(v.state.tr.insert(v.state.doc.child(0).nodeSize, hb));

        expect(editor.action(getMarkdown())).toBe(content);
    });

    it("a document holding only an empty paragraph should keep its stock serialization", async () => {
        // The degenerate family the drop must stand down for: with every
        // top-level block invisible there is nothing left to carry the mdast
        // root, and remark-stringify's root handler crashes on a childless
        // root. The empty-file shape keeps today's bytes.
        const editor = await makeEditor("");
        // A fresh empty document IS one empty paragraph; the drop stands
        // down and the stock spelling ("") survives.
        expect(editor.action(getMarkdown())).toBe("");

        // Still all-invisible with two: stock spelling again ("\n\n"), and
        // above all no childless-root crash in remark's root handler.
        const v = view(editor);
        v.dispatch(v.state.tr.insert(0, v.state.schema.nodes.paragraph.createChecked(null)));
        expect(editor.action(getMarkdown())).toBe("\n\n");
    });

    it("serializing an all-invisible doc while the VIEW holds content should not throw", async () => {
        // The stand-down must be judged from the doc being serialized, not
        // from the live view. `getProtection` serializes the baseline
        // snapshot while the view holds the user's edits (editor.ts), so on a
        // file opened empty and then typed into, a view-based verdict would
        // drop this doc's only paragraph, leave mdast's root childless, and
        // throw inside getProtection's catch — silently costing the session
        // its round-trip protection.
        const editor = await makeEditor("visible content\n");
        const schema = view(editor).state.schema;
        const foreign = schema.nodes.doc.createChecked(null, [
            schema.nodes.paragraph.createChecked(null),
        ]);

        const serialize = () => editor.action((ctx) => ctx.get(serializerCtx)(foreign));

        expect(serialize).not.toThrow();
        expect(serialize()).toBe("");
    });

    it("serializing a doc with content while the VIEW is all-invisible should still drop", async () => {
        // The same read, in the direction that would silently keep residue.
        const editor = await makeEditor("");
        const schema = view(editor).state.schema;
        const foreign = schema.nodes.doc.createChecked(null, [
            schema.nodes.paragraph.createChecked(null, schema.text("kept")),
            schema.nodes.paragraph.createChecked(null),
            schema.nodes.paragraph.createChecked(null, schema.text("also kept")),
        ]);

        expect(editor.action((ctx) => ctx.get(serializerCtx)(foreign)))
            .toBe("kept\n\nalso kept\n");
    });

    it("a paragraph with text should still serialize (the guard discriminates)", async () => {
        const content = "para1\n\npara2\n";
        const editor = await makeEditor(content);
        const v = view(editor);
        const schema = v.state.schema;
        const p = schema.nodes.paragraph.createChecked(null, schema.text("kept"));
        v.dispatch(v.state.tr.insert(v.state.doc.child(0).nodeSize, p));

        expect(editor.action(getMarkdown())).toBe("para1\n\nkept\n\npara2\n");
    });

    it("an empty paragraph inside a list item should stay on the item's measured spelling", async () => {
        // Root-only scope: an item's empty paragraph belongs to
        // itemContentGapJoin's policy (MAR-306/MAR-309) — glued, so the item
        // keeps its grip on the block that follows — not to this drop. The
        // full spelling matrix lives in tightItemSpacing.test.ts; this pins
        // the one shape whose bytes would change if the root-only guard were
        // widened: the item must NOT collapse to `- world` (drop applied),
        // and `world` must stay in the item.
        const editor = await makeEditor("- placeholder\n");
        const v = view(editor);
        let itemPara = -1;
        v.state.doc.descendants((node, pos) => {
            if (node.type.name === "paragraph" && node.textContent === "placeholder") { itemPara = pos; return false; }
            return true;
        });
        expect(itemPara).toBeGreaterThan(-1);
        // Empty the item's paragraph, then append a real paragraph after it
        // inside the same item: [empty para, "world" para].
        const schema = v.state.schema;
        v.dispatch(v.state.tr.delete(itemPara + 1, itemPara + 1 + "placeholder".length));
        v.dispatch(v.state.tr.insert(itemPara + 2, schema.nodes.paragraph.createChecked(null, schema.text("world"))));

        expect(editor.action(getMarkdown())).toBe("-\n  world\n");
    });
});

describe("the reported gesture — add then delete under ## Footnotes (MAR-360)", () => {
    const fixture = loadCorpusFixtures().find((f) => f.name === "samples/content-inventory.md (body)")!;

    it("with a sync landing mid-delete, the file should come back byte-identical", async () => {
        const content = fixture.content;
        const editor = await makeEditor(content);
        const s0 = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(content, s0);
        const v = view(editor);

        let headingEnd = -1;
        v.state.doc.descendants((node, pos) => {
            if (node.type.name === "heading" && node.textContent === "Footnotes") {
                headingEnd = pos + node.nodeSize;
                return false;
            }
            return true;
        });
        expect(headingEnd).toBeGreaterThan(-1);

        const schema = v.state.schema;
        const para = schema.nodes.paragraph.createChecked(null, schema.text("temporary paragraph"));
        v.dispatch(v.state.tr.insert(headingEnd, para));

        // Sync 1: paragraph present.
        const m1 = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
        expect(m1).toContain("temporary paragraph");

        // The user backspaces the text; a sync lands while the emptied node
        // still exists. This is the sync that used to write the blank lines.
        v.dispatch(v.state.tr.delete(headingEnd + 1, headingEnd + 1 + "temporary paragraph".length));
        const m15 = applyMinimalChanges(m1, editor.action(getMarkdown()), protection);

        // The last backspace removes the node; the final sync must restore
        // the original bytes exactly.
        v.dispatch(v.state.tr.delete(headingEnd, headingEnd + v.state.doc.nodeAt(headingEnd)!.nodeSize));
        const s2 = editor.action(getMarkdown());
        const m2 = applyMinimalChanges(m15, s2, protection);

        expect(s2).toBe(s0);
        expect(m2).toBe(content);
    });

    it("deleting the whole paragraph in one gesture should also come back byte-identical", async () => {
        const content = fixture.content;
        const editor = await makeEditor(content);
        const s0 = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(content, s0);
        const v = view(editor);

        let headingEnd = -1;
        v.state.doc.descendants((node, pos) => {
            if (node.type.name === "heading" && node.textContent === "Footnotes") {
                headingEnd = pos + node.nodeSize;
                return false;
            }
            return true;
        });
        const schema = v.state.schema;
        const para = schema.nodes.paragraph.createChecked(null, schema.text("temporary paragraph"));
        v.dispatch(v.state.tr.insert(headingEnd, para));
        const m1 = applyMinimalChanges(content, editor.action(getMarkdown()), protection);

        v.dispatch(v.state.tr.delete(headingEnd, headingEnd + para.nodeSize));
        const s2 = editor.action(getMarkdown());
        const m2 = applyMinimalChanges(m1, s2, protection);

        expect(s2).toBe(s0);
        expect(m2).toBe(content);
    });
});
