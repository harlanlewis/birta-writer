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
import { TextSelection } from "../pm";
import { undo } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
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
        .use(gfmFidelity)
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

    it("a caret inside a code block should insert an empty paragraph before it (the preset owns only Mod-Enter there)", async () => {
        // The preset's Mod-Enter (exit code) owns the "after" direction, but
        // it binds nothing on Mod-Shift-Enter — so "before" must act rather
        // than be a swallowed dead key. It inserts before the code block,
        // which stays intact.
        const view = await makeEditor("```js\nconst x = 1;\n```");
        placeCaretIn(view, "const x = 1;", 3);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(view.state.doc.child(0).type.name).toBe("paragraph");
        expect(view.state.doc.child(0).textContent).toBe("");
        expect(view.state.doc.child(1).type.name).toBe("code_block");
        expect(view.state.doc.child(1).textContent).toBe("const x = 1;"); // intact
        expectCaretInEmptyParagraph(view);
    });

    it("a caret inside a table cell should insert an empty paragraph before the table", async () => {
        const view = await makeEditor("| a | b |\n| --- | --- |\n| c | d |");
        placeCaretIn(view, "d");

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(view.state.doc.child(0).type.name).toBe("paragraph");
        expect(view.state.doc.child(0).textContent).toBe("");
        expect(view.state.doc.child(1).type.name).toBe("table"); // intact
        expectCaretInEmptyParagraph(view);
    });

    it("a caret in a code block nested in a blockquote should insert inside the blockquote, before the code block", async () => {
        const view = await makeEditor("> intro\n>\n> ```js\n> code1\n> ```");
        placeCaretIn(view, "code1", 2);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(view.state.doc.childCount).toBe(1); // nothing escaped to top level
        const quote = view.state.doc.child(0);
        expect(quote.type.name).toBe("blockquote");
        expect(quote.child(0).textContent).toBe("intro");
        expect(quote.child(1).type.name).toBe("paragraph");
        expect(quote.child(1).textContent).toBe("");
        expect(quote.child(2).type.name).toBe("code_block");
        expect(quote.child(2).textContent).toBe("code1"); // intact
        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        expect($from.node($from.depth - 1).type.name).toBe("blockquote");
    });

    it("a caret in a code block nested in a list item should insert inside that item, before the code block", async () => {
        const view = await makeEditor("- item text\n\n  ```js\n  code2\n  ```\n- second");
        placeCaretIn(view, "code2", 2);

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        const list = view.state.doc.child(0);
        expect(list.childCount).toBe(2); // still two items
        const item = list.child(0);
        expect(item.child(0).textContent).toBe("item text");
        expect(item.child(1).type.name).toBe("paragraph");
        expect(item.child(1).textContent).toBe("");
        expect(item.child(2).type.name).toBe("code_block");
        expect(item.child(2).textContent).toBe("code2"); // intact
        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        expect($from.node($from.depth - 1).type.name).toBe("list_item");
    });

    it("a caret in a table nested in a callout should insert inside the callout, before the table", async () => {
        const view = await makeEditor("> [!NOTE]\n> | a | b |\n> | --- | --- |\n> | c | d |");
        placeCaretIn(view, "d");

        expect(insertParagraphBefore(view.state, view.dispatch)).toBe(true);

        expect(view.state.doc.childCount).toBe(1); // nothing escaped to top level
        const callout = view.state.doc.child(0);
        expect(callout.type.name).toBe("callout");
        let tableIndex = -1;
        callout.forEach((node, _offset, i) => {
            if (node.type.name === "table") { tableIndex = i; }
        });
        expect(tableIndex).toBeGreaterThan(0);
        expect(callout.child(tableIndex - 1).type.name).toBe("paragraph");
        expect(callout.child(tableIndex - 1).content.size).toBe(0);
        expectCaretInEmptyParagraph(view);
        const $from = view.state.selection.$from;
        expect($from.node($from.depth - 1).type.name).toBe("callout");
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
