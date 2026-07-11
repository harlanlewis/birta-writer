/**
 * Tests for the block keyboard model (MAR-22 move keys / MAR-82 keyboard
 * remainder): Escape's caret↔block toggle, Shift+arrow block-wise
 * extend/shrink (and its never-steal-text-selection gate), and Alt/Cmd+Shift
 * arrow moves through the shared moveBlockTo machinery.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { undo } from "@milkdown/prose/history";
import {
    isBlockSpanning,
    toggleBlockSelection,
    extendBlockSelection,
    moveSelectedBlocks,
} from "../plugins/blockKeys";

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
        .use(headingFoldPlugin)
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

/** Caret inside the block whose text is `text`. */
function placeCaretIn(view: EditorView, text: string): void {
    let inside = -1;
    view.state.doc.forEach((node, offset) => {
        if (node.textContent === text) inside = offset + 1;
    });
    expect(inside).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(inside))));
}

function selectedText(view: EditorView): string {
    const sel = view.state.selection;
    return view.state.doc.textBetween(sel.from, sel.to, " ");
}

function blockOrder(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

describe("toggleBlockSelection (Escape)", () => {
    it("a caret should expand to a selection spanning its whole block", async () => {
        const view = await makeEditor("Alpha\n\nBeta gamma\n\nDelta");
        placeCaretIn(view, "Beta gamma");
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Beta gamma");
        expect(isBlockSpanning(view.state)).toBe(true);
    });

    it("a block-spanning selection should collapse back to a caret", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(true);
        expect(view.state.selection.empty).toBe(true);
    });

    it("a partial text selection should return false (Escape keeps its meaning)", async () => {
        const view = await makeEditor("Alpha beta gamma");
        const from = 2;
        const to = 6;
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, from, to),
        ));
        expect(isBlockSpanning(view.state)).toBe(false);
        expect(toggleBlockSelection(view.state, view.dispatch)).toBe(false);
    });
});

describe("extendBlockSelection (Shift+arrows)", () => {
    it("a plain text selection should return false — native selection untouched", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 2, 4),
        ));
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(false);
        expect(extendBlockSelection(-1)(view.state, view.dispatch)).toBe(false);
    });

    it("Shift+Down on a block selection should add the next block", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Alpha Beta");
        expect(isBlockSpanning(view.state)).toBe(true);
    });

    it("Shift+Up on a downward-grown selection should shrink it from the bottom", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(extendBlockSelection(-1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Alpha");
    });

    it("Shift+Up at the first block should grow upward when possible", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(extendBlockSelection(-1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Alpha Beta");
    });

    it("Shift+Down at the last block should consume the key without change", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Beta");
        toggleBlockSelection(view.state, view.dispatch);
        expect(extendBlockSelection(1)(view.state, view.dispatch)).toBe(true);
        expect(selectedText(view)).toBe("Beta");
    });
});

describe("moveSelectedBlocks (Alt+arrows / Cmd+Shift+arrows)", () => {
    it("a caret block should move down past its neighbor", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Beta", "Alpha", "Gamma"]);
    });

    it("a multi-block selection should move as one run and stay selected", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma\n\nDelta");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Gamma", "Alpha", "Beta", "Delta"]);
        expect(selectedText(view)).toBe("Alpha Beta");
        expect(isBlockSpanning(view.state)).toBe(true);
    });

    it("a multi-block selection at the top should consume Alt+Up without change", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        placeCaretIn(view, "Alpha");
        toggleBlockSelection(view.state, view.dispatch);
        extendBlockSelection(1)(view.state, view.dispatch);
        expect(moveSelectedBlocks(-1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("a heading caret should carry its section when moving", async () => {
        const view = await makeEditor("Intro\n\n## One\n\nBody one\n\n## Two\n\nBody two");
        placeCaretIn(view, "One");
        expect(moveSelectedBlocks(1)(view.state, view.dispatch, view)).toBe(true);
        expect(blockOrder(view)).toEqual(["Intro", "Two", "Body two", "One", "Body one"]);
    });

    it("moving down then undo should restore the original order", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        placeCaretIn(view, "Alpha");
        moveSelectedBlocks(1)(view.state, view.dispatch, view);
        expect(blockOrder(view)).toEqual(["Beta", "Alpha"]);
        undo(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta"]);
    });
});
