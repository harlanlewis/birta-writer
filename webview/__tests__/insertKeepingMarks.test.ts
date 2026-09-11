/**
 * What a ranged `insertText` does to a non-inclusive mark, driving the REAL
 * schema.
 *
 * `tr.insertText(text, from, to)` takes the new text node's marks from
 * `$from.marksAcross($to)`, which drops a mark whose spec is `inclusive: false`
 * unless it is also present at `to`. A range ending exactly at such a mark's end
 * boundary is where it is not, so replacing a whole marked run writes the
 * replacement unmarked: the code span or link is destroyed rather than moved,
 * and the user's backticks go with it.
 *
 * The control arm is load-bearing rather than decorative. It asserts upstream's
 * behaviour directly, so it says the fixture really does reach the hazard and
 * the helper is what saves it. If a future ProseMirror or Milkdown makes this
 * case safe on its own, the control fails and says so, which is the signal that
 * `utils/insertKeepingMarks.ts` has become redundant.
 *
 * The schema is the product's, not a hand-built one. A local schema is how this
 * class hides: `link` is only `inclusive: false` because plugins/linkBoundary.ts
 * says so, so a test schema that declares a plain `link` cannot reproduce any of
 * this and passes while the editor destroys the construct.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { insertTextKeepingMarks, replaceKeepingMarks } from "../utils/insertKeepingMarks";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Every text child of the first paragraph, with the marks it carries. */
function shape(v: EditorView): Array<{ text: string; marks: string[] }> {
    const out: Array<{ text: string; marks: string[] }> = [];
    v.state.doc.firstChild?.forEach((child) => {
        if (child.isText) {
            out.push({ text: child.text ?? "", marks: child.marks.map((m) => m.type.name) });
        }
    });
    return out;
}

/** The span of the one run carrying `mark`, as a document range. */
function runOf(v: EditorView, mark: string): { from: number; to: number } {
    let from = -1;
    let to = -1;
    v.state.doc.firstChild?.forEach((child, offset) => {
        if (child.isText && child.marks.some((m) => m.type.name === mark)) {
            from = offset + 1;
            to = from + (child.text?.length ?? 0);
        }
    });
    return { from, to };
}

afterEach(() => {
    editors.forEach((e) => e.destroy());
    editors = [];
});

describe("the hazard: a ranged insertText at a non-inclusive mark's boundary", () => {
    it("both marks in the blast radius should really be inclusive:false", async () => {
        // The premise every case below stands on. A bump that quietly reverted
        // either spec would make the rest of this file pass by vacuity.
        const v = await makeEditor("x");
        expect(v.state.schema.marks["inlineCode"]?.spec.inclusive).toBe(false);
        expect(v.state.schema.marks["link"]?.spec.inclusive).toBe(false);
    });

    it("a raw insertText over a whole code span should destroy the span", async () => {
        const v = await makeEditor("a `code` b");
        const { from, to } = runOf(v, "inlineCode");
        v.dispatch(v.state.tr.insertText("XY", from, to));
        expect(shape(v)).toEqual([{ text: "a XY b", marks: [] }]);
    });

    it("a raw insertText over a whole link's text should destroy the link", async () => {
        const v = await makeEditor("a [text](http://x) b");
        const { from, to } = runOf(v, "link");
        v.dispatch(v.state.tr.insertText("XY", from, to));
        expect(shape(v)).toEqual([{ text: "a XY b", marks: [] }]);
    });
});

describe("insertTextKeepingMarks", () => {
    it("a replacement over a whole code span should stay inside the span", async () => {
        const v = await makeEditor("a `code` b");
        const { from, to } = runOf(v, "inlineCode");
        v.dispatch(insertTextKeepingMarks(v.state.tr, "XY", from, to));
        expect(shape(v)).toEqual([
            { text: "a ", marks: [] },
            { text: "XY", marks: ["inlineCode"] },
            { text: " b", marks: [] },
        ]);
    });

    it("a replacement over a whole link's text should keep the link and its href", async () => {
        const v = await makeEditor("a [text](http://x) b");
        const { from, to } = runOf(v, "link");
        v.dispatch(insertTextKeepingMarks(v.state.tr, "XY", from, to));
        expect(shape(v)).toEqual([
            { text: "a ", marks: [] },
            { text: "XY", marks: ["link"] },
            { text: " b", marks: [] },
        ]);
        const linked = v.state.doc.firstChild?.child(1);
        expect(linked?.marks[0]?.attrs["href"]).toBe("http://x");
    });

    it("a replacement over part of a run should behave as it always did", async () => {
        // The unchanged case: `to` still carries the mark, so upstream's own
        // derivation already kept it. Here to pin that the helper did not
        // change the ordinary path while fixing the boundary one.
        const v = await makeEditor("a `code` b");
        const { from } = runOf(v, "inlineCode");
        v.dispatch(insertTextKeepingMarks(v.state.tr, "X", from, from + 2));
        expect(shape(v)).toEqual([
            { text: "a ", marks: [] },
            { text: "Xde", marks: ["inlineCode"] },
            { text: " b", marks: [] },
        ]);
    });

    it("several replacements in one transaction should each keep their own marks", async () => {
        // Stored marks are nulled once a step is applied, so a batch caller has
        // to come back through the helper for every range. Replace-all in the
        // find bar is this shape, and a helper that set them once would mark
        // only the first replacement.
        const v = await makeEditor("`one` and [two](http://x)");
        const code = runOf(v, "inlineCode");
        const link = runOf(v, "link");
        let tr = v.state.tr;
        // Reverse document order, so the earlier range's positions stay valid.
        tr = insertTextKeepingMarks(tr, "TWO", link.from, link.to);
        tr = insertTextKeepingMarks(tr, "ONE", code.from, code.to);
        v.dispatch(tr);
        expect(shape(v)).toEqual([
            { text: "ONE", marks: ["inlineCode"] },
            { text: " and ", marks: [] },
            { text: "TWO", marks: ["link"] },
        ]);
    });

    it("a replacement should not leave stored marks on the user's next keystroke", async () => {
        const v = await makeEditor("a `code` b");
        const { from, to } = runOf(v, "inlineCode");
        v.dispatch(insertTextKeepingMarks(v.state.tr, "XY", from, to));
        expect(v.state.storedMarks).toBe(null);
    });
});

describe("replaceKeepingMarks", () => {
    it("the dispatching form should keep the span the transaction form keeps", async () => {
        const v = await makeEditor("a `code` b");
        const { from, to } = runOf(v, "inlineCode");
        replaceKeepingMarks(v, from, to, "XY");
        expect(shape(v)).toEqual([
            { text: "a ", marks: [] },
            { text: "XY", marks: ["inlineCode"] },
            { text: " b", marks: [] },
        ]);
    });
});
