/**
 * The touched-range helper every edit-proportional decoration plugin reads
 * (MAR-431): the top-level blocks a transaction touched, found from the
 * transaction's own steps and never by walking the document.
 *
 * Two things must hold and both are asserted: the blocks it names are
 * exactly the ones an edit could have changed (typing names one, a split or
 * a join names both neighbours, a paste names the pasted span), and the
 * count it reports is the same on a small document and a large one whose
 * only difference is size.
 */
import { describe, it, expect } from "vitest";
import { Fragment } from "../pm";
import { forEachTouchedTopLevel, touchedRanges } from "../plugins/editRanges";
import { makeCorpusEditor } from "./helpers/moveFuzz";
import { editorViewCtx } from "@milkdown/core";

function paragraphs(n: number): string {
    return Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the document.`).join("\n\n") + "\n";
}

async function withView<T>(markdown: string, fn: (view: ReturnType<typeof viewOf>) => T): Promise<T> {
    const editor = await makeCorpusEditor(markdown);
    try {
        return fn(viewOf(editor));
    } finally {
        await editor.destroy();
    }
}
const viewOf = (editor: Awaited<ReturnType<typeof makeCorpusEditor>>) => editor.action((ctx) => ctx.get(editorViewCtx));

/** The indexes `forEachTouchedTopLevel` names for a transaction. */
function touchedIndexes(tr: Parameters<typeof touchedRanges>[0]): number[] {
    const out: number[] = [];
    forEachTouchedTopLevel(tr.doc, touchedRanges(tr), (_node, _pos, index) => out.push(index));
    return out;
}

describe("forEachTouchedTopLevel", () => {
    it("typing inside one paragraph should name that paragraph alone", async () => {
        await withView(paragraphs(5), (view) => {
            const third = view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize + 3;
            const tr = view.state.tr.insertText("x", third);
            expect(touchedIndexes(tr)).toEqual([2]);
        });
    });

    it("splitting a paragraph should name both halves, and joining should name the joined block", async () => {
        await withView(paragraphs(3), (view) => {
            const inside = view.state.doc.child(0).nodeSize + 5;
            const split = view.state.tr.split(inside);
            expect(touchedIndexes(split)).toEqual([1, 2]);
            const joinAt = view.state.doc.child(0).nodeSize;
            const join = view.state.tr.join(joinAt);
            expect(touchedIndexes(join)).toEqual([0]);
        });
    });

    it("a paste of several blocks should name the pasted span and its neighbours at the seams", async () => {
        await withView(paragraphs(4), (view) => {
            const schema = view.state.schema;
            const pasted = Fragment.from([
                schema.nodes.paragraph.create(null, schema.text("A")),
                schema.nodes.paragraph.create(null, schema.text("B")),
            ]);
            const at = view.state.doc.child(0).nodeSize;
            const tr = view.state.tr.insert(at, pasted);
            expect(touchedIndexes(tr)).toEqual([0, 1, 2, 3]);
        });
    });

    it("deleting a whole block should name the blocks now meeting at the cut", async () => {
        await withView(paragraphs(4), (view) => {
            const from = view.state.doc.child(0).nodeSize;
            const to = from + view.state.doc.child(1).nodeSize;
            const tr = view.state.tr.delete(from, to);
            expect(touchedIndexes(tr)).toEqual([0, 1]);
        });
    });

    it("the count should not grow with the document", async () => {
        const small = await withView(paragraphs(4), (view) => touchedIndexes(view.state.tr.insertText("x", 3)).length);
        const large = await withView(paragraphs(400), (view) => touchedIndexes(view.state.tr.insertText("x", 3)).length);
        expect(small).toBe(1);
        expect(large).toBe(small);
    });

    it("a transaction with no steps should name nothing", async () => {
        await withView(paragraphs(2), (view) => {
            expect(touchedIndexes(view.state.tr)).toEqual([]);
        });
    });
});
