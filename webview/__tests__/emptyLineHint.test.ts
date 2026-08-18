/**
 * Tests for the empty-line hint decoration: which paragraph earns it, and the
 * standing rule that one character of content — `/` included — removes it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { NodeSelection, TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { emptyLineHintDecorations, emptyLineHintDom } from "../plugins/emptyLineHint";

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

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/** The decorated ranges, as `[from, to]` pairs, for the view's current state. */
function decorated(view: EditorView): Array<[number, number]> {
    return emptyLineHintDecorations(view.state)
        .find()
        .map((d) => [d.from, d.to] as [number, number]);
}

/** Appends an empty paragraph at `pos` and puts the caret inside it. */
function addEmptyParagraphAt(view: EditorView, pos: number): number {
    const paragraph = view.state.schema.nodes.paragraph!;
    const tr = view.state.tr.insert(pos, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    view.dispatch(tr);
    return pos;
}

/** Types `text` at the caret. */
function type(view: EditorView, text: string): void {
    view.dispatch(view.state.tr.insertText(text));
}

describe("emptyLineHintDecorations", () => {
    it("a caret in an empty top-level paragraph should decorate that paragraph", async () => {
        const view = await makeEditor("first");
        const pos = addEmptyParagraphAt(view, view.state.doc.content.size);

        // The paragraph, then the widget inside it.
        expect(decorated(view)).toEqual([[pos, pos + 2], [pos + 1, pos + 1]]);
    });

    it("an empty document's only paragraph should carry the hint", async () => {
        const view = await makeEditor("");

        expect(decorated(view)).toEqual([[0, 2], [1, 1]]);
    });

    it("the paragraph decoration should carry the positioning class", async () => {
        const view = await makeEditor("");
        const [deco] = emptyLineHintDecorations(view.state).find();
        const attrs = (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs;

        expect(attrs.class).toBe("md-empty-hint");
    });

    it("the widget's side should be negative so it sorts before the caret", async () => {
        const view = await makeEditor("");
        const [, widget] = emptyLineHintDecorations(view.state).find();
        const side = (widget as unknown as { type: { side: number } }).type.side;

        // Not cosmetic. The block-handle gutter occupies this same position and
        // is also contenteditable=false, so a positive side puts the caret's DOM
        // position between two uneditable widgets — which WebKit will not hold,
        // re-anchoring to the previous block so the next character typed lands
        // on the previous line. e2e/enterCaret drives the gesture; this pins the
        // value, because the e2e suite only runs by hand.
        expect(side).toBeLessThan(0);
    });

    it("the widget should render the key as an inline code element", async () => {
        const dom = emptyLineHintDom();

        expect(dom.textContent).toBe("press / to show commands");
        expect(dom.contentEditable).toBe("false");
        const code = dom.querySelector("code");
        expect(code?.textContent).toBe("/");
    });

    it("typing any character into the empty paragraph should remove the hint", async () => {
        const view = await makeEditor("first");
        addEmptyParagraphAt(view, view.state.doc.content.size);
        type(view, "a");

        expect(decorated(view)).toEqual([]);
    });

    it("typing the slash that opens the menu should remove the hint", async () => {
        const view = await makeEditor("first");
        addEmptyParagraphAt(view, view.state.doc.content.size);
        type(view, "/");

        expect(decorated(view)).toEqual([]);
    });

    it("a caret in a paragraph with text should not decorate anything", async () => {
        const view = await makeEditor("first");
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));

        expect(decorated(view)).toEqual([]);
    });

    it("an empty paragraph the caret is not in should not be decorated", async () => {
        const view = await makeEditor("first");
        addEmptyParagraphAt(view, view.state.doc.content.size);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));

        expect(decorated(view)).toEqual([]);
    });

    it("an empty paragraph nested in a list item should not be decorated", async () => {
        const view = await makeEditor("- item");
        // Inside the item, after its existing paragraph: depth 3 (doc > list >
        // item > paragraph), which the top-level-only rule declines.
        const item = view.state.doc.child(0).child(0);
        const itemStart = 2;
        addEmptyParagraphAt(view, itemStart + item.content.size);

        expect(view.state.selection.$from.depth).toBeGreaterThan(1);
        expect(decorated(view)).toEqual([]);
    });

    it("an empty top-level block that is not a paragraph should not be decorated", async () => {
        const view = await makeEditor("first");
        const heading = view.state.schema.nodes.heading!;
        const pos = view.state.doc.content.size;
        const tr = view.state.tr.insert(pos, heading.create({ level: 2 }));
        tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        view.dispatch(tr);

        expect(view.state.selection.$from.parent.type.name).toBe("heading");
        expect(decorated(view)).toEqual([]);
    });

    it("a node selection on an empty paragraph should not be decorated", async () => {
        const view = await makeEditor("first");
        const pos = addEmptyParagraphAt(view, view.state.doc.content.size);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));

        expect(decorated(view)).toEqual([]);
    });
});
