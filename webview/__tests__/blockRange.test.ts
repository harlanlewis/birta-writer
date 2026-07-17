/**
 * Tests for BlockRangeSelection (MAR-82): boundary snapping, leaf-block
 * participation, direction preservation, mapping through edits, history
 * bookmarks, JSON round-trip, and the replace/delete semantics typing over
 * a block range relies on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection, TextSelection } from "../pm";
import { deleteSelection } from "../pm";
import { undo } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { BlockRangeSelection, BlockRangeBookmark } from "../plugins/blockRange";

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

/** [start, end) of the top-level block whose text is `text`. */
function blockBounds(view: EditorView, text: string): { from: number; to: number } {
    let found: { from: number; to: number } | null = null;
    view.state.doc.forEach((node, offset) => {
        if (node.textContent === text) found = { from: offset, to: offset + node.nodeSize };
    });
    expect(found).not.toBeNull();
    return found!;
}

function blockOrder(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.forEach((node) => {
        texts.push(node.textContent);
    });
    return texts;
}

describe("BlockRangeSelection.tryCreate", () => {
    it("mid-text positions should snap outward to whole block boundaries", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const alpha = blockBounds(view, "Alpha");
        const beta = blockBounds(view, "Beta");
        const sel = BlockRangeSelection.tryCreate(view.state.doc, alpha.from + 2, beta.to - 2);
        expect(sel).not.toBeNull();
        expect(sel!.from).toBe(alpha.from);
        expect(sel!.to).toBe(beta.to);
    });

    it("a backward pair should keep its anchor at the bottom", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const alpha = blockBounds(view, "Alpha");
        const beta = blockBounds(view, "Beta");
        const sel = BlockRangeSelection.tryCreate(view.state.doc, beta.to - 1, alpha.from + 1)!;
        expect(sel.head).toBeLessThan(sel.anchor);
        expect(sel.from).toBe(alpha.from);
        expect(sel.to).toBe(beta.to);
    });

    it("equal boundary positions (no block) should return null", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const beta = blockBounds(view, "Beta");
        expect(BlockRangeSelection.tryCreate(view.state.doc, beta.from, beta.from)).toBeNull();
    });

    it("a leaf-only range (an HR) should be a real selection", async () => {
        const view = await makeEditor("alpha\n\n---\n\nomega");
        let hr: { from: number; to: number } | null = null;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hr = { from: offset, to: offset + node.nodeSize };
        });
        const sel = BlockRangeSelection.tryCreate(view.state.doc, hr!.from, hr!.to)!;
        expect(sel).not.toBeNull();
        expect(sel.from).toBe(hr!.from);
        expect(sel.to).toBe(hr!.to);
    });

    it("content() should be a closed slice (whole blocks, no open ends)", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const sel = BlockRangeSelection.tryCreate(view.state.doc, 0, view.state.doc.content.size)!;
        const slice = sel.content();
        expect(slice.openStart).toBe(0);
        expect(slice.openEnd).toBe(0);
        expect(slice.content.childCount).toBe(2);
    });
});

describe("mapping and persistence", () => {
    it("an insertion above should shift the range, not break it", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const beta = blockBounds(view, "Beta");
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, beta.from, beta.to)!,
        ));
        // Insert text into Alpha (before the range).
        view.dispatch(view.state.tr.insertText("XX", 2));
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(view.state.doc.textBetween(sel.from, sel.to, " ")).toBe("Beta");
    });

    it("JSON round-trip should reproduce the selection", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const sel = BlockRangeSelection.tryCreate(view.state.doc, 0, view.state.doc.content.size)!;
        const revived = Selection.fromJSON(view.state.doc, JSON.parse(JSON.stringify(sel.toJSON())));
        expect(revived).toBeInstanceOf(BlockRangeSelection);
        expect(revived.eq(sel)).toBe(true);
    });

    it("the bookmark should survive mapping and resolve to a block range", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        const beta = blockBounds(view, "Beta");
        const sel = BlockRangeSelection.tryCreate(view.state.doc, beta.from, beta.to)!;
        const bookmark = sel.getBookmark();
        expect(bookmark).toBeInstanceOf(BlockRangeBookmark);
        const tr = view.state.tr.insertText("XX", 2);
        const resolved = bookmark.map(tr.mapping).resolve(tr.doc);
        expect(resolved).toBeInstanceOf(BlockRangeSelection);
        expect(tr.doc.textBetween(resolved.from, resolved.to, " ")).toBe("Beta");
    });
});

describe("editing over a block range", () => {
    it("deleteSelection should remove the blocks, leaf included", async () => {
        const view = await makeEditor("alpha\n\n---\n\nomega");
        const alpha = blockBounds(view, "alpha");
        let hrEnd = -1;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "hr") hrEnd = offset + node.nodeSize;
        });
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, alpha.from, hrEnd)!,
        ));
        deleteSelection(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["omega"]);
    });

    it("typing over a block range should replace the blocks with the text", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const alpha = blockBounds(view, "Alpha");
        const beta = blockBounds(view, "Beta");
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, alpha.from, beta.to)!,
        ));
        view.dispatch(view.state.tr.insertText("typed"));
        expect(blockOrder(view)).toEqual(["typed", "Gamma"]);
        expect(view.state.selection.empty).toBe(true);
    });

    it("undoing a block-range delete should restore blocks AND the range", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const alpha = blockBounds(view, "Alpha");
        const beta = blockBounds(view, "Beta");
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, alpha.from, beta.to)!,
        ));
        deleteSelection(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["Gamma"]);
        undo(view.state, view.dispatch);
        expect(blockOrder(view)).toEqual(["Alpha", "Beta", "Gamma"]);
        const sel = view.state.selection;
        expect(sel).toBeInstanceOf(BlockRangeSelection);
        expect(view.state.doc.textBetween(sel.from, sel.to, " ")).toBe("Alpha Beta");
    });

    it("deleting every block should leave a valid empty document", async () => {
        const view = await makeEditor("Alpha\n\nBeta");
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, 0, view.state.doc.content.size)!,
        ));
        deleteSelection(view.state, view.dispatch);
        expect(view.state.doc.childCount).toBeGreaterThanOrEqual(1);
        expect(view.state.doc.textContent).toBe("");
    });

    it("degrades to a caret when its blocks are deleted by another edit", async () => {
        const view = await makeEditor("Alpha\n\nBeta\n\nGamma");
        const beta = blockBounds(view, "Beta");
        view.dispatch(view.state.tr.setSelection(
            BlockRangeSelection.tryCreate(view.state.doc, beta.from, beta.to)!,
        ));
        // An external-style edit deletes Beta out from under the range.
        view.dispatch(view.state.tr.deleteRange(beta.from, beta.to));
        const sel = view.state.selection;
        // The mapped-through selection must still be valid for this doc.
        expect(sel.from).toBeLessThanOrEqual(view.state.doc.content.size);
        expect(() => view.state.tr.setSelection(sel)).not.toThrow();
    });
});

describe("TextSelection is untouched", () => {
    it("a plain text selection should not become a block range", async () => {
        const view = await makeEditor("Alpha beta");
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 5)));
        expect(view.state.selection).toBeInstanceOf(TextSelection);
        expect(view.state.selection).not.toBeInstanceOf(BlockRangeSelection);
    });
});
