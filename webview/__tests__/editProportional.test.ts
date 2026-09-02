/**
 * The edit-proportional paths MAR-431 added, each held to the whole-document
 * computation it replaces: after any edit, mapping the old set and redoing
 * only the touched blocks must equal rebuilding the set from the new
 * document. The full walk is the reference, so this is a differential with a
 * real oracle rather than the same function fed the same input twice.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { Fragment, type Transaction } from "../pm";
import { computeImageBlockDecorations, updateImageBlockDecorations } from "../plugins/imageBlocks";
import { singleTopLevelBlockEdit } from "../utils/textblockEdit";
import { makeCorpusEditor } from "./helpers/moveFuzz";

const DOC = [
    "# Title",
    "",
    "![one](a.png)",
    "",
    "A paragraph of prose.",
    "",
    "![two](b.png)",
    "",
    "- item",
    "",
    "Last paragraph.",
    "",
].join("\n");

async function withView<T>(fn: (view: ReturnType<typeof viewOf>) => T): Promise<T> {
    const editor = await makeCorpusEditor(DOC);
    try {
        return fn(viewOf(editor));
    } finally {
        await editor.destroy();
    }
}
const viewOf = (editor: Awaited<ReturnType<typeof makeCorpusEditor>>) => editor.action((ctx) => ctx.get(editorViewCtx));

/** Every decoration as `[from, to, class]`, sorted, so two sets compare by content. */
function shape(set: ReturnType<typeof computeImageBlockDecorations>): string[] {
    return set
        .find()
        .map((d) => `${d.from}-${d.to}:${(d.spec as { class?: string }).class ?? (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`)
        .sort();
}

describe("updateImageBlockDecorations against the full walk", () => {
    const edits: Array<[string, (view: ReturnType<typeof viewOf>) => Transaction]> = [
        ["typing in the prose paragraph", (v) => v.state.tr.insertText("x", v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize + 2)],
        ["typing in the title", (v) => v.state.tr.insertText("x", 2)],
        ["deleting the first image block", (v) => {
            const from = v.state.doc.child(0).nodeSize;
            return v.state.tr.delete(from, from + v.state.doc.child(1).nodeSize);
        }],
        ["inserting a new image block after the title", (v) => {
            const { schema } = v.state;
            const img = schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: "c.png" }));
            return v.state.tr.insert(v.state.doc.child(0).nodeSize, Fragment.from(img));
        }],
        ["turning the prose paragraph into an image block", (v) => {
            const pos = v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize;
            const node = v.state.doc.child(2);
            const { schema } = v.state;
            return v.state.tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: "d.png" })));
        }],
        ["splitting the prose paragraph", (v) => v.state.tr.split(v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize + 3)],
    ];

    for (const [name, make] of edits) {
        it(`${name} should leave the mapped set equal to a rebuild`, async () => {
            await withView((view) => {
                const before = computeImageBlockDecorations(view.state);
                expect(before.find().length).toBeGreaterThan(0);
                const tr = make(view);
                expect(tr.docChanged).toBe(true);
                const next = view.state.apply(tr);
                const updated = updateImageBlockDecorations(before, tr);
                const rebuilt = computeImageBlockDecorations(next);
                expect(shape(updated)).toEqual(shape(rebuilt));
            });
        });
    }
});

describe("singleTopLevelBlockEdit", () => {
    it("typing in a heading followed by an attr restamp should still name that one block", async () => {
        await withView((view) => {
            const typed = view.state.apply(view.state.tr.insertText("x", 2));
            const heading = typed.doc.child(0);
            const restamped = typed.apply(typed.tr.setNodeMarkup(0, undefined, { ...heading.attrs, id: "restamped" }));
            const edit = singleTopLevelBlockEdit(view.state.doc, restamped.doc);
            expect(edit).not.toBeNull();
            expect(edit!.index).toBe(0);
            expect(edit!.prevBlock.type.name).toBe("heading");
            expect(edit!.nextBlock.textContent).toBe("Txitle");
            expect(edit!.delta).toBe(1);
        });
    });

    it("a change spanning two blocks should be refused", async () => {
        await withView((view) => {
            const from = view.state.doc.child(0).nodeSize - 1;
            const next = view.state.apply(view.state.tr.delete(from, from + 2));
            expect(singleTopLevelBlockEdit(view.state.doc, next.doc)).toBeNull();
        });
    });

    it("identical documents should be refused rather than reported as an edit", async () => {
        await withView((view) => {
            expect(singleTopLevelBlockEdit(view.state.doc, view.state.doc)).toBeNull();
        });
    });
});
