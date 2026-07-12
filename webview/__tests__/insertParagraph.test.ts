/**
 * Tests for Insert Paragraph After/Before (MAR-99, plugins/insertParagraph.ts):
 * Mod-Enter / Mod-Shift-Enter insert an EMPTY sibling paragraph around the
 * caret's block (never splitting it), stay inside containers (list item /
 * callout / blockquote), fall through (false) inside code blocks and tables
 * so the preset's exit behavior keeps working, and honor block-range
 * selections. Drives the REAL Milkdown editor with the production
 * serialization config (the blockKeys.test.ts harness).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import { undo } from "@milkdown/prose/history";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { historyPlugin } from "../plugins/history";
import { insertParagraphAfter, insertParagraphBefore } from "../plugins/insertParagraph";
import { BlockRangeSelection } from "../plugins/blockRange";

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
        .use(gfm)
        .use(historyPlugin)
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

/** Caret inside the textblock whose text is `text`, `offset` chars in. */
function placeCaretIn(view: EditorView, text: string, offset = 0): void {
    let start = -1;
    view.state.doc.descendants((node, pos) => {
        if (start === -1 && node.isTextblock && node.textContent === text) {
            start = pos + 1;
            return false;
        }
        return true;
    });
    expect(start).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, start + offset),
    ));
}

/** Top-level block texts, in order. */
function blockTexts(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

/** [from, to) of the top-level block whose text is `text`. */
function blockBounds(view: EditorView, text: string): { from: number; to: number } {
    let found: { from: number; to: number } | null = null;
    view.state.doc.forEach((node, offset) => {
        if (!found && node.textContent === text) {
            found = { from: offset, to: offset + node.nodeSize };
        }
    });
    expect(found).not.toBeNull();
    return found!;
}

/** The caret must sit inside an empty paragraph. */
function expectCaretInEmptyParagraph(view: EditorView): void {
    const sel = view.state.selection;
    expect(sel.empty).toBe(true);
    expect(sel.$from.parent.type.name).toBe("paragraph");
    expect(sel.$from.parent.content.size).toBe(0);
}

describe("insertParagraphAfter (Mod-Enter)", () => {
    it("a mid-paragraph caret should insert an empty paragraph after without splitting", async () => {
        const view = await makeEditor("Alpha\n\nBeta gamma\n\nDelta");
        placeCaretIn(view, "Beta gamma", 4); // between "Beta" and " gamma"

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        expect(blockTexts(view)).toEqual(["Alpha", "Beta gamma", "", "Delta"]);
        expectCaretInEmptyParagraph(view);
        expect(view.state.selection.$from.index(0)).toBe(2);
    });

    it("a caret in the last block should append an empty paragraph at the doc end", async () => {
        const view = await makeEditor("Alpha\n\nOmega");
        placeCaretIn(view, "Omega", 2);

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        expect(blockTexts(view)).toEqual(["Alpha", "Omega", ""]);
        expectCaretInEmptyParagraph(view);
    });

    it("a caret in a heading should insert a plain paragraph, not another heading", async () => {
        const view = await makeEditor("# Title\n\nBody");
        placeCaretIn(view, "Title", 3);

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        const second = view.state.doc.child(1);
        expect(second.type.name).toBe("paragraph");
        expect(second.textContent).toBe("");
        expect(view.state.doc.child(0).type.name).toBe("heading");
        expect(view.state.doc.child(0).textContent).toBe("Title"); // unsplit
        expectCaretInEmptyParagraph(view);
    });

    it("a caret inside a list item should insert the paragraph inside that item", async () => {
        const view = await makeEditor("- one\n- two");
        placeCaretIn(view, "one", 1);

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        const item = $from.node($from.depth - 1);
        expect(item.type.name).toBe("list_item");
        expect(item.childCount).toBe(2); // "one" + the new empty paragraph
        expect(item.child(0).textContent).toBe("one");
        expect($from.node(1).childCount).toBe(2); // list still has two items
    });

    it("a caret inside a callout should insert the paragraph inside the callout", async () => {
        const view = await makeEditor("> [!NOTE]\n> Body\n\nAfter");
        placeCaretIn(view, "Body", 2);

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        expect($from.node($from.depth - 1).type.name).toBe("callout");
        expect(view.state.doc.childCount).toBe(2); // callout + "After", nothing lifted out
    });

    it("a caret inside a blockquote should insert the paragraph inside the blockquote", async () => {
        const view = await makeEditor("> Quote\n\nAfter");
        placeCaretIn(view, "Quote", 2);

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        expect($from.node($from.depth - 1).type.name).toBe("blockquote");
        expect(view.state.doc.childCount).toBe(2);
    });

    it("a caret inside a code block should return false and leave the doc unchanged", async () => {
        const view = await makeEditor("```js\nconst x = 1;\n```");
        placeCaretIn(view, "const x = 1;", 3);
        const before = view.state.doc;

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(false);

        expect(view.state.doc.eq(before)).toBe(true);
    });

    it("a caret inside a table cell should return false and leave the doc unchanged", async () => {
        const view = await makeEditor("| a | b |\n| --- | --- |\n| c | d |");
        placeCaretIn(view, "c");
        const before = view.state.doc;

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(false);

        expect(view.state.doc.eq(before)).toBe(true);
    });

    it("a block-range selection should insert after the last selected block", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const range = BlockRangeSelection.tryCreate(
            view.state.doc,
            blockBounds(view, "Alpha").from,
            blockBounds(view, "Beta").to,
        );
        expect(range).not.toBeNull();
        view.dispatch(view.state.tr.setSelection(range!));

        expect(insertParagraphAfter(view.state, view.dispatch)).toBe(true);

        expect(blockTexts(view)).toEqual(["Alpha", "Beta", "", "Gamma"]);
        expectCaretInEmptyParagraph(view);
        expect(view.state.selection.$from.index(0)).toBe(2);
    });

    it("the insert should undo in a single step", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha", 2);
        const original = view.state.doc;

        insertParagraphAfter(view.state, view.dispatch);
        expect(blockTexts(view)).toEqual(["Alpha", "", "Beta"]);
        expect(undo(view.state, view.dispatch)).toBe(true);

        expect(view.state.doc.eq(original)).toBe(true);
    });
});

describe("insertParagraphBefore (Mod-Shift-Enter)", () => {
    it("a mid-paragraph caret should insert an empty paragraph before without splitting", async () => {
        const view = await makeEditor("Alpha\n\nBeta gamma\n\nDelta");
        placeCaretIn(view, "Beta gamma", 4);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(blockTexts(view)).toEqual(["Alpha", "", "Beta gamma", "Delta"]);
        expectCaretInEmptyParagraph(view);
        expect(view.state.selection.$from.index(0)).toBe(1);
    });

    it("a caret in the first block should insert an empty paragraph at the doc start", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha", 2);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(blockTexts(view)).toEqual(["", "Alpha", "Beta"]);
        expectCaretInEmptyParagraph(view);
        expect(view.state.selection.$from.index(0)).toBe(0);
    });

    it("a caret in a heading should insert a plain paragraph before, not a heading", async () => {
        const view = await makeEditor("# Title\n\nBody");
        placeCaretIn(view, "Title", 3);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(view.state.doc.child(0).type.name).toBe("paragraph");
        expect(view.state.doc.child(0).textContent).toBe("");
        expect(view.state.doc.child(1).type.name).toBe("heading");
        expect(view.state.doc.child(1).textContent).toBe("Title"); // unsplit
    });

    it("a caret inside a list item should insert the paragraph inside that item, before the caret's paragraph", async () => {
        const view = await makeEditor("- one\n- two");
        placeCaretIn(view, "two", 1);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        const item = $from.node($from.depth - 1);
        expect(item.type.name).toBe("list_item");
        expect(item.childCount).toBe(2);
        expect(item.child(0).textContent).toBe(""); // new paragraph first
        expect(item.child(1).textContent).toBe("two");
        expect($from.node(1).childCount).toBe(2); // list still has two items
    });

    it("a caret inside a code block should return false and leave the doc unchanged", async () => {
        const view = await makeEditor("```js\nconst x = 1;\n```");
        placeCaretIn(view, "const x = 1;", 3);
        const before = view.state.doc;

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(false);

        expect(view.state.doc.eq(before)).toBe(true);
    });

    it("a caret inside a table cell should return false and leave the doc unchanged", async () => {
        const view = await makeEditor("| a | b |\n| --- | --- |\n| c | d |");
        placeCaretIn(view, "d");
        const before = view.state.doc;

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(false);

        expect(view.state.doc.eq(before)).toBe(true);
    });

    it("a block-range selection should insert before the first selected block", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const range = BlockRangeSelection.tryCreate(
            view.state.doc,
            blockBounds(view, "Beta").from,
            blockBounds(view, "Gamma").to,
        );
        expect(range).not.toBeNull();
        view.dispatch(view.state.tr.setSelection(range!));

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(blockTexts(view)).toEqual(["Alpha", "", "Beta", "Gamma"]);
        expectCaretInEmptyParagraph(view);
        expect(view.state.selection.$from.index(0)).toBe(1);
    });
});
